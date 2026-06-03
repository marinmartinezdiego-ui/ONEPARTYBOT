// API endpoint que recibe los webhooks de Wassenger
// Encola el mensaje y dispara el worker (con bypass de Deployment Protection)

import crypto from 'node:crypto';
import { pushMessage, isMessageSeen, markMessageSeen, wasBotSent, wasBotSentMedia, wasBotSentMessageId } from '../lib/upstash.js';
import { isIgnoredPhone, getConversation, log, updateConversation, crearReservaConfirmada } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Kill switch global: si BOT_PAUSED=true en Vercel, ignoramos todo
  // (responder 200 evita que Wassenger reintente y deshabilite el webhook).
  if (process.env.BOT_PAUSED === 'true') {
    return res.status(200).json({ ok: true, paused: true });
  }

  // Verificación de firma (si el secret está configurado).
  // Si no hay WASSENGER_WEBHOOK_SECRET en env, se omite (compat hacia atrás).
  if (!verifyWassengerSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Responder rápido para que Wassenger no reintente.
  // El procesamiento de fondo se hace después (fire-and-forget al worker).
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('Error en webhook:', err);
  }

  return res.status(200).json({ ok: true });
}

function verifyWassengerSignature(req) {
  const secret = process.env.WASSENGER_WEBHOOK_SECRET;
  if (!secret) return true; // No configurado → no validar (modo compat)

  const sig = req.headers['x-wassenger-signature']
           || req.headers['x-signature']
           || req.headers['signature'];
  if (!sig) return false;

  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');

  return sig === expected || sig === `sha256=${expected}`;
}

async function processWebhook(body) {
  if (!body) return;

  // Mensaje saliente del operador (web, móvil, dashboard) → pausar la conversación
  if (body.event === 'message:out:new') {
    await handleOutgoingMessage(body);
    return;
  }

  // A partir de aquí, solo procesamos mensajes entrantes nuevos
  if (body.event !== 'message:in:new') return;

  const msg = body.data;
  const device = body.device;
  if (!msg) return;

  // Defensivo: algunos webhooks marcan fromMe en message:in:new (raro pero pasa)
  if (msg.fromMe === true) {
    const rawTo = msg.to || msg.chatId || '';
    const targetPhone = rawTo.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
    if (targetPhone && !targetPhone.includes('g.us')) {
      const text = (msg.body || msg.text || '').trim();
      if (text && await wasBotSent(targetPhone, text)) {
        await log(targetPhone, 'self_outgoing_ignored', {});
        return;
      }
      const isMedia2 = msg.type && msg.type !== 'chat' && msg.type !== 'text';
      if ((isMedia2 || !text) && await wasBotSentMedia(targetPhone)) {
        await log(targetPhone, 'self_media_ignored', { msgType: msg.type || 'no-text' });
        return;
      }
      // Comando de reactivación: la palabra "compañero" en el texto
      const normalizedFromMe = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      if (/\bcompanero(s)?\b/.test(normalizedFromMe)) {
        await updateConversation(targetPhone, { paused_until: null }).catch(() => {});
        await log(targetPhone, 'manual_reactivate', { trigger: text.slice(0, 80) });
        return;
      }
      // Pausa de 2 horas (o conserva si ya hay más larga) + guarda en historial
      const convoFromMe = await getConversation(targetPhone);
      convoFromMe.messages = convoFromMe.messages || [];
      convoFromMe.messages.push({ role: 'assistant', content: text });
      if (convoFromMe.messages.length > 50) convoFromMe.messages = convoFromMe.messages.slice(-50);
      const currentPauseMs2 = convoFromMe.paused_until ? new Date(convoFromMe.paused_until).getTime() : 0;
      const newPause2hMs2 = Date.now() + 2 * 60 * 60 * 1000;
      const pausedUntil = new Date(Math.max(currentPauseMs2, newPause2hMs2)).toISOString();
      await updateConversation(targetPhone, {
        paused_until: pausedUntil,
        messages: convoFromMe.messages
      }).catch(() => {});
      await log(targetPhone, 'manual_pause_2h', { preview: text.slice(0, 80), until: pausedUntil });
    }
    return;
  }

  const rawFrom = msg.from || msg.chatId || '';
  if (rawFrom.includes('@g.us')) return;

  const phone = rawFrom.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
  if (!phone) return;

  const deviceId = (device && device.id) || msg.deviceId;

  // COMANDOS DE ADMINISTRADOR — Diego escribe al bot desde su propio número
  // (el NOTIFICATION_PHONE). Procesamos comandos tipo `confirmar 34xxx` y
  // devolvemos respuesta sin meter en el flujo normal de clientes.
  const NOTIFICATION_PHONE = process.env.NOTIFICATION_PHONE || '34620067712';
  if (phone === NOTIFICATION_PHONE) {
    const adminText = (msg.body || msg.text || '').trim();
    if (adminText) {
      const handled = await handleAdminCommand(adminText, deviceId);
      if (handled) {
        if (msg.id) await markMessageSeen(msg.id);
        return;
      }
    }
    // Si no es un comando reconocido, simplemente lo ignoramos (no entra al
    // flujo de cliente normal — Diego nunca debe ser tratado como cliente).
    if (msg.id) await markMessageSeen(msg.id);
    return;
  }

  if (msg.id && await isMessageSeen(msg.id)) {
    await log(phone, 'duplicate_ignored', { msgId: msg.id });
    return;
  }
  if (msg.id) await markMessageSeen(msg.id);

  const msgType = msg.type || 'chat';

  // Si llega media (imagen, vídeo, documento, etc.), NO la ignoramos como antes.
  // El bot no puede "ver" el archivo, pero sí debe SABER que el cliente envió
  // algo, porque normalmente es el formulario completado, un comprobante de
  // pago, o una foto que necesita revisión humana. Convertimos el mensaje en
  // un texto sintético para que entre al flujo normal y el bot responda algo
  // como "perfecto, lo revisa mi compañero" y llame a avisar_humano. Antes el
  // bot decía "no veo nada, mándamelo otra vez" porque ignorábamos el evento.
  let syntheticMediaText = null;
  if (['image', 'video', 'sticker', 'document', 'vcard', 'contact', 'location'].includes(msgType)) {
    await log(phone, 'media_received_as_text', { type: msgType });
    const labels = {
      image: 'IMAGEN',
      video: 'VÍDEO',
      sticker: 'STICKER',
      document: 'DOCUMENTO',
      vcard: 'CONTACTO',
      contact: 'CONTACTO',
      location: 'UBICACIÓN'
    };
    const caption = (msg.body || msg.caption || '').trim();
    const captionPart = caption ? ` Texto que acompaña al archivo: "${caption}".` : '';
    syntheticMediaText = `[ARCHIVO RECIBIDO DEL CLIENTE — tipo: ${labels[msgType] || msgType.toUpperCase()}. NO puedes verlo. Normalmente es el FORMULARIO completado, un comprobante de pago, o una foto que necesita revisión humana.${captionPart}]`;
  }

  if (['audio', 'ptt', 'voice'].includes(msgType)) {
    const convo = await getConversation(phone);

    // Filtros: no respondemos a audios si la conversación no está activada,
    // está cerrada, pausada (manual o avisar_humano), o el número está ignorado.
    if (convo.closed) {
      await log(phone, 'audio_closed_ignored', {}); return;
    }
    if (!convo.activated) {
      await log(phone, 'audio_unactivated_ignored', {}); return;
    }
    if (convo.paused_until && new Date(convo.paused_until) > new Date()) {
      await log(phone, 'audio_paused_ignored', {}); return;
    }
    if (await isIgnoredPhone(phone)) {
      await log(phone, 'audio_ignored_phone', {}); return;
    }
    if (convo.audio_replied_at && (Date.now() - new Date(convo.audio_replied_at).getTime() < 30000)) return;

    const replies = [
      'Lo siento, no puedo escuchar audios 😅 Escríbeme y te ayudo enseguida 🙌',
      'No puedo escuchar audios desde aquí 🙈 ¿Me lo escribes?',
      'Audios no, pero por escrito sí te leo 📝 ¿Qué necesitas?',
      'No me llegan los audios 😬 Mándamelo escrito y lo vemos',
      'Ahora mismo no puedo escuchar audios 🎧 Escríbemelo y te respondo'
    ];
    const reply = replies[Math.floor(Math.random() * replies.length)];

    // Importar dinámicamente para no bloquear cargas en otros paths
    const { sendText } = await import('../lib/wassenger.js');
    await sendText(phone, reply, deviceId);
    await updateConversation(phone, { audio_replied_at: new Date().toISOString() });
    await log(phone, 'audio_replied', {});
    return;
  }

  const text = syntheticMediaText || msg.body || msg.text || '';
  if (!text) return;

  const convo = await getConversation(phone);

  if (convo.closed) { await log(phone, 'closed_ignored', {}); return; }
  if (convo.paused_until && new Date(convo.paused_until) > new Date()) {
    // Aunque esté pausado, GUARDAMOS el mensaje en el historial para que
    // el bot tenga contexto cuando se reactive con "compañero".
    convo.messages = convo.messages || [];
    convo.messages.push({ role: 'user', content: text });
    if (convo.messages.length > 50) convo.messages = convo.messages.slice(-50);
    await updateConversation(phone, { messages: convo.messages }).catch(() => {});
    await log(phone, 'paused_ignored_saved', { preview: text.substring(0, 80) });
    return;
  }
  if (await isIgnoredPhone(phone)) { await log(phone, 'old_chat_ignored', {}); return; }
  if (!convo.activated && convo.messages && convo.messages.length > 0) {
    await log(phone, 'preexisting_ignored', {}); return;
  }
  if (!convo.activated && !isActivationMessage(text)) {
    await log(phone, 'not_activated', { text: text.substring(0, 50) }); return;
  }

  const queueMsg = {
    id: msg.id || `${Date.now()}-${Math.random()}`,
    text, type: msgType, timestamp: Date.now(), deviceId
  };

  await pushMessage(phone, queueMsg);
  await log(phone, 'queued', { msgId: queueMsg.id });

  // Disparamos el worker. El worker está hecho para responder 200 al
  // instante y procesar en background, así que este await es rápido (<500ms
  // normalmente) y nos asegura que el fetch sale antes de que Vercel cierre
  // la función webhook.
  try {
    await triggerWorker(phone, deviceId);
  } catch (err) {
    console.error('Worker trigger failed:', err.message);
  }
}

async function handleOutgoingMessage(body) {
  const msg = body.data;
  if (!msg) return;

  const rawTo = msg.to || msg.chatId || '';
  const targetPhone = rawTo.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
  if (!targetPhone || targetPhone.includes('g.us')) return;

  const text = (msg.body || msg.text || '').trim();

  // PRIMER CHECK: por message ID de Wassenger (más fiable que el hash del texto).
  // Cuando el bot envía un mensaje, capturamos el ID que devuelve Wassenger.
  // Cuando Wassenger nos devuelve ese mismo mensaje como eco, el msg.id coincide.
  if (msg.id && await wasBotSentMessageId(msg.id)) {
    await log(targetPhone, 'bot_self_outgoing_ignored_by_id', { msgId: msg.id });
    return;
  }

  // SEGUNDO CHECK (fallback): por hash del texto, por si el ID no estaba disponible
  if (text && await wasBotSent(targetPhone, text)) {
    await log(targetPhone, 'bot_self_outgoing_ignored', {});
    return;
  }
  // ¿Es media (imagen/video/etc.) o no tiene texto? Si el bot acaba de mandar
  // media a este número, asumimos que es el reflejo de ese envío.
  const isMedia = msg.type && msg.type !== 'chat' && msg.type !== 'text';
  if ((isMedia || !text) && await wasBotSentMedia(targetPhone)) {
    await log(targetPhone, 'bot_media_outgoing_ignored', { msgType: msg.type || 'no-text' });
    return;
  }
  const sourceType = msg.sourceType || msg.source || msg.deliveredVia;
  if (sourceType === 'api') {
    await log(targetPhone, 'api_outgoing_ignored', { sourceType });
    return;
  }

  // COMANDO DE REACTIVACIÓN: si Diego escribe un mensaje que contiene la
  // palabra "compañero" (o "companero" sin tilde), limpia la pausa y deja al
  // bot volver a operar.
  const normalizedOut = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/\bcompanero(s)?\b/.test(normalizedOut)) {
    await updateConversation(targetPhone, {
      paused_until: null
    }).catch(() => {});
    await log(targetPhone, 'manual_reactivate', { trigger: text.slice(0, 80) });
    return;
  }

  // Cualquier otro mensaje saliente del operador (web, móvil, dashboard)
  // → pausa de 2 HORAS, o conserva la pausa actual si ya es más larga
  // (ej. una pausa indefinida puesta por avisar_humano no se debe acortar).
  // GUARDAMOS el mensaje del operador en el historial como assistant para que
  // el bot tenga contexto cuando se reactive.
  const convoOut = await getConversation(targetPhone);
  convoOut.messages = convoOut.messages || [];
  convoOut.messages.push({ role: 'assistant', content: text });
  if (convoOut.messages.length > 50) convoOut.messages = convoOut.messages.slice(-50);
  const currentPauseMs = convoOut.paused_until ? new Date(convoOut.paused_until).getTime() : 0;
  const newPause2hMs = Date.now() + 2 * 60 * 60 * 1000;
  const pausedUntil = new Date(Math.max(currentPauseMs, newPause2hMs)).toISOString();
  await updateConversation(targetPhone, {
    paused_until: pausedUntil,
    messages: convoOut.messages
  }).catch(() => {});
  await log(targetPhone, 'manual_pause_2h', {
    preview: text.slice(0, 80),
    sourceType: sourceType || 'unknown',
    until: pausedUntil
  });
}

function isActivationMessage(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Palabras muy específicas del servicio (despedidas) → activan solas.
  // Importante: NO incluimos "oneparty" / "one party" porque proveedores,
  // intermediarios y amigos los usan sin pedir servicio.
  const triggerStrong = ['despedida', 'soltero', 'soltera'];
  if (triggerStrong.some(w => normalized.includes(w))) return true;

  // Frases compuestas que indican intención clara de contratar.
  // Las palabras genéricas como "precio" o "información" SOLAS no activan;
  // tienen que ir combinadas con una palabra del servicio.
  const phrases = [
    'pack basic', 'pack mix', 'pack a full', 'pack premium',
    'organizar despedida', 'reservar despedida', 'reservar pack',
    'precio pack', 'precio despedida',
    'informacion pack', 'informacion para despedida', 'informacion despedida',
    'cuanto cuesta el pack', 'cuanto cuesta la despedida',
    'cuanto vale el pack', 'cuanto vale la despedida',
    'quiero organizar', 'estamos organizando una despedida'
  ];
  return phrases.some(p => normalized.includes(p));
}

async function triggerWorker(phone, deviceId) {
  const baseUrl = process.env.WORKER_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    || 'https://onepartybot.vercel.app';
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

  const workerUrl = bypassSecret
    ? `${baseUrl}/api/worker?x-vercel-protection-bypass=${bypassSecret}`
    : `${baseUrl}/api/worker`;

  // Timeout corto: el worker debe responder 200 al instante y procesar en background.
  // Si tarda >3s, ya no nos importa el resultado (el worker está en marcha).
  try {
    await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-token': process.env.INTERNAL_TOKEN || 'dev',
        'x-vercel-protection-bypass': bypassSecret || ''
      },
      body: JSON.stringify({ phone, deviceId }),
      signal: AbortSignal.timeout(3000)
    });
  } catch (e) {
    if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
      console.error('Worker trigger error:', e.message);
    }
  }
}

// ======================================================================
// COMANDOS DE ADMINISTRADOR (Diego escribiendo desde su WhatsApp personal)
// ======================================================================
// Comandos soportados:
//   - "confirmar 34xxxxxxxxx"  → marca la reserva del cliente como confirmada
//                                en la tabla `reservas`, leyendo alojamiento +
//                                fecha de su customer_data.
//   - "ayuda" o "help"         → lista de comandos
// ======================================================================
async function handleAdminCommand(text, deviceId) {
  const { sendText } = await import('../lib/wassenger.js');
  const NOTIFICATION_PHONE = process.env.NOTIFICATION_PHONE || '34620067712';

  const normalized = text.toLowerCase().trim();

  // --- AYUDA ----------------------------------------------------------
  if (/^(ayuda|help|\?)$/.test(normalized)) {
    await sendText(NOTIFICATION_PHONE,
      `🤖 *Comandos disponibles:*\n\n` +
      `• \`confirmar 34XXXXXXXXX\` — marca reserva del cliente como confirmada (bloquea fecha en chalet/villa)\n` +
      `• \`ayuda\` — esto`,
      deviceId
    );
    return true;
  }

  // --- CONFIRMAR RESERVA ----------------------------------------------
  const matchConfirmar = normalized.match(/^confirmar\s+(\+?\d{9,15})$/);
  if (matchConfirmar) {
    const clientePhone = matchConfirmar[1].replace(/^\+/, '');
    await log(clientePhone, 'admin_confirmar_reserva_solicitado', {});

    // Leer datos del cliente
    const convo = await getConversation(clientePhone);
    const cd = convo.customer_data || {};

    if (!cd.fecha || !cd.alojamiento) {
      await sendText(NOTIFICATION_PHONE,
        `❌ No puedo confirmar la reserva de ${clientePhone}: faltan datos en su ficha.\n` +
        `Fecha: ${cd.fecha || 'NO'}\nAlojamiento: ${cd.alojamiento || 'NO'}\n\n` +
        `Revísalo manualmente o pídeme que cree la reserva con datos concretos.`,
        deviceId
      );
      return true;
    }

    // Solo bloqueamos chalet/villa
    if (cd.alojamiento !== 'chalet_kent' && cd.alojamiento !== 'villa_bellreguard') {
      await sendText(NOTIFICATION_PHONE,
        `ℹ️ Cliente ${clientePhone} reservó *${cd.alojamiento}* — no se bloquea (solo chalet/villa).\n` +
        `Datos: ${cd.fecha}, ${cd.personas || '?'} pers.\n\n` +
        `No hago nada en la tabla de reservas.`,
        deviceId
      );
      return true;
    }

    // Crear la reserva
    const r = await crearReservaConfirmada({
      alojamiento: cd.alojamiento,
      fecha_sabado: cd.fecha,
      telefono_cliente: clientePhone,
      nombre_cliente: cd.nombre_cliente || null,
      personas: cd.personas || null,
      notas: `Confirmada manualmente vía comando admin`
    });

    if (r.ok) {
      const nombreAloj = cd.alojamiento === 'chalet_kent' ? 'Chalet Kent' : 'Villa de Bellreguard';
      await sendText(NOTIFICATION_PHONE,
        `✅ *Reserva confirmada*\n\n` +
        `🏠 ${nombreAloj}\n` +
        `📅 ${cd.fecha}\n` +
        `👥 ${cd.personas || '?'} personas\n` +
        `📞 ${clientePhone}${cd.nombre_cliente ? ` (${cd.nombre_cliente})` : ''}\n\n` +
        `Esa fecha ya está bloqueada — el bot no la ofrecerá a nadie más.`,
        deviceId
      );
      await log(clientePhone, 'reserva_confirmada', { alojamiento: cd.alojamiento, fecha: cd.fecha });
    } else if (r.error === 'ya_existe_reserva_esa_fecha') {
      await sendText(NOTIFICATION_PHONE,
        `⚠️ Ya hay una reserva confirmada para *${cd.alojamiento}* el *${cd.fecha}*.\n` +
        `No he creado otra. Revísalo en la tabla \`reservas\` de Supabase si crees que es un error.`,
        deviceId
      );
    } else {
      await sendText(NOTIFICATION_PHONE,
        `❌ Error creando reserva: ${r.error}\n${r.detalle || ''}`,
        deviceId
      );
    }
    return true;
  }

  // No es un comando reconocido
  return false;
}

export const config = {
  maxDuration: 30
};

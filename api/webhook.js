// API endpoint que recibe los webhooks de Wassenger
// Encola el mensaje y dispara el worker (con bypass de Deployment Protection)

import crypto from 'node:crypto';
import { pushMessage, isMessageSeen, markMessageSeen, wasBotSent } from '../lib/upstash.js';
import { isIgnoredPhone, getConversation, log, updateConversation } from '../lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
      const text = msg.body || msg.text || '';
      // No pausar si fue el bot mismo quien lo envió
      if (text && await wasBotSent(targetPhone, text)) {
        await log(targetPhone, 'self_outgoing_ignored', {});
        return;
      }
      const pausedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await updateConversation(targetPhone, { paused_until: pausedUntil }).catch(() => {});
      await log(targetPhone, 'manual_pause_inbound_fromMe', { until: pausedUntil });
    }
    return;
  }

  const rawFrom = msg.from || msg.chatId || '';
  if (rawFrom.includes('@g.us')) return;

  const phone = rawFrom.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
  if (!phone) return;

  const deviceId = (device && device.id) || msg.deviceId;

  if (msg.id && await isMessageSeen(msg.id)) {
    await log(phone, 'duplicate_ignored', { msgId: msg.id });
    return;
  }
  if (msg.id) await markMessageSeen(msg.id);

  const msgType = msg.type || 'chat';

  if (['image', 'video', 'sticker', 'document', 'vcard', 'contact', 'location'].includes(msgType)) {
    await log(phone, 'media_ignored', { type: msgType });
    return;
  }

  if (['audio', 'ptt', 'voice'].includes(msgType)) {
    const convo = await getConversation(phone);
    if (convo.closed) return;
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

  const text = msg.body || msg.text || '';
  if (!text) return;

  const convo = await getConversation(phone);

  if (convo.closed) { await log(phone, 'closed_ignored', {}); return; }
  if (convo.paused_until && new Date(convo.paused_until) > new Date()) {
    await log(phone, 'paused_ignored', {}); return;
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

  // FIRE-AND-FORGET: dispara el worker sin bloquear el webhook.
  // El propio worker responderá 200 inmediatamente y procesará en background.
  triggerWorker(phone, deviceId).catch(err =>
    console.error('Worker trigger failed:', err.message)
  );
}

async function handleOutgoingMessage(body) {
  const msg = body.data;
  if (!msg) return;

  const rawTo = msg.to || msg.chatId || '';
  const targetPhone = rawTo.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
  if (!targetPhone || targetPhone.includes('g.us')) return;

  // Si el mensaje saliente lo envió el propio bot vía API, NO pausar.
  // Detectamos comparando contenido con lo que el bot acaba de enviar (Redis 60s).
  const text = msg.body || msg.text || '';
  if (text && await wasBotSent(targetPhone, text)) {
    await log(targetPhone, 'bot_self_outgoing_ignored', {});
    return;
  }

  // También aceptamos pistas explícitas de Wassenger
  const sourceType = msg.sourceType || msg.source || msg.deliveredVia;
  if (sourceType === 'api') {
    await log(targetPhone, 'api_outgoing_ignored', { sourceType });
    return;
  }

  // Llegado aquí, asumimos que fue una persona (web/móvil/dashboard) → pausar 10 min
  const pausedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await updateConversation(targetPhone, { paused_until: pausedUntil }).catch(() => {});
  await log(targetPhone, 'manual_pause_web', { until: pausedUntil, sourceType: sourceType || 'unknown' });
}

function isActivationMessage(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const words = ['despedida', 'soltero', 'soltera', 'oneparty', 'one party'];
  if (words.some(w => normalized.includes(w))) return true;
  const phrases = [
    'precio', 'informacion', 'cuanto cuesta', 'cuanto vale',
    'pack basic', 'pack mix', 'pack a full', 'pack premium',
    'organizar despedida', 'reservar despedida'
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

export const config = {
  maxDuration: 30
};

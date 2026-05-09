// API endpoint que recibe los webhooks de Wassenger
// Lo único que hace es: validar, encolar y disparar el worker
// Responde rápido a Wassenger (siempre 200 OK)

import { pushMessage, isMessageSeen, markMessageSeen } from '../lib/upstash.js';
import { isIgnoredPhone, getConversation, log, updateConversation } from '../lib/supabase.js';
import { sendText, notifyHuman } from '../lib/wassenger.js';

export default async function handler(req, res) {
  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  // Procesar y disparar worker (esperamos a que la llamada al worker se inicie)
  // El worker procesará en su propia función, no aquí
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('Error en webhook:', err);
  }
  
  // Responder a Wassenger
  return res.status(200).json({ ok: true });
}

async function processWebhook(body) {
  if (!body || body.event !== 'message:in:new') return;
  
  const msg = body.data;
  const device = body.device;
  
  if (!msg) return;
  
  // 1. Filtros básicos
  if (msg.fromMe === true) {
    // Si yo (humano) escribo manualmente, pausar el bot 10 minutos para ese cliente
    const rawTo = msg.to || msg.chatId || '';
    const targetPhone = rawTo.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
    if (targetPhone && !targetPhone.includes('g.us')) {
      const pausedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await updateConversation(targetPhone, { paused_until: pausedUntil }).catch(() => {});
      await log(targetPhone, 'manual_pause', { until: pausedUntil });
    }
    return;
  }
  
  // Ignorar grupos
  const rawFrom = msg.from || msg.chatId || '';
  if (rawFrom.includes('@g.us')) return;
  
  const phone = rawFrom.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
  if (!phone) return;
  
  const deviceId = (device && device.id) || msg.deviceId;
  
  // 2. Anti-duplicados por ID
  if (msg.id && await isMessageSeen(msg.id)) {
    await log(phone, 'duplicate_ignored', { msgId: msg.id });
    return;
  }
  if (msg.id) await markMessageSeen(msg.id);
  
  // 3. Tipo de mensaje
  const msgType = msg.type || 'chat';
  
  // Ignorar tipos no soportados silenciosamente
  if (['image', 'video', 'sticker', 'document', 'vcard', 'contact', 'location'].includes(msgType)) {
    await log(phone, 'media_ignored', { type: msgType });
    return;
  }
  
  // Audio: respuesta automática rotando frases
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
    
    await sendText(phone, reply, deviceId);
    await updateConversation(phone, { audio_replied_at: new Date().toISOString() });
    await log(phone, 'audio_replied', {});
    return;
  }
  
  // 4. Texto: encolar y procesar
  const text = msg.body || msg.text || '';
  if (!text) return;
  
  // 5. Comprobaciones de negocio antes de encolar
  const convo = await getConversation(phone);
  
  // Conversación cerrada → ignorar
  if (convo.closed) {
    await log(phone, 'closed_ignored', {});
    return;
  }
  
  // Pausa manual activa → ignorar
  if (convo.paused_until && new Date(convo.paused_until) > new Date()) {
    await log(phone, 'paused_ignored', { until: convo.paused_until });
    return;
  }
  
  // Chat antiguo (en lista de ignorados) → ignorar
  if (await isIgnoredPhone(phone)) {
    await log(phone, 'old_chat_ignored', {});
    return;
  }
  
  // Conversación con historial pero NO activada por el bot → ignorar (chat preexistente)
  if (!convo.activated && convo.messages && convo.messages.length > 0) {
    await log(phone, 'preexisting_ignored', {});
    return;
  }
  
  // Activación: si no está activada, comprobar si el mensaje contiene palabras clave
  if (!convo.activated && !isActivationMessage(text)) {
    await log(phone, 'not_activated', { text: text.substring(0, 50) });
    return;
  }
  
  // 6. Encolar mensaje y disparar el worker
  const queueMsg = {
    id: msg.id || `${Date.now()}-${Math.random()}`,
    text,
    type: msgType,
    timestamp: Date.now(),
    deviceId
  };
  
  await pushMessage(phone, queueMsg);
  await log(phone, 'queued', { msgId: queueMsg.id });
  
  // Llamar al worker (fire-and-forget)
  triggerWorker(phone, deviceId).catch(err => {
    console.error('Error triggering worker:', err);
  });
}

/**
 * Detecta si un mensaje contiene palabras de activación
 */
function isActivationMessage(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  
  const words = ['despedida', 'soltero', 'soltera', 'oneparty', 'one party'];
  if (words.some(w => normalized.includes(w))) return true;
  
  const phrases = [
    'precio', 'informacion', 'cuanto cuesta', 'cuanto vale',
    'pack basic', 'pack mix', 'pack a full', 'pack premium',
    'organizar despedida', 'reservar despedida'
  ];
  if (phrases.some(p => normalized.includes(p))) return true;
  
  return false;
}

/**
 * Dispara el worker para procesar la cola del teléfono
 */
async function triggerWorker(phone, deviceId) {
  // SIEMPRE usar la URL fija del proyecto, NO la URL temporal del deploy
  // (las URLs temporales están protegidas por auth)
  const baseUrl = 'https://onepartybot.vercel.app';
  
  console.log('Triggering worker at:', `${baseUrl}/api/worker`, 'for phone:', phone);
  
  const workerRes = await fetch(`${baseUrl}/api/worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-token': process.env.INTERNAL_TOKEN || 'dev' },
    body: JSON.stringify({ phone, deviceId })
  });
  
  console.log('Worker response status:', workerRes.status);
}

export const config = {
  maxDuration: 30
};

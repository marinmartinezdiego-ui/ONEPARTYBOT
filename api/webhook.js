// API endpoint que recibe los webhooks de Wassenger
// Encola el mensaje y dispara el worker (con bypass de Deployment Protection)

import { pushMessage, isMessageSeen, markMessageSeen } from '../lib/upstash.js';
import { isIgnoredPhone, getConversation, log, updateConversation } from '../lib/supabase.js';
import { sendText, notifyHuman } from '../lib/wassenger.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  try {
    await processWebhook(req.body);
  } catch (err) {
    console.error('Error en webhook:', err);
  }
  
  return res.status(200).json({ ok: true });
}

async function processWebhook(body) {
  if (!body || body.event !== 'message:in:new') return;
  
  const msg = body.data;
  const device = body.device;
  if (!msg) return;
  
  if (msg.fromMe === true) {
    const rawTo = msg.to || msg.chatId || '';
    const targetPhone = rawTo.replace(/@c\.us$/, '').replace(/@s\.whatsapp\.net$/, '');
    if (targetPhone && !targetPhone.includes('g.us')) {
      const pausedUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await updateConversation(targetPhone, { paused_until: pausedUntil }).catch(() => {});
      await log(targetPhone, 'manual_pause', { until: pausedUntil });
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
  
  await triggerWorker(phone, deviceId);
}

function isActivationMessage(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
  const baseUrl = 'https://onepartybot.vercel.app';
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  
  // Añadir el bypass secret como query param para saltarse la Deployment Protection
  const workerUrl = bypassSecret 
    ? `${baseUrl}/api/worker?x-vercel-protection-bypass=${bypassSecret}`
    : `${baseUrl}/api/worker`;
  
  console.log('Triggering worker for phone:', phone, 'bypass:', !!bypassSecret);
  
  const workerRes = await fetch(workerUrl, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'x-internal-token': process.env.INTERNAL_TOKEN || 'dev',
      'x-vercel-protection-bypass': bypassSecret || ''
    },
    body: JSON.stringify({ phone, deviceId })
  });
  
  console.log('Worker response status:', workerRes.status);
}

export const config = {
  maxDuration: 30
};

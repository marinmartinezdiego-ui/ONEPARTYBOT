// Wrapper de Wassenger para enviar mensajes y gestionar el chat

import { markBotSentMessage, markBotSentMedia } from './upstash.js';

const WASSENGER_URL = 'https://api.wassenger.com/v1';
const WASSENGER_TOKEN = process.env.WASSENGER_API_KEY;
const NOTIFICATION_PHONE = process.env.NOTIFICATION_PHONE || '34620067712';
const NOTIFICATION_DEVICE_ID = process.env.NOTIFICATION_DEVICE_ID || null;

const headers = {
  'Content-Type': 'application/json',
  'Token': WASSENGER_TOKEN
};

export async function sendText(phone, message, deviceId) {
  // Registramos lo que mandamos para que el webhook de salida (message:out:new)
  // sepa que fue el bot y no un humano.
  await markBotSentMessage(phone, message);

  const res = await fetch(`${WASSENGER_URL}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone, message, device: deviceId })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wassenger sendText failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function sendImage(phone, imageUrl, deviceId) {
  // Las imágenes disparan message:out:new sin texto identificable.
  // Marcamos tanto la URL como un flag genérico de "media reciente del bot".
  await markBotSentMessage(phone, imageUrl);
  await markBotSentMedia(phone);

  const res = await fetch(`${WASSENGER_URL}/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ phone, device: deviceId, media: { url: imageUrl } })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Wassenger sendImage failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function sendTyping(phone, deviceId) {
  try {
    await fetch(`${WASSENGER_URL}/devices/${deviceId}/chats/${phone}/typing`, {
      method: 'POST',
      headers
    });
  } catch (e) {
    // No bloquear si falla
  }
}

export async function notifyHuman(reason, customerPhone, customerMsg, deviceId) {
  const message = `⚠️ *ONEPARTY BOT - Aviso*\n\n` +
    `📞 Cliente: ${customerPhone}\n` +
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}\n\n` +
    `🔔 Motivo: ${reason}\n\n` +
    `💬 Último mensaje del cliente:\n"${customerMsg}"\n\n` +
    `📝 El bot ha pausado la conversación. Responde tú directamente.`;

  // Si hay un device específico para notificaciones, lo usamos; si no,
  // caemos al del cliente (compat hacia atrás).
  const device = NOTIFICATION_DEVICE_ID || deviceId;
  return sendText(NOTIFICATION_PHONE, message, device);
}

// Wrapper de Wassenger para enviar mensajes y gestionar el chat

const WASSENGER_URL = 'https://api.wassenger.com/v1';
const WASSENGER_TOKEN = process.env.WASSENGER_API_KEY;
const NOTIFICATION_PHONE = process.env.NOTIFICATION_PHONE || '34620067712';

const headers = {
  'Content-Type': 'application/json',
  'Token': WASSENGER_TOKEN
};

/**
 * Envía un mensaje de texto a un teléfono
 */
export async function sendText(phone, message, deviceId) {
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

/**
 * Envía una imagen por URL
 */
export async function sendImage(phone, imageUrl, deviceId) {
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

/**
 * Activa el indicador "escribiendo..." en el chat
 */
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

/**
 * Notifica al humano (Diego) cuando hay algo que necesita su atención
 */
export async function notifyHuman(reason, customerPhone, customerMsg, deviceId) {
  const message = `⚠️ *ONEPARTY BOT - Aviso*\n\n` +
    `📞 Cliente: ${customerPhone}\n` +
    `⏰ ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })}\n\n` +
    `🔔 Motivo: ${reason}\n\n` +
    `💬 Último mensaje del cliente:\n"${customerMsg}"\n\n` +
    `📝 El bot ha pausado la conversación. Responde tú directamente.`;
  
  return sendText(NOTIFICATION_PHONE, message, deviceId);
}

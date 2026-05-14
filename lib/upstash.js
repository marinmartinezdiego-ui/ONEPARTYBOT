// Wrapper de Upstash Redis para la cola de mensajes y caches auxiliares

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const headers = {
  'Authorization': `Bearer ${UPSTASH_TOKEN}`,
  'Content-Type': 'application/json'
};

async function redis(...args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(args)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash error: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.result;
}

export async function pushMessage(phone, msg) {
  const key = `queue:${phone}`;
  await redis('RPUSH', key, JSON.stringify(msg));
  await redis('EXPIRE', key, 3600);
}

export async function drainQueue(phone) {
  const key = `queue:${phone}`;
  const pipeline = [
    ['LRANGE', key, '0', '-1'],
    ['DEL', key]
  ];

  const res = await fetch(`${UPSTASH_URL}/pipeline`, {
    method: 'POST',
    headers,
    body: JSON.stringify(pipeline)
  });

  const data = await res.json();
  const messages = (data[0]?.result || []).map(m => JSON.parse(m));
  return messages;
}

export async function acquireLock(phone, ttl = 30) {
  const key = `lock:${phone}`;
  const result = await redis('SET', key, '1', 'NX', 'EX', ttl.toString());
  return result === 'OK';
}

export async function releaseLock(phone) {
  const key = `lock:${phone}`;
  await redis('DEL', key);
}

export async function isMessageSeen(msgId) {
  if (!msgId) return false;
  const key = `seen:${msgId}`;
  const exists = await redis('EXISTS', key);
  return exists === 1;
}

export async function markMessageSeen(msgId) {
  if (!msgId) return;
  const key = `seen:${msgId}`;
  await redis('SET', key, '1', 'EX', '3600');
}

// --- Detección de mensajes enviados por el propio bot --------------------
// Cuando el bot envía un texto, lo registramos con TTL 90s. Cuando llega
// un webhook message:out:new para ese mismo número/contenido, sabemos que
// fue el bot y no un humano, así que NO pausamos.

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

export async function markBotSentMessage(phone, content) {
  if (!phone || !content) return;
  const key = `botsent:${phone}:${hashString(content.trim())}`;
  try {
    await redis('SET', key, '1', 'EX', '600');
  } catch (e) {
    console.error('markBotSentMessage failed:', e.message);
  }
}

export async function wasBotSent(phone, content) {
  if (!phone || !content) return false;
  const key = `botsent:${phone}:${hashString(content.trim())}`;
  try {
    const exists = await redis('EXISTS', key);
    return exists === 1;
  } catch (e) {
    console.error('wasBotSent failed:', e.message);
    return false;
  }
}

// Marca "el bot acaba de mandar media" para que el webhook sepa que cualquier
// message:out:new sin texto (o con media) en los próximos 90s viene del bot.
export async function markBotSentMedia(phone) {
  if (!phone) return;
  const key = `botmedia:${phone}`;
  try {
    await redis('SET', key, '1', 'EX', '600');
  } catch (e) {
    console.error('markBotSentMedia failed:', e.message);
  }
}

export async function wasBotSentMedia(phone) {
  if (!phone) return false;
  const key = `botmedia:${phone}`;
  try {
    const exists = await redis('EXISTS', key);
    return exists === 1;
  } catch (e) {
    console.error('wasBotSentMedia failed:', e.message);
    return false;
  }
}

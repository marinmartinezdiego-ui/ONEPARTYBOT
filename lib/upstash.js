// Wrapper de Upstash Redis para la cola de mensajes
// Sistema: 1 lista por teléfono (FIFO) + 1 lock por teléfono

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

const headers = {
  'Authorization': `Bearer ${UPSTASH_TOKEN}`,
  'Content-Type': 'application/json'
};

/**
 * Ejecuta un comando Redis vía REST API de Upstash
 */
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

/**
 * Añade un mensaje a la cola del teléfono
 * @param {string} phone
 * @param {object} msg - { id, text, type, timestamp, raw }
 */
export async function pushMessage(phone, msg) {
  const key = `queue:${phone}`;
  await redis('RPUSH', key, JSON.stringify(msg));
  // Expira en 1 hora si nadie la procesa (limpieza automática)
  await redis('EXPIRE', key, 3600);
}

/**
 * Obtiene y borra todos los mensajes pendientes de un teléfono
 * (atómico, evita duplicados)
 */
export async function drainQueue(phone) {
  const key = `queue:${phone}`;
  
  // LRANGE + DEL atómico vía pipeline
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

/**
 * Intenta adquirir un lock para un teléfono
 * @param {string} phone
 * @param {number} ttl - segundos
 * @returns {boolean} true si se adquirió el lock
 */
export async function acquireLock(phone, ttl = 30) {
  const key = `lock:${phone}`;
  const result = await redis('SET', key, '1', 'NX', 'EX', ttl.toString());
  return result === 'OK';
}

/**
 * Libera el lock de un teléfono
 */
export async function releaseLock(phone) {
  const key = `lock:${phone}`;
  await redis('DEL', key);
}

/**
 * Comprueba si un mensaje ya fue procesado por su ID
 * (cache de 1 hora)
 */
export async function isMessageSeen(msgId) {
  if (!msgId) return false;
  const key = `seen:${msgId}`;
  const exists = await redis('EXISTS', key);
  return exists === 1;
}

/**
 * Marca un mensaje como visto (cache 1 hora)
 */
export async function markMessageSeen(msgId) {
  if (!msgId) return;
  const key = `seen:${msgId}`;
  await redis('SET', key, '1', 'EX', '3600');
}

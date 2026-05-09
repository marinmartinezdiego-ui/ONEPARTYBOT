// Wrapper de Supabase para gestión de conversaciones y logs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

/**
 * Obtiene una conversación por teléfono
 * Si no existe, devuelve un objeto vacío con valores por defecto
 */
export async function getConversation(phone) {
  const url = `${SUPABASE_URL}/rest/v1/conversations?phone=eq.${phone}&select=*`;
  
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase getConversation failed: ${res.status} ${text}`);
    }
    
    const data = await res.json();
    if (data && data.length > 0) {
      return data[0];
    }
  } catch (err) {
    console.error('Error obteniendo conversación:', err);
  }
  
  return {
    phone,
    state: 'nuevo',
    messages: [],
    customer_data: {},
    activated: false,
    closed: false,
    paused_until: null,
    last_msg_id: null,
    audio_replied_at: null,
    summary: null
  };
}

/**
 * Guarda o actualiza una conversación
 */
export async function saveConversation(convo) {
  const url = `${SUPABASE_URL}/rest/v1/conversations`;
  
  const body = {
    phone: convo.phone,
    state: convo.state || 'nuevo',
    messages: convo.messages || [],
    summary: convo.summary || null,
    customer_data: convo.customer_data || {},
    activated: convo.activated || false,
    closed: convo.closed || false,
    paused_until: convo.paused_until || null,
    last_msg_id: convo.last_msg_id || null,
    audio_replied_at: convo.audio_replied_at || null,
    updated_at: new Date().toISOString(),
    last_activity: new Date().toISOString()
  };
  
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase saveConversation failed: ${res.status} ${text}`);
  }
  
  return true;
}

/**
 * Actualiza solo campos específicos (más eficiente)
 */
export async function updateConversation(phone, fields) {
  const url = `${SUPABASE_URL}/rest/v1/conversations?phone=eq.${phone}`;
  
  const body = {
    ...fields,
    updated_at: new Date().toISOString()
  };
  
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...headers,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(body)
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase updateConversation failed: ${res.status} ${text}`);
  }
  
  return true;
}

/**
 * Comprueba si un mensaje ya fue procesado (anti-duplicados)
 */
export async function isMessageProcessed(msgId) {
  if (!msgId) return false;
  
  const url = `${SUPABASE_URL}/rest/v1/conversations?last_msg_id=eq.${msgId}&select=phone&limit=1`;
  
  try {
    const res = await fetch(url, { headers });
    const data = await res.json();
    return data && data.length > 0;
  } catch (err) {
    console.error('Error checking message:', err);
    return false;
  }
}

/**
 * Comprueba si un teléfono está en la lista de ignorados (chats antiguos)
 */
export async function isIgnoredPhone(phone) {
  const url = `${SUPABASE_URL}/rest/v1/ignored_phones?phone=eq.${phone}&select=ignore_until&limit=1`;
  
  try {
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!data || data.length === 0) return false;
    
    const ignoreUntil = data[0].ignore_until;
    if (!ignoreUntil) return true; // ignorar siempre
    
    return new Date(ignoreUntil) > new Date();
  } catch (err) {
    console.error('Error checking ignored phone:', err);
    return false;
  }
}

/**
 * Registra un evento en bot_logs (para debugging)
 */
export async function log(phone, eventType, data = {}) {
  const url = `${SUPABASE_URL}/rest/v1/bot_logs`;
  
  // No bloqueamos si falla
  fetch(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({
      phone,
      event_type: eventType,
      data
    })
  }).catch(err => console.error('Error logging:', err));
}

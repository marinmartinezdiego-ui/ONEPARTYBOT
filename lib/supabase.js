// Wrapper de Supabase para gestión de conversaciones y logs

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

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
      // Asegurar que customer_data y messages no sean null
      const convo = data[0];
      convo.customer_data = convo.customer_data || {};
      convo.messages = convo.messages || [];
      return convo;
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

export async function updateConversation(phone, fields) {
  if (!phone || !fields || typeof fields !== 'object') return false;

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

export async function isIgnoredPhone(phone) {
  const url = `${SUPABASE_URL}/rest/v1/ignored_phones?phone=eq.${phone}&select=ignore_until&limit=1`;

  try {
    const res = await fetch(url, { headers });
    const data = await res.json();
    if (!data || data.length === 0) return false;

    const ignoreUntil = data[0].ignore_until;
    if (!ignoreUntil) return true;

    return new Date(ignoreUntil) > new Date();
  } catch (err) {
    console.error('Error checking ignored phone:', err);
    return false;
  }
}

/**
 * Guarda una pregunta que el bot no supo responder.
 * Se usa cuando Claude llama a la tool "avisar_humano" — la guardamos
 * con contexto suficiente para revisar de noche y actualizar el prompt.
 */
export async function saveUnknownQuestion({ phone, customer_question, motivo, conversation_context, customer_data }) {
  const url = `${SUPABASE_URL}/rest/v1/bot_unknown_questions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        phone,
        customer_question,
        motivo,
        conversation_context,
        customer_data
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('saveUnknownQuestion failed:', res.status, txt);
    }
  } catch (err) {
    console.error('saveUnknownQuestion error:', err.message);
  }
}

export async function log(phone, eventType, data = {}) {
  const url = `${SUPABASE_URL}/rest/v1/bot_logs`;

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

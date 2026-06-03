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

// =====================================================================
// RESERVAS (disponibilidad de Chalet Kent y Villa Bellreguard)
// =====================================================================

/**
 * Devuelve TRUE si el alojamiento está disponible esa fecha (no reservado).
 * fecha debe ser YYYY-MM-DD (idealmente la fecha del SÁBADO de la despedida).
 */
export async function consultarDisponibilidadReserva(alojamiento, fecha) {
  if (!alojamiento || !fecha) return { disponible: true, motivo: 'sin_datos' };

  // Solo bloqueamos Chalet Kent y Villa Bellreguard. El resto siempre disponible.
  if (alojamiento !== 'chalet_kent' && alojamiento !== 'villa_bellreguard') {
    return { disponible: true, motivo: 'no_se_bloquea_este_alojamiento' };
  }

  const url = `${SUPABASE_URL}/rest/v1/reservas?alojamiento=eq.${alojamiento}&fecha_sabado=eq.${fecha}&estado=eq.confirmada&select=id,nombre_cliente,personas&limit=1`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error('consultarDisponibilidadReserva failed:', res.status);
      // Ante error de BD, asumimos disponible para no bloquear al cliente.
      return { disponible: true, motivo: 'error_db' };
    }
    const data = await res.json();
    if (data && data.length > 0) {
      return { disponible: false, motivo: 'ocupada', reserva: data[0] };
    }
    return { disponible: true };
  } catch (err) {
    console.error('consultarDisponibilidadReserva error:', err.message);
    return { disponible: true, motivo: 'error_red' };
  }
}

/**
 * Crea una reserva confirmada. Si ya existe una confirmada para esa
 * combinación (alojamiento + fecha), devuelve error (índice único).
 */
export async function crearReservaConfirmada({ alojamiento, fecha_sabado, telefono_cliente, nombre_cliente, personas, notas }) {
  if (!alojamiento || !fecha_sabado) {
    return { ok: false, error: 'Faltan alojamiento o fecha_sabado' };
  }
  const url = `${SUPABASE_URL}/rest/v1/reservas`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        alojamiento,
        fecha_sabado,
        telefono_cliente: telefono_cliente || null,
        nombre_cliente: nombre_cliente || null,
        personas: personas || null,
        notas: notas || null,
        estado: 'confirmada'
      })
    });
    if (!res.ok) {
      const txt = await res.text();
      // 23505 = unique violation: ya hay otra confirmada esa fecha
      if (txt.includes('23505') || txt.includes('duplicate')) {
        return { ok: false, error: 'ya_existe_reserva_esa_fecha', detalle: txt };
      }
      return { ok: false, error: 'db_error', detalle: txt };
    }
    const data = await res.json();
    return { ok: true, reserva: Array.isArray(data) ? data[0] : data };
  } catch (err) {
    return { ok: false, error: err.message };
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

// ============================================================
//  keepalive.js
//  Mantiene vivas las bases de datos del plan gratuito para que
//  no las archiven (Upstash) ni las pausen (Supabase) cuando el
//  bot está parado fuera de temporada.
//
//  Supabase pausa los proyectos que no reciben "unas pocas
//  peticiones al día" durante una semana, y solo cuentan las que
//  llegan de verdad a la base de datos. Por eso aquí hacemos
//  VARIAS consultas reales a tablas distintas, no una sola.
//
//  Lo llama el cron de Vercel (1 vez al día) y, de refuerzo, un
//  workflow de GitHub Actions cada 6 horas.
//  No necesita ningún token nuevo: usa las variables que ya hay.
// ============================================================

async function consultaSupabase(url, key, tabla, columna) {
  const r = await fetch(`${url}/rest/v1/${tabla}?select=${columna}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`${tabla} -> ${r.status}: ${(await r.text()).slice(0, 100)}`);
  await r.json().catch(() => null);   // nos aseguramos de consumir la respuesta
  return true;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'no autorizado' });
  }

  const out = { fecha: new Date().toISOString(), upstash: null, supabase: null, consultas: 0 };

  // ── Upstash Redis ──
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error('faltan UPSTASH_REDIS_REST_URL / _TOKEN');

    const cmd = async (...args) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      if (!r.ok) throw new Error(`Upstash ${r.status}: ${(await r.text()).slice(0, 100)}`);
    };

    await cmd('SET', 'keepalive', String(Date.now()), 'EX', '604800');
    await cmd('GET', 'keepalive');
    out.upstash = 'ok';
  } catch (e) {
    out.upstash = `ERROR: ${e.message}`;
  }

  // ── Supabase: varias consultas reales a tablas distintas ──
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error('faltan SUPABASE_URL / SUPABASE_KEY');

    const tablas = [
      ['conversations', 'phone'],
      ['bot_logs', 'phone'],
      ['reservas', 'id'],
      ['ignored_phones', 'phone'],
    ];

    const fallos = [];
    for (const [tabla, columna] of tablas) {
      try {
        await consultaSupabase(url, key, tabla, columna);
        out.consultas++;
      } catch (e) {
        fallos.push(e.message);
      }
      await new Promise(r => setTimeout(r, 300));   // las separamos un poco
    }

    // Con que una tabla responda, la base de datos está viva y contactada.
    if (out.consultas === 0) throw new Error(fallos.join(' | ') || 'ninguna consulta salió');
    out.supabase = fallos.length ? `ok (${out.consultas}/${tablas.length}, fallaron: ${fallos.length})` : 'ok';
  } catch (e) {
    out.supabase = `ERROR: ${e.message}`;
  }

  const bien = out.upstash === 'ok' && String(out.supabase).startsWith('ok');
  return res.status(bien ? 200 : 500).json(out);
}

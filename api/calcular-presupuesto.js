// Endpoint público para que la OneParty app genere presupuestos
// usando el mismo motor de cálculo que el bot. No hay datos sensibles,
// así que CORS abierto a cualquier origen.
//
// Uso: POST /api/calcular-presupuesto
//   Body JSON:
//     {
//       personas: number (requerido),
//       temporada: 'ene_abr' | 'mayo' | 'jun_sem12' | 'jun_sem3' | 'jun_sem4' | 'jul_ago' | 'sep_dic'
//                  (requerido, se traduce internamente a una fecha ejemplo)
//       pack: 'basic' | 'mix' | 'afull' | 'afull_sin_actividad' | 'afull_sin_comida' | 'premium' | 'solo_actividad'
//       alojamiento: 'hostal' | 'bungalow' | 'apartamento' | 'hotel' | 'chalet_kent' | 'villa_bellreguard' | null
//       actividad: id | null
//       segunda_actividad: id | null
//       comida: id | null
//       cena: id | null
//       extras: array<id>
//       solo_sabado: boolean (opcional)
//     }
//
//   También acepta "fecha": 'YYYY-MM-DD' si se prefiere una fecha concreta
//   en lugar de temporada.

import { calcularPresupuesto, formatPresupuesto } from '../lib/pricing.js';

// Fecha-ejemplo por temporada (sábado representativo dentro del tramo)
const FECHA_POR_TEMPORADA = {
  ene_abr:    '2026-03-14',  // mitad de marzo
  mayo:       '2026-05-16',  // mitad de mayo
  jun_sem12:  '2026-06-13',  // sábado semana 2 de junio
  jun_sem3:   '2026-06-20',  // sábado semana 3 de junio
  jun_sem4:   '2026-06-27',  // sábado semana 4 de junio
  jul_ago:    '2026-07-18',  // mitad de julio
  sep_dic:    '2026-10-17'   // mitad de octubre
};

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCORS(res);

  // Preflight CORS
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    const {
      personas,
      temporada,
      fecha,
      pack = 'afull',
      alojamiento = null,
      actividad = null,
      segunda_actividad = null,
      comida = null,
      cena = null,
      extras = [],
      solo_sabado = false
    } = body;

    if (!personas || typeof personas !== 'number' || personas < 1) {
      return res.status(400).json({ ok: false, error: 'personas: número >= 1 requerido' });
    }

    let fechaFinal = fecha;
    if (!fechaFinal) {
      if (!temporada) {
        return res.status(400).json({ ok: false, error: 'Falta temporada o fecha' });
      }
      fechaFinal = FECHA_POR_TEMPORADA[temporada];
      if (!fechaFinal) {
        return res.status(400).json({ ok: false, error: `Temporada desconocida: ${temporada}` });
      }
    }

    const presupuesto = calcularPresupuesto({
      pack,
      fecha: fechaFinal,
      personas,
      alojamiento,
      actividad,
      segunda_actividad,
      comida,
      cena,
      extras,
      solo_sabado
    });

    const mensaje_whatsapp = formatPresupuesto(presupuesto);

    return res.status(200).json({
      ok: true,
      precio_persona: presupuesto.por_persona,
      precio_total: presupuesto.total_grupo,
      suplemento_grupo: presupuesto.suplemento_grupo,
      plazas_vacias_motos: presupuesto.plazas_vacias_motos,
      desglose: presupuesto.desglose,
      pack_nombre: presupuesto.pack_nombre,
      pack_id: presupuesto.pack_id,
      periodo: presupuesto.periodo,
      es_pool_party_temporada: presupuesto.es_pool_party_temporada,
      correccion_aplicada: presupuesto.correccion_aplicada,
      mensaje_whatsapp
    });

  } catch (err) {
    console.error('[calcular-presupuesto] Error:', err);
    return res.status(400).json({ ok: false, error: err.message || 'Error desconocido' });
  }
}

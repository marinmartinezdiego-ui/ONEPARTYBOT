// Motor de cálculo de precios para ONEPARTY
// Importa datos desde JSONs separados

import packs from '../data/packs.json' with { type: 'json' };
import alojamientos from '../data/alojamientos.json' with { type: 'json' };
import catalog from '../data/catalog.json' with { type: 'json' };

const GASTOS_GESTION = catalog.gastos_gestion_por_persona;

/**
 * Determina el período de precio según la fecha
 * @param {Date} date
 * @returns {string} ene_abr | mayo | jun_sem12 | jun_sem3 | jun_sem4 | jul_ago | sep_dic
 */
export function getPeriodoPrecio(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  
  if (m >= 1 && m <= 4) return 'ene_abr';
  if (m === 5) return 'mayo';
  if (m === 6) {
    if (d <= 14) return 'jun_sem12';
    if (d <= 21) return 'jun_sem3';
    return 'jun_sem4';
  }
  if (m === 7 || m === 8) return 'jul_ago';
  return 'sep_dic';
}

/**
 * Obtiene el precio del pack base
 */
export function getPrecioPack(packId) {
  const pack = packs[packId];
  if (!pack) throw new Error(`Pack desconocido: ${packId}`);
  return pack.precio;
}

/**
 * Calcula el precio del alojamiento por persona
 * @param {string} tipo - hostal, bungalow, apartamento, hotel, chalet
 * @param {Date} fecha
 * @param {number} personas
 */
export function calcularAlojamiento(tipo, fecha, personas) {
  const periodo = getPeriodoPrecio(fecha);
  
  // Alojamientos fijos (precio por persona directo)
  if (alojamientos.fijo[tipo]) {
    const aloj = alojamientos.fijo[tipo];
    if (aloj.max_personas && personas > aloj.max_personas) {
      throw new Error(`${aloj.nombre} solo admite hasta ${aloj.max_personas} personas`);
    }
    return aloj.precios[periodo];
  }
  
  // Chalet/Villa (precio variable según grupo)
  if (alojamientos.variable[tipo]) {
    const chalet = alojamientos.variable[tipo];
    const tarifa = chalet.tarifas[periodo];
    
    let total;
    if (personas <= chalet.min_personas) {
      total = tarifa.base;
    } else {
      const extras = personas - chalet.min_personas;
      total = tarifa.base + (extras * tarifa.extra_pers);
    }
    
    return Math.round(total / personas);
  }
  
  throw new Error(`Tipo de alojamiento desconocido: ${tipo}`);
}

/**
 * Calcula el suplemento por persona de actividades
 * Maneja el caso especial de las motos de agua
 */
export function calcularActividad(actividadId, personas) {
  const act = catalog.actividades[actividadId];
  if (!act) throw new Error(`Actividad desconocida: ${actividadId}`);
  
  // Caso especial motos de agua: en pareja
  if (act.calculo_especial === 'motos_agua') {
    const motosNecesarias = Math.ceil(personas / 2);
    const costeTotal = motosNecesarias * act.suplemento * 2; // suplemento es por plaza
    return Math.round(costeTotal / personas);
  }
  
  return act.suplemento;
}

/**
 * Suplemento de comida
 */
export function calcularComida(comidaId) {
  const c = catalog.comidas[comidaId];
  if (!c) throw new Error(`Comida desconocida: ${comidaId}`);
  return c.suplemento;
}

/**
 * Suplemento de cena
 */
export function calcularCena(cenaId) {
  const c = catalog.cenas[cenaId];
  if (!c) throw new Error(`Cena desconocida: ${cenaId}`);
  return c.suplemento;
}

/**
 * Suplemento de un extra
 */
export function calcularExtra(extraId) {
  const e = catalog.extras[extraId];
  if (!e) throw new Error(`Extra desconocido: ${extraId}`);
  return e.suplemento;
}

/**
 * Calcula precio de segunda actividad
 * Es el suplemento de la actividad + 20€
 */
export function calcularSegundaActividad(actividadId, personas) {
  const baseSuplemento = calcularActividad(actividadId, personas);
  return baseSuplemento + 20;
}

/**
 * Calcula el presupuesto completo
 * @param {object} opciones
 * @returns {object} { por_persona, total_grupo, desglose }
 */
export function calcularPresupuesto({
  pack = 'afull',
  fecha,
  personas,
  alojamiento = null,
  actividad = null,
  segunda_actividad = null,
  comida = null,
  cena = null,
  extras = []
}) {
  if (!fecha) throw new Error('Falta fecha');
  if (!personas || personas < 1) throw new Error('Falta número de personas');
  
  const fechaObj = fecha instanceof Date ? fecha : new Date(fecha);
  
  const desglose = {
    pack: getPrecioPack(pack),
    alojamiento: 0,
    actividad: 0,
    segunda_actividad: 0,
    comida: 0,
    cena: 0,
    extras: 0,
    gestion: GASTOS_GESTION
  };
  
  if (alojamiento) {
    desglose.alojamiento = calcularAlojamiento(alojamiento, fechaObj, personas);
  }
  
  if (actividad) {
    desglose.actividad = calcularActividad(actividad, personas);
  }
  
  if (segunda_actividad) {
    desglose.segunda_actividad = calcularSegundaActividad(segunda_actividad, personas);
  }
  
  if (comida) {
    desglose.comida = calcularComida(comida);
  }
  
  if (cena) {
    desglose.cena = calcularCena(cena);
  }
  
  if (extras && extras.length > 0) {
    desglose.extras = extras.reduce((sum, e) => sum + calcularExtra(e), 0);
  }
  
  const por_persona = Object.values(desglose).reduce((a, b) => a + b, 0);
  const total_grupo = por_persona * personas;
  
  return {
    por_persona,
    total_grupo,
    desglose,
    personas,
    pack_nombre: packs[pack].nombre,
    periodo: getPeriodoPrecio(fechaObj)
  };
}

/**
 * Calcula la señal de la reserva
 */
export function calcularSenal(alojamiento, personas) {
  // Chalet/Villa: 900€ fijos
  if (alojamiento === 'chalet') return 900;
  
  // Resto: 10€ × personas con mínimo de 100€
  return Math.max(100, personas * 10);
}

/**
 * Formatea el presupuesto para WhatsApp
 */
export function formatPresupuesto(p) {
  let mensaje = `🎉 *PRESUPUESTO ONEPARTY*\n\n`;
  mensaje += `Pack: ${p.pack_nombre} | Personas: ${p.personas}\n\n`;
  
  const partes = [];
  partes.push(`${p.desglose.pack}€ pack`);
  if (p.desglose.alojamiento) partes.push(`${p.desglose.alojamiento}€ alojamiento`);
  if (p.desglose.actividad) partes.push(`${p.desglose.actividad}€ actividad`);
  if (p.desglose.segunda_actividad) partes.push(`${p.desglose.segunda_actividad}€ 2ª actividad`);
  if (p.desglose.comida) partes.push(`${p.desglose.comida}€ comida`);
  if (p.desglose.cena) partes.push(`${p.desglose.cena}€ cena`);
  if (p.desglose.extras) partes.push(`${p.desglose.extras}€ extras`);
  partes.push(`${p.desglose.gestion}€ gestión`);
  
  mensaje += `💰 *Total: ${p.por_persona}€/pers*\n`;
  mensaje += `(${partes.join(' + ')})\n\n`;
  mensaje += `*Total grupo: ${p.total_grupo}€*`;
  
  return mensaje;
}

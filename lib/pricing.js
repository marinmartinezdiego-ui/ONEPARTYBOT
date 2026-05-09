// Motor de cálculo de precios para ONEPARTY
// V2 - Con formato "Ejemplo Pack" estilo Diego

import packs from '../data/packs.json' with { type: 'json' };
import alojamientos from '../data/alojamientos.json' with { type: 'json' };
import catalog from '../data/catalog.json' with { type: 'json' };

const GASTOS_GESTION = catalog.gastos_gestion_por_persona;

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

export function getPrecioPack(packId) {
  const pack = packs[packId];
  if (!pack) throw new Error(`Pack desconocido: ${packId}`);
  return pack.precio;
}

export function calcularAlojamiento(tipo, fecha, personas) {
  const periodo = getPeriodoPrecio(fecha);
  
  if (alojamientos.fijo[tipo]) {
    const aloj = alojamientos.fijo[tipo];
    if (aloj.max_personas && personas > aloj.max_personas) {
      throw new Error(`${aloj.nombre} solo admite hasta ${aloj.max_personas} personas`);
    }
    return aloj.precios[periodo];
  }
  
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

export function calcularActividad(actividadId, personas) {
  const act = catalog.actividades[actividadId];
  if (!act) throw new Error(`Actividad desconocida: ${actividadId}`);
  
  if (act.calculo_especial === 'motos_agua') {
    const motosNecesarias = Math.ceil(personas / 2);
    const costeTotal = motosNecesarias * act.suplemento * 2;
    return Math.round(costeTotal / personas);
  }
  
  return act.suplemento;
}

export function calcularComida(comidaId) {
  const c = catalog.comidas[comidaId];
  if (!c) throw new Error(`Comida desconocida: ${comidaId}`);
  return c.suplemento;
}

export function calcularCena(cenaId) {
  const c = catalog.cenas[cenaId];
  if (!c) throw new Error(`Cena desconocida: ${cenaId}`);
  return c.suplemento;
}

export function calcularExtra(extraId) {
  const e = catalog.extras[extraId];
  if (!e) throw new Error(`Extra desconocido: ${extraId}`);
  return e.suplemento;
}

export function calcularSegundaActividad(actividadId, personas) {
  const baseSuplemento = calcularActividad(actividadId, personas);
  return baseSuplemento + 20;
}

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
    pack_id: pack,
    periodo: getPeriodoPrecio(fechaObj),
    alojamiento_id: alojamiento,
    actividad_id: actividad,
    comida_id: comida,
    cena_id: cena,
    fecha: fechaObj.toISOString().substring(0, 10),
    es_pool_party_temporada: catalog.pool_party_meses.includes(fechaObj.getMonth() + 1)
  };
}

export function calcularSenal(alojamiento, personas) {
  if (alojamiento === 'chalet') return 900;
  return Math.max(100, personas * 10);
}

/**
 * Formatea presupuesto en formato "Ejemplo Pack" estilo Diego
 */
export function formatPresupuesto(p) {
  const aloj = p.alojamiento_id ? getAlojNombre(p.alojamiento_id) : null;
  const isAFull = p.pack_id === 'afull' || p.pack_id === 'premium';
  
  let mensaje = `*Ejemplo Pack ${p.pack_nombre}*\n\n`;
  
  if (aloj) {
    mensaje += `🏠 ${aloj} 2N\n+\n`;
  }
  
  mensaje += `*Sábado*\n`;
  mensaje += `🎯 Actividad a elegir\n`;
  
  if (isAFull || p.pack_id === 'mix' || p.pack_id === 'basic') {
    mensaje += `🍽️ Comida a elegir\n`;
  }
  
  mensaje += `🍻 Tardeo con descuentos\n`;
  
  if (isAFull) {
    mensaje += `🍷 Cena a elegir\n`;
  }
  
  mensaje += `🎟️ Entrada discoteca\n`;
  
  if (p.pack_id === 'premium') {
    mensaje += `🥂 Reservado VIP\n`;
  } else if (p.pack_id === 'basic' || p.pack_id === 'mix') {
    mensaje += `🥃 2 copas gratis\n`;
  }
  
  mensaje += `______\n`;
  mensaje += `*Total ${p.por_persona}€/pers*\n\n`;
  
  mensaje += `🎁 Regalo viernes gratis\n`;
  mensaje += `🍻 Descuentos especiales pubs\n`;
  mensaje += `🎟️ Entrada Eclipse gratis\n\n`;
  
  if (p.es_pool_party_temporada) {
    mensaje += `👙 Pool Party + Fiesta Espuma en La Finca\n\n`;
  }
  
  mensaje += `🎉 Regalo Novi@\n`;
  mensaje += `🎮 Gynkana de pruebas graciosas\n\n`;
  
  if (isAFull) {
    mensaje += `🥂 2 copitas gratis Novi@ y organizador`;
  }
  
  return mensaje.trim();
}

function getAlojNombre(tipo) {
  if (alojamientos.fijo[tipo]) return alojamientos.fijo[tipo].nombre;
  if (alojamientos.variable[tipo]) return alojamientos.variable[tipo].nombre;
  return tipo;
}

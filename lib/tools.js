// Definición de tools (function calling) para Claude
// Claude NO calcula precios, solo decide qué función llamar y con qué parámetros

import { calcularPresupuesto, calcularSenal, formatPresupuesto } from './pricing.js';
import { updateConversation, getConversation } from './supabase.js';

export const TOOLS = [
  {
    name: 'calcular_presupuesto',
    description: 'Calcula el presupuesto exacto de una despedida con todos los conceptos. SIEMPRE incluye automáticamente los 6€ de gestión por persona. Devuelve precio por persona, total grupo y desglose completo.',
    input_schema: {
      type: 'object',
      properties: {
        pack: {
          type: 'string',
          enum: ['basic', 'mix', 'afull', 'afull_sin_actividad', 'afull_sin_comida', 'premium'],
          description: 'Pack elegido. Si el cliente no especifica, usa "afull" por defecto. Variantes de 50€: "afull_sin_actividad" si NO quieren actividad (mantienen comida+cena); "afull_sin_comida" si NO quieren comida (mantienen actividad+cena). NO mezclar.'
        },
        fecha: {
          type: 'string',
          description: 'Fecha de la despedida en formato YYYY-MM-DD (ej: 2026-07-30)'
        },
        personas: {
          type: 'number',
          description: 'Número de personas que pagan (sin contar al novio/a si entra gratis)'
        },
        alojamiento: {
          type: 'string',
          enum: ['hostal', 'bungalow', 'apartamento', 'hotel', 'chalet'],
          description: 'Tipo de alojamiento. Omitir si no necesitan.'
        },
        actividad: {
          type: 'string',
          enum: ['escape_room', 'archery_tag', 'tiro_arco', 'lucha_sumo', 'futbolin_humano', 'sumo_hinchable', 'velero', 'kayak', 'padel_surf', 'spa', 'bubble', 'karts', 'paintball', 'banana', 'humor_amarillo', 'barco', 'caballo', 'motos_agua'],
          description: 'Actividad principal elegida. Omitir si pack Basic o si no han elegido todavía.'
        },
        segunda_actividad: {
          type: 'string',
          enum: ['escape_room', 'archery_tag', 'tiro_arco', 'lucha_sumo', 'futbolin_humano', 'sumo_hinchable', 'velero', 'kayak', 'padel_surf', 'spa', 'bubble', 'karts', 'paintball', 'banana', 'humor_amarillo', 'barco', 'caballo', 'motos_agua'],
          description: 'Segunda actividad si quieren añadirla. Suma +20€ al suplemento de la actividad.'
        },
        comida: {
          type: 'string',
          enum: ['meraki', 'la_finca', 'chiringuito'],
          description: 'Restaurante de comida elegido.'
        },
        cena: {
          type: 'string',
          enum: ['meraki', 'bestias_21', 'bestias_23'],
          description: 'Restaurante de cena elegido.'
        },
        extras: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['copas_disco', 'mesa_vip']
          },
          description: 'Lista de extras añadidos. "copas_disco" = entrada + 2 copas en la disco del SÁBADO (14€). NO añadir si el pack es Basic o Premium (ya la incluyen).'
        }
      },
      required: ['fecha', 'personas']
    }
  },
  {
    name: 'enviar_imagen',
    description: 'Envía una imagen al cliente: la imagen de packs, el menú de comida o el menú de cena. Úsalo SIEMPRE en lugar de describir packs o menús con texto.',
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['packs', 'menu_comida', 'menu_cena'],
          description: 'Tipo de imagen a enviar.'
        }
      },
      required: ['tipo']
    }
  },
  {
    name: 'enviar_datos_pago',
    description: 'Envía al cliente los datos de pago (IBAN, importe de señal, instrucciones). Solo cuando ya hayan rellenado el formulario y hayan mandado la imagen del resumen.',
    input_schema: {
      type: 'object',
      properties: {
        alojamiento: {
          type: 'string',
          enum: ['hostal', 'bungalow', 'apartamento', 'hotel', 'chalet', 'sin_alojamiento'],
          description: 'Tipo de alojamiento elegido (afecta al cálculo de la señal).'
        },
        personas: {
          type: 'number',
          description: 'Número de personas.'
        }
      },
      required: ['alojamiento', 'personas']
    }
  },
  {
    name: 'avisar_humano',
    description: 'Manda un aviso al humano y pausa la conversación. Úsalo cuando: 1) El cliente quiera modificar una reserva ya hecha (apuntar/desapuntar gente, cambiar fecha, etc.), 2) Pregunte algo que el bot no sabe, 3) Algo importante requiera atención humana. NO uses esto para preguntas normales sobre packs o precios.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo conciso del aviso (ej: "Cliente quiere apuntar 2 personas más al alojamiento")'
        },
        respuesta_al_cliente: {
          type: 'string',
          description: 'Mensaje que se enviará al cliente diciendo que un compañero le responde enseguida.'
        }
      },
      required: ['motivo', 'respuesta_al_cliente']
    }
  },
  {
    name: 'guardar_datos_cliente',
    description: 'Guarda los datos del cliente extraídos de la conversación (fecha, personas, pack elegido, etc.). Hace MERGE con lo que ya hubiera guardado: solo pasa los campos NUEVOS o CAMBIADOS, no es necesario repetir lo anterior.',
    input_schema: {
      type: 'object',
      properties: {
        fecha: { type: 'string', description: 'Fecha en formato YYYY-MM-DD' },
        personas: { type: 'number' },
        pack: { type: 'string' },
        alojamiento: { type: 'string' },
        actividad: { type: 'string' },
        segunda_actividad: { type: 'string' },
        comida: { type: 'string' },
        cena: { type: 'string' },
        extras: { type: 'array', items: { type: 'string' } },
        ultimo_presupuesto_por_persona: { type: 'number' },
        nombre_cliente: { type: 'string' },
        notas: { type: 'string', description: 'Notas o peticiones especiales del cliente' }
      }
    }
  },
  {
    name: 'cerrar_conversacion',
    description: 'Cierra la conversación cuando el cliente ya ha pagado y se ha completado la reserva. A partir de aquí el bot no responderá más en este chat.',
    input_schema: {
      type: 'object',
      properties: {
        razon: { type: 'string' }
      },
      required: ['razon']
    }
  }
];

export async function executeTool(toolName, toolInput, context) {
  const { phone, deviceId, customerMsg } = context;

  switch (toolName) {
    case 'calcular_presupuesto': {
      try {
        const presupuesto = calcularPresupuesto(toolInput);
        // Auto-guardamos el último presupuesto en customer_data (merge)
        try {
          const convo = await getConversation(phone);
          const merged = {
            ...(convo.customer_data || {}),
            ...toolInput,
            ultimo_presupuesto_por_persona: presupuesto.por_persona,
            ultimo_presupuesto_total_grupo: presupuesto.total_grupo
          };
          await updateConversation(phone, { customer_data: merged });
        } catch (e) { /* no bloquear el flujo */ }
        return {
          ok: true,
          presupuesto,
          mensaje_formateado: formatPresupuesto(presupuesto)
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'enviar_imagen': {
      const urls = {
        packs: 'https://onepartybot.vercel.app/images/packs.jpg',
        menu_comida: 'https://onepartybot.vercel.app/images/menu-comida.jpg',
        menu_cena: 'https://onepartybot.vercel.app/images/menu-cena.jpg'
      };
      const url = urls[toolInput.tipo];
      return {
        ok: true,
        accion: 'enviar_imagen',
        url,
        tipo: toolInput.tipo
      };
    }

    case 'enviar_datos_pago': {
      const { alojamiento, personas } = toolInput;
      const senal = calcularSenal(alojamiento, personas);
      const mensajePago =
        `💳 *DATOS DE PAGO*\n\n` +
        `1️⃣ Señal: ${senal}€\n\n` +
        `2️⃣ 50% del resto en la fecha indicada en el documento de reserva\n\n` +
        `💰 Pago final a la llegada en destino\n\n` +
        `🏦 ES30 0182 2741 1702 0162 2342\n` +
        `📝 Concepto: Nombre y apellidos + teléfono\n` +
        `👤 Beneficiario: Planeo Spain\n\n` +
        `Mándame el comprobante cuando lo hayas transferido 🎉`;
      return {
        ok: true,
        accion: 'enviar_pago',
        mensaje: mensajePago,
        senal
      };
    }

    case 'avisar_humano': {
      return {
        ok: true,
        accion: 'avisar_humano',
        motivo: toolInput.motivo,
        respuesta_al_cliente: toolInput.respuesta_al_cliente
      };
    }

    case 'guardar_datos_cliente': {
      try {
        // MERGE en vez de sobrescribir: leemos lo que hay y combinamos.
        const convo = await getConversation(phone);
        const previo = convo.customer_data || {};
        const merged = { ...previo };
        // Solo sobrescribimos campos no nulos/vacíos del toolInput
        for (const [k, v] of Object.entries(toolInput)) {
          if (v !== null && v !== undefined && v !== '') {
            merged[k] = v;
          }
        }
        await updateConversation(phone, { customer_data: merged });
        return { ok: true, customer_data: merged };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    case 'cerrar_conversacion': {
      return {
        ok: true,
        accion: 'cerrar',
        razon: toolInput.razon
      };
    }

    default:
      return { ok: false, error: `Tool desconocida: ${toolName}` };
  }
}

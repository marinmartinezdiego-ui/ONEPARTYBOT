// Wrapper de Claude API con prompt caching, customer_data inyectado y resumen de historial

import { SYSTEM_PROMPT } from './prompt.js';
import { TOOLS } from './tools.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';

function selectModel(messages) {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || !lastMsg.content) return MODEL_SONNET;

  // El contenido puede ser string o array (cuando hay tool_result)
  let text = '';
  if (typeof lastMsg.content === 'string') {
    text = lastMsg.content;
  } else if (Array.isArray(lastMsg.content)) {
    text = lastMsg.content
      .filter(b => b.type === 'text' || b.type === 'tool_result')
      .map(b => b.type === 'text' ? b.text : (typeof b.content === 'string' ? b.content : ''))
      .join(' ');
  }
  text = text.toLowerCase();
  const normalized = text.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Haiku: mensajes muy cortos y simples (afirmaciones, saludos, agradecimientos)
  const haikuTriggers = [
    /^hola\b/, /^hey\b/, /^buenas\b/, /^buenos dias\b/, /^buenas tardes\b/,
    /^gracias\b/, /^vale\b/, /^ok\b/, /^okey\b/, /^genial\b/,
    /^perfecto\b/, /^muy bien\b/, /^estupendo\b/,
    /^si\b/, /^no\b/, /^claro\b/, /^correcto\b/,
    /^de acuerdo\b/, /^entendido\b/, /^anotado\b/
  ];
  if (text.length < 40 && haikuTriggers.some(re => re.test(normalized))) {
    return MODEL_HAIKU;
  }

  // Sonnet: cálculos, decisiones complejas, modificaciones, dinero
  const sonnetTriggers = [
    'precio', 'presupuesto', 'cuanto', 'cuánto', 'coste',
    'calcular', 'pagar', 'señal', 'reserva',
    'modificar', 'cambiar', 'cancelar',
    'añadir', 'apuntar', 'desapuntar',
    'comprobante', 'transferencia', 'descuento',
    'alergia', 'embarazada', 'niño', 'menor'
  ];
  if (sonnetTriggers.some(t => text.includes(t))) {
    return MODEL_SONNET;
  }

  return MODEL_SONNET;
}

/**
 * Construye los bloques de system: prompt estático (cacheado) + customer_data + resumen
 */
function buildSystemBlocks({ customerData, summary }) {
  const blocks = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' }
    }
  ];

  if (customerData && Object.keys(customerData).length > 0) {
    const lines = Object.entries(customerData)
      .filter(([_, v]) => v !== null && v !== undefined && v !== '' &&
        !(Array.isArray(v) && v.length === 0))
      .map(([k, v]) => `- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join('\n');
    if (lines) {
      blocks.push({
        type: 'text',
        text: `# DATOS YA RECOGIDOS DE ESTE CLIENTE\n${lines}\n\nUsa estos datos directamente. NO vuelvas a preguntar lo que ya tienes.`
      });
    }
  }

  if (summary && summary.trim().length > 0) {
    blocks.push({
      type: 'text',
      text: `# RESUMEN DE LA CONVERSACIÓN PREVIA\n${summary}`
    });
  }

  return blocks;
}

export async function callClaude(messages, options = {}) {
  const { customerData = {}, summary = null, forceModel = null } = options;

  const model = forceModel || selectModel(messages);

  const body = {
    model,
    max_tokens: 1024,
    system: buildSystemBlocks({ customerData, summary }),
    tools: TOOLS,
    messages
  };

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    raw: data,
    model,
    stopReason: data.stop_reason,
    content: data.content,
    usage: data.usage
  };
}

export function parseClaudeResponse(response) {
  const textBlocks = [];
  const toolUseBlocks = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      textBlocks.push(block.text);
    } else if (block.type === 'tool_use') {
      toolUseBlocks.push({
        id: block.id,
        name: block.name,
        input: block.input
      });
    }
  }

  return {
    text: textBlocks.join('\n\n').trim(),
    tools: toolUseBlocks
  };
}

/**
 * Resume una tanda de mensajes vía Haiku.
 * Si hay summary previo, lo integra para no perder contexto antiguo.
 */
export async function summarizeMessages(messages, previousSummary = null) {
  const flat = messages.map(m => {
    let content = '';
    if (typeof m.content === 'string') {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content
        .filter(b => b.type === 'text' || b.type === 'tool_use' || b.type === 'tool_result')
        .map(b => {
          if (b.type === 'text') return b.text;
          if (b.type === 'tool_use') return `[tool ${b.name}: ${JSON.stringify(b.input).slice(0, 200)}]`;
          if (b.type === 'tool_result') {
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            return `[result: ${c.slice(0, 200)}]`;
          }
          return '';
        })
        .join(' ');
    }
    return `${m.role.toUpperCase()}: ${content.slice(0, 500)}`;
  }).join('\n');

  const prompt = `Resume esta conversación de WhatsApp entre Diego (comercial de ONEPARTY, despedidas en Gandía) y un cliente.

El resumen debe capturar:
- Fecha de la despedida (si se mencionó)
- Número de personas
- Pack elegido (basic/mix/afull/afull_sin_actividad/afull_sin_comida/premium)
- Alojamiento elegido y duración
- Actividad/es, comida y cena elegidas
- Extras (copas_disco, mesa_vip)
- Presupuestos calculados
- Estado actual (eligiendo / confirmado / esperando pago / pagado)
- Peticiones especiales del cliente (alergias, parking, horarios, etc.)
- Nombre del cliente si lo dijo

${previousSummary ? `RESUMEN PREVIO (intégralo):\n${previousSummary}\n\nMENSAJES NUEVOS:\n` : 'MENSAJES:\n'}${flat}

Responde SOLO con el resumen, sin preámbulo. Máximo 250 palabras.`;

  try {
    const res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL_HAIKU,
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      console.error('Summary API error:', res.status, await res.text());
      return previousSummary || null;
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    return text.trim() || previousSummary || null;
  } catch (e) {
    console.error('Summary failed:', e.message);
    return previousSummary || null;
  }
}

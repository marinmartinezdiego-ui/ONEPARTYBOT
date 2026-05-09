// Wrapper de Claude API con prompt caching y selección dinámica de modelo

import { SYSTEM_PROMPT } from './prompt.js';
import { TOOLS } from './tools.js';

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';

/**
 * Decide qué modelo usar según el contexto del mensaje
 * Haiku para tareas simples, Sonnet para complejas
 */
function selectModel(messages, customerData) {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || !lastMsg.content) return MODEL_SONNET;
  
  const text = (typeof lastMsg.content === 'string' ? lastMsg.content : '').toLowerCase();
  
  // Normalizar para detectar palabras con/sin tildes
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  
  // Triggers para Haiku (tareas simples)
  const haikuTriggers = [
    /^hola\b/, /^hey\b/, /^buenas\b/,
    /^gracias/, /^vale\b/, /^ok\b/, /^genial\b/,
    /^perfecto\b/, /^muy bien\b/,
    /^si\b/, /^no\b/, /^claro\b/
  ];
  
  // Si el mensaje es muy corto y simple → Haiku
  if (text.length < 30 && haikuTriggers.some(re => re.test(normalized))) {
    return MODEL_HAIKU;
  }
  
  // Triggers que requieren Sonnet (cálculos, decisiones complejas)
  const sonnetTriggers = [
    'precio', 'presupuesto', 'cuanto', 'cuánto', 'coste',
    'calcular', 'pagar', 'señal', 'reserva',
    'modificar', 'cambiar', 'cancelar',
    'añadir', 'apuntar', 'desapuntar',
    'comprobante', 'transferencia'
  ];
  
  if (sonnetTriggers.some(t => text.includes(t))) {
    return MODEL_SONNET;
  }
  
  // Por defecto Sonnet (más fiable para conversación general)
  return MODEL_SONNET;
}

/**
 * Llama a Claude con prompt caching y tools
 * @param {Array} messages - Historial de mensajes
 * @param {object} options - { customerData, forceModel }
 */
export async function callClaude(messages, options = {}) {
  const { customerData = {}, forceModel = null } = options;
  
  const model = forceModel || selectModel(messages, customerData);
  
  const body = {
    model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' }
      }
    ],
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

/**
 * Extrae el contenido procesable de la respuesta de Claude
 * @returns {object} { textBlocks, toolUseBlocks }
 */
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

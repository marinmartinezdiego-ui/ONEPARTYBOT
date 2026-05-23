#!/usr/bin/env node
/**
 * test/conversations.test.mjs
 * ONEPARTY Bot — Regression Test Suite
 *
 * Llama a la API real de Claude (Sonnet 4.6 para el bot, Haiku para el juez).
 * NO toca Wassenger ni Supabase: las tools se mockean localmente.
 * calcular_presupuesto usa el pricing.js real (sin deps externas).
 *
 * Uso:
 *   ANTHROPIC_API_KEY=sk-... node test/conversations.test.mjs        # todos
 *   ANTHROPIC_API_KEY=sk-... node test/conversations.test.mjs TC01 TC09  # filtro
 *   npm run test:conversations
 */

import { callClaude, parseClaudeResponse } from '../lib/claude.js';
import { calcularPresupuesto, formatPresupuesto } from '../lib/pricing.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const MODEL_SONNET = 'claude-sonnet-4-6';

// ─────────────────────────────────────────────────────────────────────────────
// Mock tool executor — sin Supabase ni Wassenger
// ─────────────────────────────────────────────────────────────────────────────
function mockExecuteTool(name, input) {
  switch (name) {
    case 'calcular_presupuesto': {
      try {
        const p = calcularPresupuesto(input);
        return { ok: true, presupuesto: p, mensaje_formateado: formatPresupuesto(p) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    case 'enviar_imagen':
      return {
        ok: true,
        accion: 'enviar_imagen',
        url: `https://onepartybot.vercel.app/images/${input.tipo}.jpg`,
        tipo: input.tipo
      };
    case 'enviar_datos_pago':
      return {
        ok: true,
        accion: 'enviar_pago',
        mensaje: `💳 DATOS DE PAGO\n\nSeñal: ${Math.max(100, (input.personas || 10) * 10)}€\nIBAN: ES30 0182 2741 1702 0162 2342`,
        senal: Math.max(100, (input.personas || 10) * 10)
      };
    case 'avisar_humano':
      return {
        ok: true,
        accion: 'avisar_humano',
        motivo: input.motivo || '',
        respuesta_al_cliente: input.respuesta_al_cliente || ''
      };
    case 'guardar_datos_cliente':
      return { ok: true, customer_data: input };
    case 'cerrar_conversacion':
      return { ok: true, accion: 'cerrar', razon: input.razon || '' };
    default:
      return { ok: false, error: `Tool desconocida: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Haiku como juez semántico
// Responde PASS o FAIL + explicación breve
// ─────────────────────────────────────────────────────────────────────────────
async function judgeWithHaiku(userMessages, botResponse, toolsCalled, question) {
  const conv = userMessages
    .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');

  const toolsInfo = toolsCalled.length > 0
    ? `HERRAMIENTAS LLAMADAS: ${toolsCalled.map(t => `${t.name}(${JSON.stringify(t.input).slice(0, 120)})`).join(' | ')}`
    : 'HERRAMIENTAS LLAMADAS: ninguna';

  const prompt = `Eres un evaluador de calidad para un chatbot de WhatsApp de despedidas de soltero (ONEPARTY, Gandía, España). El bot se llama Diego y vende packs de despedidas.

CONVERSACIÓN DEL CLIENTE:
${conv}

RESPUESTA DEL BOT:
${botResponse || '[sin texto — solo llamó tools]'}

${toolsInfo}

PREGUNTA DE EVALUACIÓN: ${question}

Responde ÚNICAMENTE con "PASS" o "FAIL" seguido de máximo 20 palabras de explicación.`;

  const res = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL_HAIKU,
      max_tokens: 80,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    return { pass: false, reason: `Judge API error: ${err.slice(0, 100)}` };
  }

  const data = await res.json();
  const text = (data.content?.[0]?.text || '').trim();
  const pass = text.toUpperCase().startsWith('PASS');
  return { pass, reason: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ejecutar un caso de prueba
// ─────────────────────────────────────────────────────────────────────────────
async function runCase(tc) {
  const { id, description, messages, customerData = {}, assertions = {} } = tc;
  const allToolsCalled = []; // [{ name, input }]
  const allTexts = [];
  let currentMessages = messages.map(m => ({ ...m }));
  let apiError = null;

  try {
    for (let iter = 0; iter < 5; iter++) {
      const response = await callClaude(currentMessages, {
        customerData,
        forceModel: MODEL_SONNET
      });

      const parsed = parseClaudeResponse(response);
      if (parsed.text) allTexts.push(parsed.text);

      if (response.stopReason !== 'tool_use') break;

      currentMessages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const tool of parsed.tools) {
        allToolsCalled.push({ name: tool.name, input: tool.input });
        const result = mockExecuteTool(tool.name, tool.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result)
        });
      }
      currentMessages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    apiError = e.message;
  }

  const finalText = allTexts[allTexts.length - 1] || '';
  const toolNames = allToolsCalled.map(t => t.name);
  const failures = [];

  if (apiError) {
    failures.push(`API error: ${apiError}`);
  } else {
    // ── toolsCalled ─────────────────────────────────────────────────────────
    for (const expected of (assertions.toolsCalled || [])) {
      if (!toolNames.includes(expected)) {
        failures.push(`Tool "${expected}" no fue llamada. Llamadas: [${toolNames.join(', ') || 'ninguna'}]`);
      }
    }
    // ── toolsNotCalled ───────────────────────────────────────────────────────
    for (const notExpected of (assertions.toolsNotCalled || [])) {
      if (toolNames.includes(notExpected)) {
        failures.push(`Tool "${notExpected}" NO debería haberse llamado`);
      }
    }
    // ── toolCalledWith ───────────────────────────────────────────────────────
    for (const [toolName, expectedInput] of Object.entries(assertions.toolCalledWith || {})) {
      const call = allToolsCalled.find(t => t.name === toolName);
      if (!call) {
        failures.push(`Tool "${toolName}" no fue llamada (necesaria para verificar parámetros)`);
      } else {
        for (const [key, val] of Object.entries(expectedInput)) {
          if (call.input[key] !== val) {
            failures.push(`"${toolName}" llamada con ${key}=${JSON.stringify(call.input[key])}, esperado ${JSON.stringify(val)}`);
          }
        }
      }
    }
    // ── textContains ─────────────────────────────────────────────────────────
    const lowerText = finalText.toLowerCase();
    for (const expected of (assertions.textContains || [])) {
      if (!lowerText.includes(expected.toLowerCase())) {
        failures.push(`Respuesta debería contener: "${expected}"`);
      }
    }
    // ── textNotContains ──────────────────────────────────────────────────────
    for (const notExpected of (assertions.textNotContains || [])) {
      if (lowerText.includes(notExpected.toLowerCase())) {
        failures.push(`Respuesta NO debería contener: "${notExpected}"`);
      }
    }
    // ── Juez Haiku (solo si las hard assertions pasan) ───────────────────────
    if (assertions.judge && failures.length === 0) {
      const judgeResult = await judgeWithHaiku(messages, finalText, allToolsCalled, assertions.judge);
      if (!judgeResult.pass) {
        failures.push(`Juez: ${judgeResult.reason}`);
      }
    }
  }

  return {
    id,
    description,
    pass: failures.length === 0,
    failures,
    toolsCalled: toolNames,
    responsePreview: finalText.slice(0, 120).replace(/\n/g, ' ')
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌  Falta ANTHROPIC_API_KEY en el entorno.');
    console.error('    Ejecución: ANTHROPIC_API_KEY=sk-... npm run test:conversations\n');
    process.exit(1);
  }

  const filter = process.argv.slice(2); // e.g.: node test TC01 TC09
  const allCases = JSON.parse(readFileSync(join(__dirname, 'cases.json'), 'utf8'));
  const cases = filter.length > 0
    ? allCases.filter(c => filter.includes(c.id))
    : allCases;

  if (cases.length === 0) {
    console.error(`\n❌  Ningún caso coincide con el filtro: ${filter.join(', ')}\n`);
    process.exit(1);
  }

  console.log('\n🧪  ONEPARTY Bot — Regression Test Suite');
  console.log(`    Bot: ${MODEL_SONNET}  |  Juez: ${MODEL_HAIKU}`);
  console.log(`    Ejecutando ${cases.length} caso${cases.length !== 1 ? 's' : ''}\n`);

  const results = [];
  const startAll = Date.now();

  for (const tc of cases) {
    const start = Date.now();
    const shortDesc = tc.description.length > 56
      ? tc.description.slice(0, 56) + '…'
      : tc.description;
    process.stdout.write(`  [${tc.id}] ${shortDesc.padEnd(58)} `);

    const result = await runCase(tc);
    const ms = Date.now() - start;

    if (result.pass) {
      console.log(`✅ PASS  (${ms}ms)`);
    } else {
      console.log(`❌ FAIL  (${ms}ms)`);
      for (const f of result.failures) {
        console.log(`         → ${f}`);
      }
    }
    if (result.toolsCalled.length > 0) {
      console.log(`         Tools: [${result.toolsCalled.join(', ')}]`);
    }
    results.push(result);
  }

  const totalMs = Date.now() - startAll;
  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  console.log('\n' + '─'.repeat(72));
  console.log(`Resultado: ${passed}/${results.length} pasaron en ${(totalMs / 1000).toFixed(1)}s`);

  if (failed > 0) {
    console.log(`\nCasos fallidos (${failed}):`);
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  ❌ [${r.id}] ${r.description}`);
      for (const f of r.failures) {
        console.log(`       → ${f}`);
      }
    }
    process.exit(1);
  } else {
    console.log('\n✅  Todos los tests pasaron');
  }
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });

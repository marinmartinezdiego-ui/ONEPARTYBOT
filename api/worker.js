// Worker - procesa la cola de mensajes de un teléfono
// V3 - fire-and-forget compatible, chequeo de pausa mid-process, dedup de textos,
//      resumen de historial >20 mensajes, customer_data inyectado en system prompt.

import { drainQueue, acquireLock, releaseLock } from '../lib/upstash.js';
import { getConversation, saveConversation, log, saveUnknownQuestion } from '../lib/supabase.js';
import { sendText, sendImage, sendTyping, notifyHuman } from '../lib/wassenger.js';
import { callClaude, parseClaudeResponse, summarizeMessages } from '../lib/claude.js';
import { executeTool } from '../lib/tools.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const internalToken = req.headers['x-internal-token'];
  if (internalToken !== (process.env.INTERNAL_TOKEN || 'dev')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, deviceId } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'phone required' });
  }

  // Procesamos ANTES de responder. Vercel Serverless cierra la función
  // en cuanto envías el response, así que no podemos hacer trabajo después.
  // El webhook que nos llama tiene timeout 3s en su fetch hacia aquí, así
  // que aunque tardemos 15s en procesar, el webhook ya habrá respondido
  // 200 a Wassenger y nosotros seguimos vivos hasta acabar (maxDuration 60s).
  try {
    await processQueue(phone, deviceId);
  } catch (err) {
    console.error(`Error procesando cola de ${phone}:`, err);
    await log(phone, 'worker_error', { error: err.message }).catch(() => {});
  }

  return res.status(200).json({ ok: true });
}

function extractImagesFromMarkdown(text) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const imagesToSend = [];
  let match;
  while ((match = imageRegex.exec(text)) !== null) {
    imagesToSend.push(match[2]);
  }
  const cleanText = text
    .replace(imageRegex, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanText, imagesToSend };
}

/**
 * Devuelve true si dos textos son lo bastante parecidos como para considerarse duplicados.
 */
function isNearDuplicate(a, b) {
  const na = a.trim().toLowerCase().replace(/\s+/g, ' ');
  const nb = b.trim().toLowerCase().replace(/\s+/g, ' ');
  if (na === nb) return true;
  if (na.length < 20 || nb.length < 20) return false;
  // Si uno contiene >80% del otro, es duplicado
  const shorter = na.length < nb.length ? na : nb;
  const longer  = na.length < nb.length ? nb : na;
  return longer.includes(shorter);
}

async function processQueue(phone, deviceId) {
  // Pequeño delay para agrupar mensajes que llegan seguidos
  await new Promise(r => setTimeout(r, 1500));

  const gotLock = await acquireLock(phone, 60);
  if (!gotLock) {
    await log(phone, 'lock_busy', {});
    return;
  }

  try {
    const messages = await drainQueue(phone);
    if (messages.length === 0) {
      await log(phone, 'empty_queue', {});
      return;
    }

    await log(phone, 'processing', { count: messages.length });

    let convo = await getConversation(phone);

    // Re-chequeo defensivo: si la conversación fue pausada o cerrada
    // entre el encolado y el drenado, abortamos aquí.
    if (convo.closed) {
      await log(phone, 'closed_mid_process_aborted', {});
      return;
    }
    if (convo.paused_until && new Date(convo.paused_until) > new Date()) {
      await log(phone, 'paused_mid_process_aborted', { until: convo.paused_until });
      return;
    }

    const combinedText = messages.map(m => m.text).join('\n');
    const lastMsgId = messages[messages.length - 1].id;

    await sendTyping(phone, deviceId);

    convo.activated = true;
    convo.last_msg_id = lastMsgId;
    convo.messages = convo.messages || [];
    convo.messages.push({ role: 'user', content: combinedText });

    // Si el historial pasa de 20 mensajes, resumimos los antiguos.
    // Conservamos los últimos 10 frescos + resumen acumulado.
    if (convo.messages.length > 20) {
      const toSummarize = convo.messages.slice(0, -10);
      const newSummary = await summarizeMessages(toSummarize, convo.summary);
      if (newSummary) {
        convo.summary = newSummary;
      }
      convo.messages = convo.messages.slice(-10);
      await log(phone, 'history_summarized', { kept: convo.messages.length });
    }

    let response = await callClaude(convo.messages, {
      customerData: convo.customer_data,
      summary: convo.summary
    });
    await log(phone, 'claude_call', {
      model: response.model,
      stopReason: response.stopReason,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    });

    let parsed = parseClaudeResponse(response);
    let textsToSend = [];
    let imagesToSend = [];
    let actionsToDo = [];

    let iterations = 0;
    while (response.stopReason === 'tool_use' && iterations < 5) {
      iterations++;

      if (parsed.text) textsToSend.push(parsed.text);
      convo.messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const tool of parsed.tools) {
        await log(phone, 'tool_call', { name: tool.name, input: tool.input });
        const result = await executeTool(tool.name, tool.input, { phone, deviceId, customerMsg: combinedText });
        await log(phone, 'tool_result', { name: tool.name, ok: result.ok });

        if (result.accion === 'enviar_imagen') {
          imagesToSend.push(result.url);
        } else if (result.accion === 'enviar_pago') {
          textsToSend.push(result.mensaje);
        } else if (result.accion === 'avisar_humano') {
          actionsToDo.push({ type: 'avisar_humano', motivo: result.motivo, respuesta: result.respuesta_al_cliente });
        } else if (result.accion === 'cerrar') {
          actionsToDo.push({ type: 'cerrar' });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: tool.id,
          content: JSON.stringify(result)
        });
      }

      convo.messages.push({ role: 'user', content: toolResults });
      response = await callClaude(convo.messages, {
        customerData: convo.customer_data,
        summary: convo.summary
      });
      parsed = parseClaudeResponse(response);
    }

    if (parsed.text) textsToSend.push(parsed.text);
    if (response.content) {
      convo.messages.push({ role: 'assistant', content: response.content });
    }

    // --- Limpieza de textos -----------------------------------------------
    // 1) Extraer markdown de imágenes si Claude las metió en el texto
    const processedTexts = [];
    for (const text of textsToSend) {
      const { cleanText, imagesToSend: extracted } = extractImagesFromMarkdown(text);
      imagesToSend.push(...extracted);
      if (cleanText && cleanText.length > 0) processedTexts.push(cleanText);
    }
    textsToSend = processedTexts;

    // 2) Anti-saludo duplicado
    const previousAssistantMsgs = convo.messages.slice(0, -1).filter(m => m.role === 'assistant');
    const alreadyGreeted = previousAssistantMsgs.some(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return c.includes('Soy Diego de ONEPARTY');
    });
    textsToSend = textsToSend.map(t => {
      if (alreadyGreeted && t.includes('Soy Diego de ONEPARTY')) {
        return t.replace(/¡Hola!\s*🎉?\s*Soy Diego de ONEPARTY[^]*?(personas sois|sois)\s*🙌?\s*/i, '').trim();
      }
      return t;
    }).filter(t => t.length > 0);

    // 3) Eliminar URLs sueltas de imágenes en el texto
    textsToSend = textsToSend.map(t => {
      return t.replace(/https?:\/\/onepartydocs\.netlify\.app\/images\/[a-z-]+\.jpg/gi, '')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
    }).filter(t => t.length > 0);

    // 4) Dedup de textos idénticos o casi idénticos (anti-doble-mensaje)
    const dedupedTexts = [];
    for (const t of textsToSend) {
      if (!dedupedTexts.some(existing => isNearDuplicate(existing, t))) {
        dedupedTexts.push(t);
      } else {
        await log(phone, 'duplicate_text_dropped', { preview: t.slice(0, 80) }).catch(() => {});
      }
    }
    textsToSend = dedupedTexts;

    // 5) Dedup de imágenes
    const uniqueImages = [...new Set(imagesToSend)];

    // --- ANTES de enviar: recargar convo y comprobar si fue pausada ------
    // Esto cubre el caso de que Diego respondiera manualmente mientras
    // procesábamos (race condition con la pausa de webhook).
    const freshConvo = await getConversation(phone);
    if (freshConvo.closed) {
      await log(phone, 'closed_before_send_aborted', {});
      // Guardamos convo igualmente para no perder los mensajes del usuario
      await saveConversation({ ...convo, closed: true });
      return;
    }
    if (freshConvo.paused_until && new Date(freshConvo.paused_until) > new Date()) {
      await log(phone, 'paused_before_send_aborted', { until: freshConvo.paused_until });
      await saveConversation({ ...convo, paused_until: freshConvo.paused_until });
      return;
    }

    // --- Envío ------------------------------------------------------------
    for (const text of textsToSend) {
      const clean = text.replace(/\n{3,}/g, '\n\n').trim();
      if (clean) await sendText(phone, clean, deviceId);
    }

    for (const imageUrl of uniqueImages) {
      await sendImage(phone, imageUrl, deviceId);
    }

    for (const action of actionsToDo) {
      if (action.type === 'avisar_humano') {
        const pausedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        convo.paused_until = pausedUntil;
        await notifyHuman(action.motivo, phone, combinedText, deviceId);
        await log(phone, 'human_alerted', { motivo: action.motivo });
        // Guardar la pregunta en la tabla de "lagunas" para revisarla más tarde
        await saveUnknownQuestion({
          phone,
          customer_question: combinedText,
          motivo: action.motivo,
          conversation_context: convo.messages.slice(-6),
          customer_data: convo.customer_data || {}
        });
      } else if (action.type === 'cerrar') {
        convo.closed = true;
        await log(phone, 'closed', {});
      }
    }

    await saveConversation(convo);

  } finally {
    await releaseLock(phone);
  }
}

export const config = {
  maxDuration: 60
};

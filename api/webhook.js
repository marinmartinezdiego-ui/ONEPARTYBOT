// Worker - procesa la cola de mensajes de un teléfono
// Es atómico (un solo worker por teléfono a la vez gracias al lock)

import { drainQueue, acquireLock, releaseLock } from '../lib/upstash.js';
import { getConversation, saveConversation, log } from '../lib/supabase.js';
import { sendText, sendImage, sendTyping, notifyHuman } from '../lib/wassenger.js';
import { callClaude, parseClaudeResponse } from '../lib/claude.js';
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
  
  res.status(200).json({ ok: true });
  
  processQueue(phone, deviceId).catch(err => {
    console.error(`Error procesando cola de ${phone}:`, err);
    log(phone, 'worker_error', { error: err.message }).catch(() => {});
  });
}

async function processQueue(phone, deviceId) {
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
    
    const convo = await getConversation(phone);
    const combinedText = messages.map(m => m.text).join('\n');
    const lastMsgId = messages[messages.length - 1].id;
    
    await sendTyping(phone, deviceId);
    
    convo.activated = true;
    convo.last_msg_id = lastMsgId;
    convo.messages.push({ role: 'user', content: combinedText });
    
    if (convo.messages.length > 20) {
      convo.messages = convo.messages.slice(-20);
    }
    
    let response = await callClaude(convo.messages, { customerData: convo.customer_data });
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
      response = await callClaude(convo.messages, { customerData: convo.customer_data });
      parsed = parseClaudeResponse(response);
    }
    
    if (parsed.text) textsToSend.push(parsed.text);
    if (response.content) {
      convo.messages.push({ role: 'assistant', content: response.content });
    }
    
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
    
    for (const text of textsToSend) {
      const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
      if (cleanText) await sendText(phone, cleanText, deviceId);
    }
    
    for (const imageUrl of imagesToSend) {
      await sendImage(phone, imageUrl, deviceId);
    }
    
    for (const action of actionsToDo) {
      if (action.type === 'avisar_humano') {
        const pausedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        convo.paused_until = pausedUntil;
        await notifyHuman(action.motivo, phone, combinedText, deviceId);
        await log(phone, 'human_alerted', { motivo: action.motivo });
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

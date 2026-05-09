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
  
  // Responder rápido
  res.status(200).json({ ok: true });
  
  // Procesar en background
  processQueue(phone, deviceId).catch(err => {
    console.error(`Error procesando cola de ${phone}:`, err);
    log(phone, 'worker_error', { error: err.message }).catch(() => {});
  });
}

async function processQueue(phone, deviceId) {
  // Adquirir lock atómico (otros workers para este teléfono esperan)
  const gotLock = await acquireLock(phone, 60);
  if (!gotLock) {
    await log(phone, 'lock_busy', {});
    return; // Otro worker ya está procesando
  }
  
  try {
    // Vaciar la cola (atómico - obtiene todos los mensajes pendientes)
    const messages = await drainQueue(phone);
    if (messages.length === 0) {
      await log(phone, 'empty_queue', {});
      return;
    }
    
    await log(phone, 'processing', { count: messages.length });
    
    // Cargar conversación
    const convo = await getConversation(phone);
    
    // Combinar todos los mensajes pendientes en uno (si llegaron varios juntos)
    const combinedText = messages.map(m => m.text).join('\n');
    const lastMsgId = messages[messages.length - 1].id;
    
    // Indicador "escribiendo..."
    await sendTyping(phone, deviceId);
    
    // Marcar conversación como activada
    convo.activated = true;
    convo.last_msg_id = lastMsgId;
    
    // Añadir mensaje al historial
    convo.messages.push({ role: 'user', content: combinedText });
    
    // Limitar historial a 20 mensajes para evitar contexto enorme
    if (convo.messages.length > 20) {
      convo.messages = convo.messages.slice(-20);
    }
    
    // Llamar a Claude (con tools)
    let response = await callClaude(convo.messages, { customerData: convo.customer_data });
    await log(phone, 'claude_call', { 
      model: response.model, 
      stopReason: response.stopReason,
      inputTokens: response.usage?.input_tokens,
      outputTokens: response.usage?.output_tokens
    });
    
    // Procesar las tools que Claude haya querido usar (puede haber varias rondas)
    let parsed = parseClaudeResponse(response);
    let textsToSend = [];
    let imagesToSend = [];
    let actionsToDo = [];
    
    // Loop de tool use (hasta que Claude termine)
    let iterations = 0;
    while (response.stopReason === 'tool_use' && iterations < 5) {
      iterations++;
      
      // Guardar el texto que Claude haya generado en este turno
      if (parsed.text) textsToSend.push(parsed.text);
      
      // Añadir el turno del asistente al historial
      convo.messages.push({ role: 'assistant', content: response.content });
      
      // Ejecutar cada tool y construir los tool_results
      const toolResults = [];
      for (const tool of parsed.tools) {
        await log(phone, 'tool_call', { name: tool.name, input: tool.input });
        const result = await executeTool(tool.name, tool.input, { phone, deviceId, customerMsg: combinedText });
        await log(phone, 'tool_result', { name: tool.name, ok: result.ok });
        
        // Recolectar acciones para ejecutar al final
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
      
      // Añadir resultados al historial y volver a llamar a Claude
      convo.messages.push({ role: 'user', content: toolResults });
      
      response = await callClaude(convo.messages, { customerData: convo.customer_data });
      parsed = parseClaudeResponse(response);
    }
    
    // Texto final
    if (parsed.text) textsToSend.push(parsed.text);
    
    // Guardar respuesta del asistente al historial
    if (response.content) {
      convo.messages.push({ role: 'assistant', content: response.content });
    }
    
    // ANTI-DUPLICADO DE SALUDO: si ya saludamos antes y vuelve a salir el saludo, lo quitamos
    const previousAssistantMsgs = convo.messages
      .slice(0, -1)
      .filter(m => m.role === 'assistant');
    const alreadyGreeted = previousAssistantMsgs.some(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return content.includes('Soy Diego de ONEPARTY');
    });
    
    textsToSend = textsToSend.map(t => {
      if (alreadyGreeted && t.includes('Soy Diego de ONEPARTY')) {
        // Quitar el bloque del saludo
        return t.replace(/¡Hola!\s*🎉?\s*Soy Diego de ONEPARTY[^]*?(personas sois|sois)\s*🙌?\s*/i, '').trim();
      }
      return t;
    }).filter(t => t.length > 0);
    
    // Enviar mensajes en orden
    for (const text of textsToSend) {
      // Limpiar espacios múltiples
      const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
      if (cleanText) {
        await sendText(phone, cleanText, deviceId);
      }
    }
    
    // Enviar imágenes
    for (const imageUrl of imagesToSend) {
      await sendImage(phone, imageUrl, deviceId);
    }
    
    // Ejecutar acciones especiales
    for (const action of actionsToDo) {
      if (action.type === 'avisar_humano') {
        // Pausar bot por 2 horas
        const pausedUntil = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
        convo.paused_until = pausedUntil;
        await notifyHuman(action.motivo, phone, combinedText, deviceId);
        await log(phone, 'human_alerted', { motivo: action.motivo });
      } else if (action.type === 'cerrar') {
        convo.closed = true;
        await log(phone, 'closed', {});
      }
    }
    
    // Guardar conversación actualizada
    await saveConversation(convo);
    
  } finally {
    // Liberar lock siempre
    await releaseLock(phone);
  }
}

export const config = {
  maxDuration: 60
};

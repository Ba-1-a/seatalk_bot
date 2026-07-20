/**
 * src/utils.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Utility functions untuk SeaTalk API dan helper umum
 * 
 * Fitur:
 * - Extract incoming text dari berbagai format pesan
 * - Reply ke user SeaTalk (single chat & group chat)
 * - Send image via base64 ke SeaTalk
 * - Send webhook ke system account
 * - Smart chunking untuk pesan panjang
 */

import { createLogger, SERVICES } from './logger.js';

const log = createLogger(SERVICES.SEATALK);

/**
 * Strip @mention dan bot mention dari teks
 * @param {String} text - Teks input
 * @returns {String} Teks yang sudah dibersihkan
 */
export function stripMentions(text) {
  if (!text) return "";
  return text
    .replace(/@\w+/g, "") // Remove @username
    .replace(/\/{2,}/g, "/") // Remove double slash
    .trim();
}

/**
 * Deduplicate consecutive duplicate commands
 * @param {String} text - Teks input
 * @returns {String} Teks yang sudah di-clean
 */
export function deduplicateConsecutiveCommands(text) {
  if (!text) return "";
  const tokens = text.split(/\s+/);
  const cleaned = [];
  let lastCmd = null;
  
  for (const token of tokens) {
    if (/^\/(\w+)$/.test(token)) {
      if (token !== lastCmd) {
        cleaned.push(token);
        lastCmd = token;
      }
    } else {
      cleaned.push(token);
    }
  }
  
  return cleaned.join(" ").trim();
}

/**
 * Extract teks dari berbagai format pesan SeaTalk
 * @param {Object} message - Object pesan dari SeaTalk
 * @returns {String} Teks yang diekstrak
 */
export function extractIncomingText(message) {
  let incomingText = "";
  if (typeof message.text === "string") {
    incomingText = message.text;
  } else if (typeof message.text === "object" && message.text !== null) {
    incomingText = message.text.plain_text || message.text.content || "";
  } else if (typeof message.content === "string") {
    incomingText = message.content;
  }
  return incomingText.trim();
}

/**
 * Hitung jumlah kata dalam teks
 * @param {String} text - Teks yang akan dihitung
 * @returns {Number} Jumlah kata
 */
export function countWords(text) {
  return text.trim().split(/\s+/).length;
}

/**
 * Split pesan panjang menjadi chunk yang lebih kecil
 * @param {String} text - Teks yang akan di-split
 * @param {Number} limit - Batas karakter per chunk (default: 1500)
 * @returns {String[]} Array of chunks
 */
export function smartChunkMessage(text, limit = 1500) { 
  const paragraphs = text.split('\n');
  const chunks = [];
  let currentChunk = "";

  for (const p of paragraphs) {
    if ((currentChunk.length + p.length + 1) > limit) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = p; 
    } else {
      currentChunk += (currentChunk ? '\n' : '') + p;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  return chunks;
}

/**
 * Get atau refresh SeaTalk access token
 * @param {Object} env - Environment variables
 * @returns {String} Access token
 */
async function getSeaTalkToken(env) {
  const cacheKey = "seatalk_access_token";
  let token = await env.BOT_MEMORY.get(cacheKey);

  if (!token) {
    const tokenRes = await fetch("https://openapi.seatalk.io/auth/app_access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: env.SEATALK_APP_ID, app_secret: env.SEATALK_APP_SECRET })
    });
    
    const tokenData = await tokenRes.json();
    if (!tokenData.app_access_token) {
      log.error('Failed to obtain SeaTalk token', tokenData);
      throw new Error("Gagal autentikasi SeaTalk");
    }
    token = tokenData.app_access_token;
    await env.BOT_MEMORY.put(cacheKey, token, { expirationTtl: 7000 });
    log.debug('SeaTalk token obtained (new)');
  }
  
  return token;
}

/**
 * Kirim reply ke user SeaTalk
 * @param {Object} env - Environment variables
 * @param {String} messageText - Teks yang akan dikirim
 * @param {String} targetId - ID target (employee_code atau group_id)
 * @param {Boolean} isGroup - Apakah grup atau single chat
 * @param {String} threadId - ID thread (untuk reply di thread)
 * @param {String} originalMessageId - ID pesan original
 * @returns {Object} Response dari SeaTalk API
 */
export async function replyToUser(env, messageText, targetId, isGroup, threadId, originalMessageId) {
  const token = await getSeaTalkToken(env);

  const endpoint = isGroup 
    ? "https://openapi.seatalk.io/messaging/v2/group_chat" 
    : "https://openapi.seatalk.io/messaging/v2/single_chat";

  let body = isGroup ? { group_id: targetId } : { employee_code: targetId };
  body.message = { tag: "text", text: { content: messageText } };

  const threadReference = isGroup
    ? (threadId && threadId !== "" ? threadId : originalMessageId || undefined)
    : undefined;

  log.debug('Reply to user', {
    targetId,
    isGroup,
    textLen: messageText.length,
    threadReference
  });

  if (threadReference) {
    body.thread_id = threadReference;
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "Authorization": `Bearer ${token}` 
    },
    body: JSON.stringify(body)
  });

  const result = await resp.json();
  log.apiResponse('replyToUser', result.code || 0, { targetId, isGroup, threadReference });

  const messageId = result.message?.message_id || result.message_id || null;
  const responseThreadId = result.message?.thread_id || result.thread_id || messageId || null;

  if (result.code && result.code !== 0) {
    log.error('replyToUser failed', { targetId, isGroup, threadReference, result });
  }
  
  // Return message_id / thread_id untuk thread handling
  return {
    ...result,
    messageId,
    threadId: responseThreadId
  };
}

/**
 * Kirim webhook ke system account
 * @param {String} webhookUrl - URL webhook tujuan
 * @param {String} messageText - Teks yang akan dikirim
 */
export async function sendSystemWebhook(webhookUrl, messageText) {
  try {
    log.debug('Sending system webhook', { url: webhookUrl.substring(0, 60) });
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: "text",
        text: { content: messageText }
      })
    });
    log.debug('System webhook sent', { status: resp.status });
  } catch (error) {
    log.error('Failed to send system webhook', error);
  }
}

/**
 * Konversi ArrayBuffer ke base64 string
 * @param {ArrayBuffer} buffer - Buffer yang akan dikonversi
 * @returns {String} Base64 string
 */
export function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Kirim gambar ke user SeaTalk via base64 inline
 * Kirim gambar langsung sebagai base64 di message body (tanpa upload endpoint)
 * 
 * @param {Object} env - Environment variables
 * @param {ArrayBuffer} buffer - Buffer gambar (PNG)
 * @param {String} targetId - ID target
 * @param {Boolean} isGroup - Apakah grup
 * @param {String} threadId - ID thread
 * @param {String} originalMessageId - ID pesan original (fallback thread)
 * @returns {Object} Response dari SeaTalk API
 */
export async function sendScreenshotToUser(env, buffer, targetId, isGroup, threadId, originalMessageId) {
  try {
    // Konversi buffer ke base64
    const base64 = arrayBufferToBase64(buffer);
    log.info('Image converted to base64', { sizeBytes: buffer.byteLength, base64Len: base64.length });

    // Kirim pesan dengan base64 inline (SeaTalk API format)
    const token = await getSeaTalkToken(env);
    const endpoint = isGroup 
      ? "https://openapi.seatalk.io/messaging/v2/group_chat" 
      : "https://openapi.seatalk.io/messaging/v2/single_chat";

    const requestBase = isGroup 
      ? { group_id: targetId } 
      : { employee_code: targetId };

    const requestBody = {
      ...requestBase,
      message: {
        tag: "file",
        file: { content: base64, filename: "screenshot.png" }
      }
    };

    const threadReference = isGroup
      ? (threadId && threadId !== "" ? threadId : originalMessageId || undefined)
      : undefined;

    if (threadReference) {
      requestBody.thread_id = threadReference;
    }

    log.info('Sending image to SeaTalk', {
      targetId,
      isGroup,
      threadReference,
      base64Length: base64.length
    });

    const sendRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });

    const sendData = await sendRes.json();
    log.apiResponse('sendImage', sendData.code || 0, { targetId, isGroup, threadReference });

    if (sendData.code !== 0) {
      log.error('sendScreenshotToUser failed', { targetId, isGroup, threadReference, sendData });
      throw new Error("Gagal kirim gambar: code=" + sendData.code + " msg=" + sendData.message);
    }
    log.info('Image sent successfully', { targetId, isGroup, threadReference });

    return sendData;

  } catch (error) {
    log.error('Error in sendScreenshotToUser', error);
    throw error;
  }
}
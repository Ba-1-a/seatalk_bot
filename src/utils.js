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
      console.log("DEBUG: Gagal mendapatkan token SeaTalk", tokenData);
      throw new Error("Gagal autentikasi SeaTalk");
    }
    token = tokenData.app_access_token;
    await env.BOT_MEMORY.put(cacheKey, token, { expirationTtl: 7000 });
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

  if (isGroup) {
    if (threadId && threadId !== "") {
      body.thread_id = threadId;
    } else if (originalMessageId) {
      body.thread_id = originalMessageId; 
    }
  }

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { 
      "Content-Type": "application/json", 
      "Authorization": `Bearer ${token}` 
    },
    body: JSON.stringify(body)
  });

  return await resp.json();
}

/**
 * Kirim webhook ke system account
 * @param {String} webhookUrl - URL webhook tujuan
 * @param {String} messageText - Teks yang akan dikirim
 */
export async function sendSystemWebhook(webhookUrl, messageText) {
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: "text",
        text: { content: messageText }
      })
    });
  } catch (error) {
    console.log("DEBUG: Gagal mengirim webhook system account", error.message);
  }
}

/**
 * Konversi ArrayBuffer ke base64 string
 * @param {ArrayBuffer} buffer - Buffer yang akan dikonversi
 * @returns {String} Base64 string
 */
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Upload file ke SeaTalk Open API
 * @param {Object} env - Environment variables
 * @param {ArrayBuffer} buffer - Buffer file (PNG)
 * @param {String} filename - Nama file
 * @returns {String} file_key dari SeaTalk
 */
async function uploadFileToSeatalk(env, buffer, filename = "screenshot.png") {
  const token = await getSeaTalkToken(env);
  
  // Konversi ArrayBuffer ke Blob lalu ke File
  const uint8Array = new Uint8Array(buffer);
  const blob = new Blob([uint8Array], { type: "image/png" });
  
  // Gunakan FormData untuk upload
  const formData = new FormData();
  formData.append("file", blob, filename);

  const uploadRes = await fetch("https://openapi.seatalk.io/openapi/file/upload", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`
    },
    body: formData
  });

  const uploadData = await uploadRes.json();
  console.log("DEBUG: SeaTalk file upload response:", JSON.stringify(uploadData));

  if (!uploadData?.data?.file_key) {
    throw new Error("Gagal upload file ke SeaTalk: " + JSON.stringify(uploadData));
  }

  return uploadData.data.file_key;
}

/**
 * Kirim gambar ke user SeaTalk via file upload
 * Alur: Upload file -> Dapatkan file_key -> Kirim pesan dengan file_key
 * 
 * @param {Object} env - Environment variables
 * @param {ArrayBuffer} buffer - Buffer gambar (PNG)
 * @param {String} targetId - ID target
 * @param {Boolean} isGroup - Apakah grup
 * @param {String} threadId - ID thread
 * @returns {Object} Response dari SeaTalk API
 */
export async function sendScreenshotToUser(env, buffer, targetId, isGroup, threadId) {
  try {
    // 1. Upload file ke SeaTalk -> dapatkan file_key
    const fileKey = await uploadFileToSeatalk(env, buffer);
    console.log("DEBUG: file_key obtained:", fileKey);

    // 2. Kirim pesan dengan file_key
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
        tag: "image",
        file_key: fileKey
      }
    };

    if (isGroup && threadId && threadId !== "") {
      requestBody.thread_id = threadId;
    }

    console.log("DEBUG: Sending image with file_key:", { targetId, isGroup, fileKey });

    const sendRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });

    const sendData = await sendRes.json();
    console.log("DEBUG: SeaTalk send image response:", JSON.stringify(sendData));

    if (sendData.code !== 0) {
      throw new Error("Gagal kirim gambar: code=" + sendData.code + " msg=" + sendData.message);
    }

    return sendData;

  } catch (error) {
    console.error("DEBUG: Error di sendScreenshotToUser:", error.message);
    throw error;
  }
}

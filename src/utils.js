/**
 * src/utils.js
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

export function countWords(text) {
  return text.trim().split(/\s+/).length;
}

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

export async function replyToUser(env, messageText, targetId, isGroup, threadId, originalMessageId) {
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
      return null;
    }
    token = tokenData.app_access_token;
    await env.BOT_MEMORY.put(cacheKey, token, { expirationTtl: 7000 }); // Cache berlaku ~1.9 jam
  }

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

// FUNGSI PENGIRIMAN GAMBAR KE SEATALK VIA BASE64 (LEBIH AMAN & STABIL)
export async function sendScreenshotToUser(env, buffer, targetId, isGroup, threadId) {
  try {
    // 1. Ambil Token SeaTalk
    const cacheKey = "seatalk_access_token";
    let token = await env.BOT_MEMORY.get(cacheKey);

    if (!token) {
      const tokenRes = await fetch("https://openapi.seatalk.io/auth/app_access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: env.SEATALK_APP_ID, app_secret: env.SEATALK_APP_SECRET })
      });
      const tokenData = await tokenRes.json();
      token = tokenData.app_access_token;
      await env.BOT_MEMORY.put(cacheKey, token, { expirationTtl: 7000 });
    }

    // 2. Konversi Buffer (Gambar PNG) secara aman menjadi Base64
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Image = btoa(binary);

    // 3. Kirim base64 secara LANGSUNG sebagai pesan ke User/Grup
    const endpoint = isGroup 
      ? "https://openapi.seatalk.io/messaging/v2/group_chat" 
      : "https://openapi.seatalk.io/messaging/v2/single_chat";

    const requestBase = isGroup ? { group_id: targetId } : { employee_code: targetId };
    const messageVariants = [
      { tag: "image", image_base64: { content: base64Image } },
      { tag: "image", image: { base64: base64Image } },
      { tag: "image", image: { base64: base64Image, type: "image/png" } },
      { tag: "image", image: { content: base64Image } },
      { tag: "image", image: { content: base64Image, type: "image/png" } },
      { tag: "image", image_base64: base64Image },
      { tag: "image", image: { data: base64Image } },
      { tag: "image", image: { data: base64Image, type: "image/png" } },
      { tag: "image", image_base64: { data: base64Image } }
    ];

    let lastError = null;

    for (const variant of messageVariants) {
      const requestBody = { ...requestBase, message: variant };
      if (isGroup && threadId && threadId !== "") {
        requestBody.thread_id = threadId;
      }

      console.log("DEBUG: SeaTalk image request variant", {
        message: {
          tag: variant.tag,
          payloadType: variant.image ? "image" : "image_base64",
          contentLength: (variant.image?.base64 || variant.image?.content || variant.image_base64?.content || variant.image_base64 || "").length,
          hasType: Boolean(variant.image?.type)
        }
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
      if (sendData.code === 0) {
        return sendData;
      }

      console.log("DEBUG API SeaTalk Send Response:", sendData);
      lastError = sendData;

      if (sendData.code !== 4003 || typeof sendData.message !== "string" || !sendData.message.includes("Message cannot be empty")) {
        continue;
      }
    }

    throw new Error("Gagal mengirim pesan gambar: " + (lastError?.message || "Unknown error"));

  } catch (error) {
    console.error("DEBUG: Error di sendScreenshotToUser:", error.message);
    throw error;
  }
}
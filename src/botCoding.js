/**
 * src/botCoding.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Mengatur alur percakapan VA, Hybrid Memory, Auto-Threading, dan Intent Detection
 * 
 * Fitur:
 * - Chat dengan AI menggunakan Cloudflare Workers AI
 * - Hybrid Memory: simpan context ke KV, ringkas jika terlalu panjang
 * - Deteksi Google Sheets URL otomatis
 * - Intent Detection untuk natural language command (screenshot, dll)
 * - Auto-threading untuk jawaban panjang di grup
 * - Smart chunking untuk pesan panjang
 */

import { getAiReply, summarizeContext, AI_MODELS } from './aiHandler.js';
import { replyToUser, countWords, smartChunkMessage } from './utils.js';
import { silentReadSheetForAI, extractSpreadsheetId, handleScreenshotCommand } from './botSheet.js'; 

/**
 * Deteksi apakah user meminta screenshot dalam natural language
 * Support: "screenshot", "ss", "capture", "foto", "gambar sheet", "print screen", dll
 */
function detectScreenshotIntent(text) {
  const lower = text.toLowerCase().trim();
  
  // Pola positif: user MINTA screenshot
  const requestPatterns = [
    /^(bisa|tolong|minta|buatkan|ambilkan|coba|kak|bang)?\s*(screenshot|ss|screen.?shot|capture|print.?screen|prtscn|foto.?sheet|gambar.?sheet)/i,
    /(screenshot|ss|screen.?shot)\s+(gsheet|spreadsheet|sheet|google.?sheet|dokumen)/i,
    /(minta|buat|ambil|kirim)\s+(screenshot|ss|gambar|foto)/i,
    /^screenshot/i,
    /^ss\b/i,
  ];

  // Pola negatif: user MENJELASKAN cara screenshot (bukan minta)
  // NOTA: "bisa screenshot" TANPA tambahan konteks mengarah ke capability question
  // Tapi "bisa screenshot gsheet?" dengan "gsheet" sebaiknya dianggap request
  const negativePatterns = [
    // "bisa screenshot?" SAJA tanpa kata kunci spreadsheet -> capability question
    /^(bisa|dapat|mampu)\s+(screenshot|mengambil\s+screenshot)\s*\??$/i,
    /(cara|bagaimana|langkah|tutorial|petunjuk)/i,
    /(tombol|keyboard|prtscn|print.?screen)/i,
    /(browser|aplikasi|perangkat)/i,
    /(paint|photoshop|pengeditan)/i,
    /(ctrl.?\+.?v|paste)/i,
  ];

  // Cek negatif dulu
  for (const negPat of negativePatterns) {
    if (negPat.test(lower)) return false;
  }

  // Cek positif
  for (const pat of requestPatterns) {
    if (pat.test(lower)) return true;
  }

  return false;
}

/**
 * Handler untuk chat umum (bukan command)
 * @param {Object} env - Environment variables
 * @param {String} targetId - ID target (employee_code atau group_id)
 * @param {String} text - Teks pesan
 * @param {Boolean} isGroup - Apakah grup
 * @param {String} threadId - ID thread
 * @param {String} originalMessageId - ID pesan original
 */
export async function handleGeneralChat(env, targetId, text, isGroup, threadId, originalMessageId) {
  try {
    // ================================================================
    // INTENT DETECTION: Deteksi natural language command
    // ================================================================
    
    // 0a. Deteksi intent screenshot dari natural language
    if (detectScreenshotIntent(text)) {
      console.log(`DEBUG: Screenshot intent detected in text: "${text.substring(0, 50)}..."`);
      
      // Cek apakah user punya default sheet
      const defaultSheetId = await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
      
      if (defaultSheetId) {
        // Ada sheet default, langsung ambil screenshot
        // Format ulang argumen: ambil kata selain kata kunci screenshot
        const cleanedText = text.replace(/^(bisa|tolong|minta|buatkan|ambilkan|coba|kak|bang)?\s*(screenshot|ss|screen.?shot|capture|print.?screen|foto.?sheet|gambar.?sheet|gambar)\s*/i, '/screenshot ').trim();
        
        // Jika hasil pembersihan cuma "/screenshot" tanpa argumen tambahan, 
        // kita gunakan sheet default langsung
        if (cleanedText === '/screenshot' || cleanedText === '/screenshot ') {
          await handleScreenshotCommand(env, targetId, `/screenshot ${defaultSheetId}`, isGroup, threadId, originalMessageId);
        } else {
          await handleScreenshotCommand(env, targetId, cleanedText, isGroup, threadId, originalMessageId);
        }
        return;
      } else {
        // Tidak ada sheet default, beri tahu user cara set
        await replyToUser(env, "📸 Saya bisa screenshot spreadsheet!\n\n" +
          "Tapi belum ada sheet yang disimpan. Silakan:\n" +
          "1. Set sheet dulu: `/setsheet <url_google_sheets>`\n" +
          "2. Screenshot: `/screenshot` (pakai sheet default)\n" +
          "Atau langsung: `/screenshot <url_sheet> [tab] [range]`", 
          targetId, isGroup, threadId, originalMessageId);
        return;
      }
    }

    const kvKey = `memory_${targetId}`;
    let session = { contextNote: "", history: [], sheetContext: "", sheetUrl: "" };

    // 1. Ambil sesi yang tersimpan dari Cloudflare KV
    try {
      const rawMem = await env.BOT_MEMORY.get(kvKey);
      if (rawMem) {
        session = JSON.parse(rawMem);
      }
    } catch (e) {
      console.log("DEBUG: Memori baru dimulai atau gagal parse KV.");
    }

    // 2. Ringkas riwayat percakapan lama jika melebihi batas 6 pesan
    if (session.history.length >= 6) {
      session.contextNote = await summarizeContext(env, session.contextNote, session.history);
      session.history = []; 
    }

    // 3. Deteksi apakah pesan saat ini mengandung link Google Sheets baru
    const sheetId = extractSpreadsheetId(text);
    if (sheetId) {
      const newSheetContext = await silentReadSheetForAI(env, sheetId, "");

      if (newSheetContext) {
        // Tangani error autentikasi
        if (newSheetContext.startsWith("[ERROR_")) {
          const rawError = newSheetContext.replace("[ERROR_AUTH]", "").replace("[ERROR_API]", "").replace("[ERROR_ACCESS]", "").trim();
          await replyToUser(env, `⚠️ **VASA - Info Error:**\n\nDetail: ${newSheetContext}\n\nPeriksa log untuk info lengkap.`, targetId, isGroup, threadId, originalMessageId);          
          return;
        }

        session.sheetContext = newSheetContext;
        const urlRegex = /(https:\/\/docs\.google\.com\/spreadsheets\/d\/[a-zA-Z0-9-_]+[^\s]*)/;
        const match = text.match(urlRegex);
        if (match) session.sheetUrl = match[1];
      }
    }

    // 4. Masukkan pesan user ke dalam riwayat
    session.history.push({ role: "user", content: text });

    // 5. Susun System Prompt - beri tahu AI tentang kemampuan screenshot
    let systemPrompt = "Kamu adalah VASA, asisten operasional cerdas di SOC Arjawinangun. Jawab dengan ramah, profesional, ringkas, dan solutif.";
    systemPrompt += "\n\nKAMU BISA MELAKUKAN screenshot spreadsheet secara otomatis! Jika user minta screenshot, arahkan mereka untuk menggunakan perintah /screenshot (atau mereka bisa bilang 'screenshot dong' secara natural).";
    
    if (session.contextNote) systemPrompt += `\n\n[CATATAN INGATAN]:\n${session.contextNote}`;
    
    if (session.sheetContext) {
      systemPrompt += `\n\n[DATA SPREADSHEET]:\n${session.sheetContext}`;
    }

    // 6. Jalankan model AI
    const reply = await getAiReply(env, systemPrompt, session.history, AI_MODELS.CHAT_GENERAL);
    
    // 7. Simpan balasan ke KV
    session.history.push({ role: "assistant", content: reply });
    await env.BOT_MEMORY.put(kvKey, JSON.stringify(session), { expirationTtl: 3600 });

    // 8. Auto-threading untuk jawaban panjang di grup
    const wordCount = countWords(reply);
    const chunks = smartChunkMessage(reply);
    
    if (wordCount > 20 && isGroup) {
      const initResp = await replyToUser(env, "Aku balas di thread ya! 👇", targetId, isGroup, threadId, originalMessageId);
      const newThreadId = initResp?.message?.message_id || originalMessageId;
      for (const chunk of chunks) await replyToUser(env, chunk, targetId, isGroup, newThreadId, null);
    } else {
      for (const chunk of chunks) await replyToUser(env, chunk, targetId, isGroup, threadId, originalMessageId);
    }

  } catch (err) {
    console.log("DEBUG: Error di handleGeneralChat:", err.message);
  }
}
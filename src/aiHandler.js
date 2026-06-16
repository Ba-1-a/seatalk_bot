/**
 * src/aiHandler.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Manajemen Multi-Model Cloudflare Workers AI
 * 
 * Fitur:
 * - Chat AI menggunakan Cloudflare Workers AI
 * - Hybrid Memory: ringkasan percakapan lama
 * - Support multiple model (gratis via CF Workers)
 */

import { createLogger, SERVICES } from './logger.js';

const log = createLogger(SERVICES.AI);

// Katalog Model AI yang digunakan (Gratis via CF Workers)
export const AI_MODELS = {
  CHAT_GENERAL: '@cf/meta/llama-4-scout-17b-16e-instruct',  // Model utama yang pintar dan ramah
  SUMMARY_FAST: '@cf/meta/llama-4-scout-17b-16e-instruct',      // Model sangat ringan khusus untuk merangkum
  CODING_LOGIC: '@cf/meta/llama-4-scout-17b-16e-instruct'     // (Opsional) jika butuh model khusus logika/koding
};

/**
 * Fungsi Utama Chat AI
 * @param {Object} env - Environment variables
 * @param {String} systemPrompt - System prompt untuk AI
 * @param {Array} history - Riwayat percakapan
 * @param {String} model - Model AI yang digunakan
 * @returns {String} Response dari AI
 */
export async function getAiReply(env, systemPrompt, history, model = AI_MODELS.CHAT_GENERAL) {
  try {
    const aiResponse = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt }, 
        ...history
      ],
      max_tokens: 1500 // Ditingkatkan untuk menampung data spreadsheet
    });
    log.debug('AI reply received', { model, responseLen: (aiResponse.response || '').length });
    return aiResponse.response || "Maaf, sistem AI tidak memberikan respon.";
  } catch (err) {
    log.error('AI Handler error', { model, error: err.message });
    return "Maaf, konekeksi ke jaringan AI sedang sibuk. Mohon coba lagi.";
  }
}

/**
 * Hybrid Memory: Meringkas percakapan lama menjadi Context Note
 * @param {Object} env - Environment variables
 * @param {String} currentContext - Context saat ini
 * @param {Array} oldHistory - Riwayat percakapan lama
 * @returns {String} Ringkasan context
 */
export async function summarizeContext(env, currentContext, oldHistory) {
  try {
    const historyText = oldHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Buatlah ringkasan singkat maksimal 2 kalimat dari percakapan berikut untuk dijadikan catatan ingat VA. \nCatatan sebelumnya: ${currentContext || 'Belum ada'}\nPercakapan baru:\n${historyText}`;

    const summaryResponse = await env.AI.run(AI_MODELS.SUMMARY_FAST, {
      messages: [
        { role: "system", content: "Kamu adalah asisten perangkum memori. Jawab HANYA dengan ringkasan padat." },
        { role: "user", content: prompt }
      ]
    });
    log.debug('Context summarized', { model: AI_MODELS.SUMMARY_FAST });
    return summaryResponse.response || currentContext;
  } catch (err) {
    log.error('Summarize error', err);
    return currentContext; // Jika gagal, tetap gunakan context lama
  }
}
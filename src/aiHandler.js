/**
 * src/aiHandler.js
 * Manajemen Multi-Model Cloudflare Workers AI.
 */

// Katalog Model AI yang digunakan (Gratis via CF Workers)
export const AI_MODELS = {
  CHAT_GENERAL: '@cf/meta/llama-4-scout-17b-16e-instruct',  // Model utama yang pintar dan ramah
  SUMMARY_FAST: '@cf/meta/llama-4-scout-17b-16e-instruct',      // Model sangat ringan khusus untuk merangkum
  CODING_LOGIC: '@cf/meta/llama-4-scout-17b-16e-instruct'     // (Opsional) jika butuh model khusus logika/koding
};

// Fungsi Utama Chat AI
export async function getAiReply(env, systemPrompt, history, model = AI_MODELS.CHAT_GENERAL) {
  try {
    const aiResponse = await env.AI.run(model, {
      messages: [
        { role: "system", content: systemPrompt }, 
        ...history
      ],
      max_tokens: 1500 // Ditingkatkan untuk menampung data spreadsheet
    });
    return aiResponse.response || "Maaf, sistem AI tidak memberikan respon.";
  } catch (err) {
    console.log(`DEBUG: Error AI Handler (${model}):`, err.message);
    return "Maaf, koneksi ke jaringan AI sedang sibuk. Mohon coba lagi.";
  }
}

// Fungsi Hybrid Memory: Meringkas percakapan lama menjadi Context Note
export async function summarizeContext(env, currentContext, oldHistory) {
  try {
    const historyText = oldHistory.map(m => `${m.role}: ${m.content}`).join('\n');
    const prompt = `Buatlah ringkasan singkat maksimal 2 kalimat dari percakapan berikut untuk dijadikan catatan ingatan VA. \nCatatan sebelumnya: ${currentContext || 'Belum ada'}\nPercakapan baru:\n${historyText}`;

    const summaryResponse = await env.AI.run(AI_MODELS.SUMMARY_FAST, {
      messages: [
        { role: "system", content: "Kamu adalah asisten perangkum memori. Jawab HANYA dengan ringkasan padat." },
        { role: "user", content: prompt }
      ]
    });
    return summaryResponse.response || currentContext;
  } catch (err) {
    console.log(`DEBUG: Error Summarize:`, err.message);
    return currentContext; // Jika gagal, tetap gunakan context lama
  }
}
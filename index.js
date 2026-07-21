/**
 * index.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Cloudflare Worker sebagai Event Callback & Cron Executor
 * 
 * ARSITEKTUR (BYPASS MEMORI):
 * - Cloudflare Workers = GERBANG UTAMA (Event Callback SeaTalk)
 * - HF Spaces = Centralized Rendering API (PDF → PNG)
 * - Supabase = Database (cadangan untuk log/channel config)
 * 
 * ALUR SCREENSHOT (ASYNC - NO VERCEL):
 * 1. Worker generate Google Sheet export URL (TIDAK download PDF)
 * 2. Get Google OAuth token (untuk private sheets)
 * 3. Kirim message "Memproses..." ke SeaTalk (sync)
 * 4. ctx.waitUntil() untuk background task:
 *    - POST ke HF Spaces dengan sheet_url + google_access_token
 *    - HF Spaces download PDF, render PNG, return binary
 *    - Worker kirim PNG ke SeaTalk
 * 5. Worker langsung return 200 (tidak tunggu HF Spaces)
 * 
 * KEUNTUNGAN:
 * - Tidak ada Vercel dependency
 * - Tidak ada Base64 PDF encoding (hemat bandwidth)
 * - Tidak ada CF Worker timeout (30 detik)
 * - Private sheets supported (Google auth transfer)
 * 
 * Fitur:
 * - Webhook callback untuk SeaTalk dengan seatalk_challenge handler
 * - Routing command ke handler masing-masing
 * - Cron job scheduler untuk laporan otomatis
 * - Deduplication via message_id untuk cegah retry duplikasi
 */

import { handleGeneralChat } from './src/botCoding.js';
import { extractIncomingText, sendSystemWebhook, replyToUser, stripMentions, deduplicateConsecutiveCommands } from './src/utils.js';
import { getHourlyReportData, handleInventoryQuery, handleSetSheet, handleReadSheet, handleScreenshotCommand } from './src/botSheet.js';
import { createLogger, SERVICES, getLogFileInfo } from './src/logger.js';

const log = createLogger(SERVICES.CORE);

// ============================================================
// DEDUPLICATION CACHE
// ============================================================

/**
 * Cek apakah message_id sudah diproses (cegah duplikasi retry SeaTalk)
 * SeaTalk punya retry mechanism: jika tidak dapat 200 dalam ~5 detik, retry 5x
 * Karena screenshot butuh 30+ detik, kita pakai dedup key:
 * - Set dedup key SEBELUM proses screenshot
 * - SeaTalk retry → dedup cek → sudah ada → return 200 segera
 * 
 * @param {Object} env - Environment variables
 * @param {String} messageId - SeaTalk message_id
 * @returns {Boolean} true jika sudah diproses (skip), false jika belum
 */
async function isDuplicateMessage(env, messageId) {
  if (!messageId) return false;
  const dedupKey = `dedup_msg_${messageId}`;
  const existing = await env.BOT_MEMORY.get(dedupKey);
  if (existing) {
    log.info('Duplicate message detected via dedup key, skipping', { messageId });
    return true;
  }
  // Tahan selama 180 detik (cukup untuk proses screenshot + retry window)
  await env.BOT_MEMORY.put(dedupKey, '1', { expirationTtl: 180 });
  return false;
}

export default {
  // 1. GERBANG MASUK CHAT (WEBHOOK SEATALK)
  async fetch(request, env, ctx) {
    const reqId = crypto.randomUUID().slice(0, 8);
    const reqLog = log.child({ reqId });

    if (request.method !== "POST") return new Response("Bot Active", { status: 200 });

    try {
      // Validate required secrets on every request (fail fast)
      const missingSecrets = [];
      if (!env.SEATALK_APP_ID) missingSecrets.push('SEATALK_APP_ID');
      if (!env.SEATALK_APP_SECRET) missingSecrets.push('SEATALK_APP_SECRET');
      if (!env.GOOGLE_PRIVATE_KEY) missingSecrets.push('GOOGLE_PRIVATE_KEY');
      if (!env.GOOGLE_CLIENT_EMAIL) missingSecrets.push('GOOGLE_CLIENT_EMAIL');
      if (missingSecrets.length > 0) {
        reqLog.error('Missing required secrets', { missing: missingSecrets });
        return new Response(JSON.stringify({ error: 'Server misconfigured', missing: missingSecrets }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }

      const payload = await request.json();
      const event = payload.event || {};

      // Handle seatalk_challenge untuk verifikasi webhook
      if (payload.event_type === "event_verification") {
        reqLog.info('Webhook verification challenge');
        return new Response(JSON.stringify({ "seatalk_challenge": event.seatalk_challenge }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      const message = event.message || {};
      const senderId = event.employee_code || "";
      const groupId = event.group_id || "";
      const isGroup = !!groupId;
      const targetId = isGroup ? groupId : senderId;
      const threadId = message.thread_id || "";
      const messageId = message.message_id || "";

      let incomingText = extractIncomingText(message);
      if (!incomingText) return new Response("OK", { status: 200 });

      // FIX: Clean up incoming text - strip @mention, deduplicate commands
      incomingText = stripMentions(incomingText);
      incomingText = deduplicateConsecutiveCommands(incomingText);

      // Cek deduplikasi: jika message_id sudah diproses, skip
      // Ini penting karena screenshot synchronous bisa menyebabkan SeaTalk timeout dan retry
      if (messageId) {
        const isDup = await isDuplicateMessage(env, messageId);
        if (isDup) {
          return new Response("OK", { status: 200 }); // Acknowledge tapi skip proses
        }
      }

      reqLog.info('Incoming message', { senderId, groupId, isGroup, messageId, text: incomingText.substring(0, 80) });

      // ================================================================
      // ROUTING: Semua command diproses SYNCHRONOUS
      // ================================================================
      // Tidak ada isSlowCommand / ctx.waitUntil karena:
      // 1. ctx.waitUntil dibatasi 15 detik (tidak cukup untuk screenshot 25-35 detik)
      // 2. Dedup key sudah handle SeaTalk retry (request masuk 1x, retry dicegah)
      // 3. Worker free tier bisa jalan 30 detik (cukup untuk screenshot)
      // 4. AI chat cepat (<5 detik) jadi aman synchronous
      //
      // ALUR:
      // 1. User kirim /screenshot
      // 2. Dedup key di-set (line 106-109)
      // 3. Worker proses screenshot (25-35 detik)
      // 4. Selama proses, SeaTalk timeout (5 detik) dan retry 5x
      // 5. Setiap retry → dedup cek → sudah ada → return 200 segera
      // 6. Worker selesai screenshot → reply terkirim ke user
      // 7. SeaTalk puas dengan response 200 dari retry

      if (incomingText.includes("/inventory") || incomingText.startsWith("/inventory")) {
        reqLog.info('Routing → /inventory');
        await handleInventoryQuery(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.includes("/setsheet") || incomingText.startsWith("/setsheet")) {
        reqLog.info('Routing → /setsheet');
        await handleSetSheet(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.includes("/readsheet") || incomingText.startsWith("/readsheet")) {
        reqLog.info('Routing → /readsheet');
        await handleReadSheet(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.includes("/screenshot")) {
        reqLog.info('Routing → /screenshot');
        await handleScreenshotCommand(env, targetId, incomingText, isGroup, threadId, messageId, ctx);
      } else {
        reqLog.info('Routing → /general-chat (AI)');
        // AI chat cepat (<5 detik), aman synchronous
        await handleGeneralChat(env, targetId, incomingText, isGroup, threadId, messageId, ctx);
      }

      reqLog.info('Request completed');
      return new Response("OK", { status: 200 });
      
    } catch (err) {
      reqLog.error('Worker error', err);
      return new Response("Error", { status: 500 });
    }
  },

  // 2. CRON JOBS
  async scheduled(event, env, ctx) {
    const cronLog = log.child({ cron: true });
    try {
      const now = new Date();
      const currentMinute = now.toLocaleString("en-US", { timeZone: "Asia/Jakarta", minute: "numeric" });
      const targetMinute = parseInt(currentMinute, 10);

      const rawJobs = await env.BOT_MEMORY.get("cron_jobs");
      if (!rawJobs) return;
      
      const cronJobs = JSON.parse(rawJobs);
      
      // Cari jadwal yang menitnya cocok dengan menit saat ini
      const jobsToRun = cronJobs.filter(job => job.minute === targetMinute);

      if (jobsToRun.length > 0) {
        cronLog.info(`Running ${jobsToRun.length} cron jobs at minute ${targetMinute}`, { jobCount: jobsToRun.length, targetMinute });
        
        // Ambil data laporan dari GSheets via modul botSheet
        const reportText = await getHourlyReportData(env);
        
        // Eksekusi semua tembakan webhook secara paralel
        await Promise.all(
          jobsToRun.map(job => sendSystemWebhook(job.webhookUrl, reportText))
        );
        cronLog.info(`Cron jobs completed`, { sent: jobsToRun.length });
      }
    } catch (err) {
      cronLog.error('Cron error', err);
    }
  }
};
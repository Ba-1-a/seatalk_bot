/**
 * index.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Cloudflare Worker sebagai Event Callback & Cron Executor
 * 
 * ARSITEKTUR:
 * - Cloudflare Workers = GERBANG UTAMA (Event Callback SeaTalk)
 * - Vercel = Helper PDF-to-PNG (puppeteer) - endpoint /api/pdf-to-png
 * - Supabase = Database (cadangan untuk log/channel config)
 * 
 * ALUR SCREENSHOT (TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Kirim PDF ke Vercel endpoint /api/pdf-to-png untuk di-convert ke PNG
 * 3. Kirim PNG ke SeaTalk via base64
 * 
 * PERBAIKAN KELEMAHAN:
 * - ctx.waitUntil(): Respon 200 segera, proses screenshot di background (cegah retry duplikasi)
 * - Deduplikasi message_id: Cegah pemrosesan ulang saat SeaTalk retry
 * - Custom range export via parameter r1,c1,r2,c2 (bukan full sheet)
 * 
 * Fitur:
 * - Webhook callback untuk SeaTalk dengan seatalk_challenge handler
 * - Routing command ke handler masing-masing
 * - Cron job scheduler untuk laporan otomatis
 * - Background processing via ctx.waitUntil untuk operasi lambat
 * - Deduplication via message_id untuk cegah retry duplikasi
 */

import { handleGeneralChat } from './src/botCoding.js';
import { extractIncomingText, sendSystemWebhook, replyToUser } from './src/utils.js';
import { getHourlyReportData, handleInventoryQuery, handleSetSheet, handleReadSheet, handleScreenshotCommand } from './src/botSheet.js';
import { createLogger, SERVICES, getLogFileInfo } from './src/logger.js';

const log = createLogger(SERVICES.CORE);

// ============================================================
// DEDUPLICATION CACHE
// ============================================================

/**
 * Cek apakah message_id sudah diproses (cegah duplikasi retry SeaTalk)
 * SeaTalk punya retry mechanism: jika tidak dapat 200 dalam ~5 detik, retry 5x
 * Karena screenshot butuh 30+ detik, kita pakai ctx.waitUntil() + dedup
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
  // Tahan selama 120 detik (cukup untuk proses screenshot)
  await env.BOT_MEMORY.put(dedupKey, '1', { expirationTtl: 120 });
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

      const incomingText = extractIncomingText(message);
      if (!incomingText) return new Response("OK", { status: 200 });

      // Cek deduplikasi: jika message_id sudah diproses, skip
      if (messageId) {
        const isDup = await isDuplicateMessage(env, messageId);
        if (isDup) {
          return new Response("OK", { status: 200 }); // Acknowledge tapi skip proses
        }
      }

      reqLog.info('Incoming message', { senderId, groupId, isGroup, messageId, text: incomingText.substring(0, 80) });

      // ================================================================
      // STRATEGI ctx.waitUntil() UNTUK CEGAH DUPLIKASI RETRY SEATALK
      // ================================================================
      // SeaTalk punya retry mechanism: jika worker tidak merespon 200
      // dalam ~5 detik, SeaTalk akan kirim ulang event (hingga 5x).
      // Screenshot membutuhkan waktu 15-60 detik (export PDF + Vercel convert).
      // 
      // Solusi: Untuk command yang lambat (screenshot), kita:
      // 1. Kirim response 200 segera ("OK")
      // 2. Proses di background via ctx.waitUntil()
      // 3. CEGAH DUPLIKASI via dedup key (message_id)
      //
      // Command cepat (text reply) tetap diproses synchronous.

      const isSlowCommand = incomingText.startsWith("/screenshot");

      if (isSlowCommand) {
        // ================================================================
        // SLOW COMMAND: Background processing via ctx.waitUntil()
        // ================================================================
        // Response 200 segera, proses screenshot di background
        // Ini mencegah SeaTalk timeout dan retry duplikasi
        
        // Kirim response 200 segera
        const response = new Response("OK", { status: 200 });
        
        // Proses screenshot di background
        ctx.waitUntil((async () => {
          try {
            reqLog.info('Background: Starting screenshot processing');
            
            // Eksekusi screenshot (processing message dikirim oleh handleScreenshotCommand)
            await handleScreenshotCommand(env, targetId, incomingText, isGroup, threadId, messageId);
            
            reqLog.info('Background: Screenshot processing completed');
          } catch (err) {
            reqLog.error('Background: Screenshot processing failed', err);
          }
        })());
        
        return response;
      } else {
        // ================================================================
        // FAST COMMAND: Synchronous processing
        // ================================================================
        // Command yang cepat (text reply) diproses langsung
        
        if (incomingText.startsWith("/inventory")) {
          reqLog.info('Routing → /inventory');
          await handleInventoryQuery(env, targetId, incomingText, isGroup, threadId, messageId);
        } else if (incomingText.startsWith("/setsheet")) {
          reqLog.info('Routing → /setsheet');
          await handleSetSheet(env, targetId, incomingText, isGroup, threadId, messageId);
        } else if (incomingText.startsWith("/readsheet")) {
          reqLog.info('Routing → /readsheet');
          await handleReadSheet(env, targetId, incomingText, isGroup, threadId, messageId);
        } else if (incomingText.startsWith("/screenshot")) {
          // Fallback: jika ada screenshot tapi tidak lewat slow path (misal dari intent detection di botCoding)
          reqLog.info('Routing → /screenshot (fallback)');
          ctx.waitUntil((async () => {
            try {
              await handleScreenshotCommand(env, targetId, incomingText, isGroup, threadId, messageId);
            } catch (err) {
              reqLog.error('Background: screenshot fallback failed', err);
            }
          })());
        } else {
          reqLog.info('Routing → /general-chat (AI)');
          
          // AI chat juga bisa lambat (AI response time), 
          // tapi biasanya <10 detik jadi aman synchronous
          await handleGeneralChat(env, targetId, incomingText, isGroup, threadId, messageId, ctx);
        }

        reqLog.info('Request completed');
        return new Response("OK", { status: 200 });
      }
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
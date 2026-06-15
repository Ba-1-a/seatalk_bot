/**
 * index.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Cloudflare Worker sebagai Event Callback & Cron Executor
 * 
 * Fitur:
 * - Webhook callback untuk SeaTalk
 * - seatalk_challenge handler
 * - Routing command ke handler masing-masing
 * - Cron job scheduler
 */

import { handleGeneralChat } from './src/botCoding.js';
import { extractIncomingText, sendSystemWebhook, replyToUser } from './src/utils.js';
import { getHourlyReportData, handleInventoryQuery, handleSetSheet, handleReadSheet, handleScreenshotCommand } from './src/botSheet.js';

export default {
  // 1. GERBANG MASUK CHAT (WEBHOOK SEATALK)
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Bot Active", { status: 200 });

    try {
      const payload = await request.json();
      const event = payload.event || {};

      // Handle seatalk_challenge untuk verifikasi webhook
      if (payload.event_type === "event_verification") {
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

      // Routing Command
      if (incomingText.startsWith("/inventory")) {
        await handleInventoryQuery(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.startsWith("/setsheet")) {
        await handleSetSheet(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.startsWith("/readsheet")) {
        await handleReadSheet(env, targetId, incomingText, isGroup, threadId, messageId);
      } else if (incomingText.startsWith("/screenshot")) {
        // Rute khusus Screenshot - langsung proses di Worker
        await handleScreenshotCommand(env, targetId, incomingText, isGroup, threadId, messageId);
      } else {
        await handleGeneralChat(env, targetId, incomingText, isGroup, threadId, messageId);
      }

      return new Response("OK", { status: 200 });
    } catch (err) {
      console.error("Worker Error:", err);
      return new Response("Error", { status: 500 });
    }
  },

  // 2. CRON JOBS
  async scheduled(event, env, ctx) {
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
        // Ambil data laporan dari GSheets via modul botSheet
        const reportText = await getHourlyReportData(env);
        
        // Eksekusi semua tembakan webhook secara paralel
        await Promise.all(
          jobsToRun.map(job => sendSystemWebhook(job.webhookUrl, reportText))
        );
        console.log(`DEBUG: Menjalankan ${jobsToRun.length} jadwal cron pada menit ke-${targetMinute}`);
      }
    } catch (err) {
      console.error("Cron Error:", err);
    }
  }
};
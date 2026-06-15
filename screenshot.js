/**
 * screenshot.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Script untuk GitHub Actions - Export Google Sheets ke PNG
 *
 * ALUR:
 * 1. Ambil data spreadsheet via Google Sheets API (Service Account)
 * 2. Render data sebagai HTML table
 * 3. Gunakan Puppeteer untuk screenshot HTML -> PNG
 * 4. Kirim PNG ke SeaTalk via base64
 */

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { google } from 'googleapis';

function getSystemChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  return candidates.find(p => p && fs.existsSync(p));
}

async function ensureDir(dir) {
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {}
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function fetchSheetData(spreadsheetId, range = 'A1:Z100') {
  let authClient;
  if (process.env.GSA_JSON_BASE64) {
    const json = Buffer.from(process.env.GSA_JSON_BASE64, 'base64').toString('utf8');
    const key = JSON.parse(json);
    authClient = new google.auth.JWT(key.client_email, null, key.private_key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  } else if (process.env.GSA_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL) {
    const privateKey = process.env.GSA_PRIVATE_KEY.replace(/\\n/g, '\n');
    authClient = new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  } else {
    throw new Error('Service account credentials missing');
  }
  await authClient.authorize();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const metaRes = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetTitle = metaRes.data.sheets[0].properties.title;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetTitle + '!' + range });
  return { title: sheetTitle, values: res.data.values || [] };
}

function renderSheetAsHtml(title, values) {
  let html = '<!DOCTYPE html><html><head><meta charset="utf-8">';
  html += '<>body{font-family:Segoe UI,Arial,sans-serif;background:#fff;padding:16px}';
  html += '.header{background:linear-gradient(135deg,#1a73e8,#0d47a1);color:#fff;padding:14px 20px;font-size:18px;font-weight:600}';
  html += 'table{border-collapse:collapse;width:100%;border:1px solid #dadce0}';
  html += 'th,td{border:1px solid #e8eaed;padding:10px 14px;text-align:left;font-size:13px;white-space:nowrap}';
  html += 'th{background:#f8f9fa;font-weight:600;color:#3c4043;border-bottom:2px solid #dadce0}';
  html += 'td{color:#202124}tr:nth-child(even) td{background:#f8f9fa}';
  html += '</style></head><body><div class="container">';
  html += '<div class="header">📊 ' + escapeHtml(title) + '</div><table>';
  if (values.length > 0) {
    html += '<thead><tr>';
    for (const cell of values[0]) html += '<th>' + escapeHtml(String(cell || '')) + '</th>';
    html += '</tr></thead><tbody>';
    for (let i = 1; i < values.length; i++) {
      html += '<tr>';
      for (const cell of values[i]) html += '<td>' + escapeHtml(String(cell || '')) + '</td>';
      html += '</tr>';
    }
    html += '</tbody>';
  }
  html += '</table></div></body></html>';
  return html;
}

async function getSeatalkToken(appId, appSecret) {
  const res = await fetch('https://openapi.seatalk.io/auth/app_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const data = await res.json();
  if (!data?.app_access_token) throw new Error('Gagal token SeaTalk: ' + JSON.stringify(data));
  return data.app_access_token;
}

async function sendScreenshotToSeatalk(appId, appSecret, targetId, isGroup, threadId, originalMessageId, buffer) {
  const token = await getSeatalkToken(appId, appSecret);
  const base64Image = bufferToBase64(buffer);
  const endpoint = isGroup ? 'https://openapi.seatalk.io/messaging/v2/group_chat' : 'https://openapi.seatalk.io/messaging/v2/single_chat';
  const requestBase = isGroup ? { group_id: targetId } : { employee_code: targetId };
  const variants = [
    { tag: 'image', image_base64: { content: base64Image } },
    { tag: 'image', image: { base64: base64Image } },
    { tag: 'image', image: { base64: base64Image, type: 'image/png' } },
    { tag: 'image', image: { content: base64Image } },
    { tag: 'image', image_base64: base64Image }
  ];
  let lastError = null;
  for (const variant of variants) {
    const requestBody = { ...requestBase, message: variant };
    if (isGroup && threadId) requestBody.thread_id = threadId;
    else if (isGroup && originalMessageId) requestBody.thread_id = originalMessageId;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify(requestBody)
    });
    const responseData = await response.json();
    if (responseData.code === 0) return responseData;
    lastError = responseData;
  }
  throw new Error('SeaTalk upload failed: ' + JSON.stringify(lastError));
}

async function sendTextToSeatalk(appId, appSecret, targetId, isGroup, threadId, text) {
  const token = await getSeatalkToken(appId, appSecret);
  const endpoint = isGroup ? 'https://openapi.seatalk.io/messaging/v2/group_chat' : 'https://openapi.seatalk.io/messaging/v2/single_chat';
  const requestBody = { ...(isGroup ? { group_id: targetId } : { employee_code: targetId }), message: { tag: 'text', text: { content: text } } };
  if (isGroup && threadId) requestBody.thread_id = threadId;
  await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(requestBody) });
}

async function run() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const targetUrl = process.env.TARGET_URL;
  if (!spreadsheetId && !targetUrl) { console.error('ERROR: SPREADSHEET_ID or TARGET_URL required'); process.exit(1); }
  const outDir = path.resolve(process.cwd(), 'screenshots');
  await ensureDir(outDir);
  const outPath = path.join(outDir, 'capture-' + Date.now() + '.png');
  let browser;
  try {
    const launchOptions = { args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], headless: 'new' };
    const systemChrome = getSystemChromePath();
    if (systemChrome) launchOptions.executablePath = systemChrome;
    browser = await puppeteer.launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    if (process.env.SPREADSHEET_ID) {
      console.log('Rendering sheet via Service Account');
      const range = process.env.SPREADSHEET_RANGE || 'A1:Z100';
      const { title, values } = await fetchSheetData(process.env.SPREADSHEET_ID, range);
      const html = renderSheetAsHtml(title, values);
      await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    } else {
      console.log('Navigating to ' + targetUrl);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    }
    const screenshotBuffer = await page.screenshot({ fullPage: false });
    await fs.promises.writeFile(outPath, screenshotBuffer);
    console.log('Screenshot saved: ' + outPath);
    const seatalkTargetId = process.env.SEATALK_TARGET_ID || '';
    const seatalkAppId = process.env.SEATALK_APP_ID || '';
    const seatalkAppSecret = process.env.SEATALK_APP_SECRET || '';
    const seatalkIsGroup = process.env.SEATALK_IS_GROUP === '1';
    const seatalkThreadId = process.env.SEATALK_THREAD_ID || '';
    const seatalkOriginalMessageId = process.env.SEATALK_ORIGINAL_MESSAGE_ID || '';
    if (seatalkTargetId && seatalkAppId && seatalkAppSecret) {
      console.log('Sending to SeaTalk: ' + seatalkTargetId);
      await sendScreenshotToSeatalk(seatalkAppId, seatalkAppSecret, seatalkTargetId, seatalkIsGroup, seatalkThreadId, seatalkOriginalMessageId, screenshotBuffer);
      console.log('SeaTalk send successful');
    } else {
      console.log('SeaTalk not configured, saved locally only.');
    }
  } catch (err) {
    console.error('Screenshot failed:', err.message);
    try {
      const seatalkTargetId = process.env.SEATALK_TARGET_ID || '';
      const seatalkAppId = process.env.SEATALK_APP_ID || '';
      const seatalkAppSecret = process.env.SEATALK_APP_SECRET || '';
      const seatalkIsGroup = process.env.SEATALK_IS_GROUP === '1';
      const seatalkThreadId = process.env.SEATALK_THREAD_ID || '';
      if (seatalkTargetId && seatalkAppId && seatalkAppSecret) {
        await sendTextToSeatalk(seatalkAppId, seatalkAppSecret, seatalkTargetId, seatalkIsGroup, seatalkThreadId, 'Screenshot gagal: ' + err.message);
      }
    } catch (notifyErr) { console.error('Notify failed:', notifyErr.message); }
    process.exitCode = 2;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
  }
}

run();

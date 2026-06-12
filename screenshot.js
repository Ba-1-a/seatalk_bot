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
  } catch (err) {
    // ignore
  }
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

async function fetchSheetHtmlFromServiceAccount(spreadsheetId, range = 'A1:Z100') {
  let authClient;
  if (process.env.GSA_JSON_BASE64) {
    const json = Buffer.from(process.env.GSA_JSON_BASE64, 'base64').toString('utf8');
    const key = JSON.parse(json);
    authClient = new google.auth.JWT(key.client_email, null, key.private_key, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  } else if (process.env.GSA_PRIVATE_KEY && process.env.GOOGLE_CLIENT_EMAIL) {
    const privateKey = process.env.GSA_PRIVATE_KEY.replace(/\\n/g, '\n');
    authClient = new google.auth.JWT(process.env.GOOGLE_CLIENT_EMAIL, null, privateKey, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  } else {
    throw new Error('Service account credentials missing (set GSA_JSON_BASE64 or GSA_PRIVATE_KEY + GOOGLE_CLIENT_EMAIL)');
  }

  await authClient.authorize();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];

  let html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,Helvetica,sans-serif;padding:12px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #e1e1e1;padding:8px;text-align:left}</style></head><body>';
  html += '<table>';
  for (const row of values) {
    html += '<tr>';
    for (const cell of row) {
      html += `<td>${escapeHtml(cell)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table></body></html>';
  return html;
}

async function getSeatalkToken(appId, appSecret) {
  console.log('SeaTalk auth request: appId=', appId ? 'SET' : 'MISSING', 'appSecret=', appSecret ? 'SET' : 'MISSING');
  const res = await fetch('https://openapi.seatalk.io/auth/app_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });
  const responseText = await res.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    throw new Error('Gagal parse response SeaTalk auth: ' + responseText);
  }
  console.log('SeaTalk auth response status:', res.status, 'body:', JSON.stringify(data));
  if (!data?.app_access_token) {
    throw new Error('Gagal mendapatkan token SeaTalk: ' + JSON.stringify(data));
  }
  return data.app_access_token;
}

async function sendScreenshotToSeatalk(appId, appSecret, targetId, isGroup, threadId, originalMessageId, buffer) {
  const token = await getSeatalkToken(appId, appSecret);
  const base64Image = bufferToBase64(buffer);

  const endpoint = isGroup ? 'https://openapi.seatalk.io/messaging/v2/group_chat' : 'https://openapi.seatalk.io/messaging/v2/single_chat';
  const requestBase = isGroup ? { group_id: targetId } : { employee_code: targetId };
  const messageVariants = [
    { tag: 'image', image_base64: { content: base64Image } },
    { tag: 'image', image: { base64: base64Image } },
    { tag: 'image', image: { base64: base64Image, type: 'image/png' } },
    { tag: 'image', image: { content: base64Image } },
    { tag: 'image', image: { content: base64Image, type: 'image/png' } },
    { tag: 'image', image_base64: base64Image },
    { tag: 'image', image: { data: base64Image } },
    { tag: 'image', image: { data: base64Image, type: 'image/png' } },
    { tag: 'image', image_base64: { data: base64Image } }
  ];

  let lastError = null;
  for (const variant of messageVariants) {
    const requestBody = { ...requestBase, message: variant };
    if (isGroup && threadId) requestBody.thread_id = threadId;
    else if (isGroup && originalMessageId) requestBody.thread_id = originalMessageId;

    console.log('SeaTalk image request variant:', JSON.stringify(variant).substring(0, 200));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(requestBody)
    });
    const responseData = await response.json();

    console.log('SeaTalk image response:', JSON.stringify(responseData).substring(0, 300));

    if (responseData.code === 0) {
      return responseData;
    }

    lastError = responseData;
    if (responseData.code !== 4003 || typeof responseData.message !== 'string' || !responseData.message.includes('Message cannot be empty')) {
      throw new Error('SeaTalk image upload failed: ' + JSON.stringify(responseData));
    }
  }

  throw new Error('SeaTalk image upload failed: ' + JSON.stringify(lastError));
}

async function sendTextToSeatalk(appId, appSecret, targetId, isGroup, threadId, text) {
  const token = await getSeatalkToken(appId, appSecret);
  const endpoint = isGroup ? 'https://openapi.seatalk.io/messaging/v2/group_chat' : 'https://openapi.seatalk.io/messaging/v2/single_chat';
  const requestBase = isGroup ? { group_id: targetId } : { employee_code: targetId };
  const requestBody = { ...requestBase, message: { tag: 'text', text: { content: text } } };
  if (isGroup && threadId) requestBody.thread_id = threadId;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify(requestBody)
  });
  try {
    return await res.json();
  } catch (e) {
    return { code: -1, message: 'Invalid response from SeaTalk' };
  }
}

async function run() {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const targetUrl = process.env.TARGET_URL;
  
  // SPREADSHEET_ID takes priority (Service Account flow)
  // If no SPREADSHEET_ID and no TARGET_URL, throw error
  if (!spreadsheetId && !targetUrl) {
    console.error('ERROR: Either SPREADSHEET_ID or TARGET_URL environment variable is required.');
    process.exit(1);
  }

  const outDir = path.resolve(process.cwd(), 'screenshots');
  await ensureDir(outDir);
  const outPath = path.join(outDir, `capture-${Date.now()}.png`);

  let browser;
  try {
    const launchOptions = {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: 'new',
    };
    const systemChrome = getSystemChromePath();
    if (systemChrome) {
      launchOptions.executablePath = systemChrome;
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    if (process.env.SPREADSHEET_ID) {
      console.log('SPREADSHEET_ID found, rendering sheet via Service Account');
      const range = process.env.SPREADSHEET_RANGE || 'A1:Z100';
      const html = await fetchSheetHtmlFromServiceAccount(process.env.SPREADSHEET_ID, range);
      await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
    } else {
      console.log(`Navigating to ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

      // Check for access-denied or login portal
      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const url = page.url();
      
      // Detect Google sign-in portal (jika kena portal, berarti tidak ada akses)
      if (url.includes('accounts.google.com')) {
        throw new Error('Access denied: spreadsheet memerlukan Google sign-in. Pastikan service account sudah di-share sebagai Viewer.');
      }
      
      // Check for access-denied keywords
      const accessDeniedKeywords = ['You need access', 'You need permission', 'Request access', "doesn't have access"];
      for (const kw of accessDeniedKeywords) {
        if (bodyText.includes(kw)) {
          throw new Error('Access denied: ' + kw + '. Pastikan service account sudah di-share.');
        }
      }
    }

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    await fs.promises.writeFile(outPath, screenshotBuffer);
    console.log(`Screenshot saved locally: ${outPath}`);

    const seatalkTargetId = process.env.SEATALK_TARGET_ID || '';
    const seatalkAppId = process.env.SEATALK_APP_ID || '';
    const seatalkAppSecret = process.env.SEATALK_APP_SECRET || '';
    const seatalkIsGroup = process.env.SEATALK_IS_GROUP === '1';
    const seatalkThreadId = process.env.SEATALK_THREAD_ID || '';
    const seatalkOriginalMessageId = process.env.SEATALK_ORIGINAL_MESSAGE_ID || '';

    console.log('SeaTalk env debug:', {
      targetId: seatalkTargetId ? 'SET' : 'MISSING',
      appId: seatalkAppId ? 'SET' : 'MISSING',
      appSecret: seatalkAppSecret ? 'SET' : 'MISSING',
      isGroup: seatalkIsGroup,
      threadId: seatalkThreadId ? 'SET' : 'EMPTY',
      originalMessageId: seatalkOriginalMessageId ? 'SET' : 'EMPTY'
    });

    if (seatalkTargetId && seatalkAppId && seatalkAppSecret) {
      console.log(`Sending screenshot to SeaTalk target ${seatalkTargetId}`);
      const result = await sendScreenshotToSeatalk(
        seatalkAppId,
        seatalkAppSecret,
        seatalkTargetId,
        seatalkIsGroup,
        seatalkThreadId,
        seatalkOriginalMessageId,
        screenshotBuffer
      );
      console.log('SeaTalk send successful', result);
    } else {
      console.log('SeaTalk target not configured. Screenshot saved locally only.');
    }
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    console.error('Screenshot failed:', errMsg);
    // Try to notify user on SeaTalk about failure
    try {
      const seatalkTargetId = process.env.SEATALK_TARGET_ID || '';
      const seatalkAppId = process.env.SEATALK_APP_ID || '';
      const seatalkAppSecret = process.env.SEATALK_APP_SECRET || '';
      const seatalkIsGroup = process.env.SEATALK_IS_GROUP === '1';
      const seatalkThreadId = process.env.SEATALK_THREAD_ID || '';
      if (seatalkTargetId && seatalkAppId && seatalkAppSecret) {
        await sendTextToSeatalk(seatalkAppId, seatalkAppSecret, seatalkTargetId, seatalkIsGroup, seatalkThreadId, `Screenshot gagal: ${errMsg}`);
      }
    } catch (notifyErr) {
      console.error('Failed to notify via SeaTalk:', notifyErr && notifyErr.message ? notifyErr.message : notifyErr);
    }
    process.exitCode = 2;
  } finally {
    try {
      if (browser) await browser.close();
    } catch (e) {}
  }
}

run();

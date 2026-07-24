/**
 * hf-spaces/api/index.js
 * Hugging Face Spaces - Background Renderer
 * Architecture: Queue-based async processing with pdftoppm + sharp
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const sharp = require('sharp');
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '50mb' }));

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 7860;
const CONCURRENCY = 2;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PROJECT_TOKENS = {
  [process.env.TOKEN_SEATALK || 'seatalk_token_123']: 'seatalk_bot'
};

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[FATAL] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// SeaTalk Token Cache (prevents rate limit)
// ============================================================
let cachedSeaTalkToken = null;
let tokenExpiration = 0;

async function getSeaTalkAccessToken(appId, appSecret) {
  if (cachedSeaTalkToken && Date.now() < tokenExpiration - 30000) {
    return cachedSeaTalkToken;
  }

  const response = await fetch('https://openapi.seatalk.io/auth/app_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret })
  });

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`SeaTalk auth failed: ${JSON.stringify(data)}`);
  }

  cachedSeaTalkToken = data.access_token;
  tokenExpiration = Date.now() + (7000 * 1000); // ~2 hours
  console.log(`[AUTH] New SeaTalk token cached, expires at ${new Date(tokenExpiration).toISOString()}`);
  return data.access_token;
}

// ============================================================
// SeaTalk Image Upload (native FormData, Node.js 20+)
// ============================================================
async function uploadImageToSeaTalk(accessToken, imageBuffer) {
  const form = new FormData();
  form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'screenshot.png');

  const response = await fetch('https://openapi.seatalk.io/auth/v2/file/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`
      // NO Content-Type: fetch sets it automatically with boundary
    },
    body: form
  });

  const data = await response.json();
  if (!data.file_code) {
    throw new Error(`SeaTalk upload failed: ${JSON.stringify(data)}`);
  }
  return data.file_code;
}

async function sendImageMessage(accessToken, targetId, isGroup, fileCode) {
  const endpoint = isGroup
    ? 'https://openapi.seatalk.io/messaging/v2/group_chat'
    : 'https://openapi.seatalk.io/messaging/v2/single_chat';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      [isGroup ? 'group_id' : 'employee_code']: targetId,
      message: {
        image: { file_code: fileCode }
      }
    })
  });

  const data = await response.json();
  if (data.error_code !== 0) {
    throw new Error(`SeaTalk message failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function sendToSeaTalk(seatalkAppId, seatalkAppSecret, targetId, isGroup, imageBuffer) {
  const accessToken = await getSeaTalkAccessToken(seatalkAppId, seatalkAppSecret);
  const fileCode = await uploadImageToSeaTalk(accessToken, imageBuffer);
  await sendImageMessage(accessToken, targetId, isGroup, fileCode);
  return fileCode;
}

// ============================================================
// AUTH Middleware (for manual override/token validation)
// ============================================================
function requireProjectToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7);
  const projectId = PROJECT_TOKENS[token];
  if (!projectId) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  req.projectId = projectId;
  next();
}

// ============================================================
// Wakeup Endpoint (Triggered by CF Worker)
// ============================================================
app.get('/wakeup', (req, res) => {
  console.log(`[${new Date().toISOString()}] [WAKEUP] Triggered`);
  setImmediate(() => processQueue().catch(err => {
    console.error('[WAKEUP] Queue processing error:', err);
  }));
  res.json({ status: 'wakeup_received' });
});

// ============================================================
// Queue Processor
// ============================================================
async function processQueue() {
  const startTime = Date.now();

  const { data: jobs, error } = await supabase
    .from('screenshot_queue')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(CONCURRENCY);

  if (error || !jobs || jobs.length === 0) {
    console.log('[QUEUE] No pending jobs');
    return;
  }

  const jobIds = jobs.map(j => j.id);

  await supabase
    .from('screenshot_queue')
    .update({ status: 'processing' })
    .in('id', jobIds);

  console.log(`[QUEUE] Processing ${jobs.length} jobs`);
  await Promise.allSettled(
    jobs.map(job => processJob(job).catch(err => {
      console.error(`[JOB:${job.id.slice(0,8)}] Error:`, err.message);
    }))
  );

  console.log(`[QUEUE] Batch completed in ${Date.now() - startTime}ms`);
}

// ============================================================
// Job Processor
// ============================================================
async function processJob(job) {
  const { id, sheet_url, target_id, is_group, seatalk_app_id, seatalk_app_secret } = job;

  try {
    const pdfBuffer = await downloadPdf(sheet_url);
    console.log(`[JOB:${id.slice(0,8)}] PDF: ${(pdfBuffer.byteLength/1024/1024).toFixed(2)}MB`);

    const trimmedBuffer = await renderPdfWithPoppler(pdfBuffer);

    await sendToSeaTalk(seatalk_app_id, seatalk_app_secret, target_id, is_group, trimmedBuffer);
    console.log(`[JOB:${id.slice(0,8)}] Delivered to SeaTalk`);

    await supabase
      .from('screenshot_queue')
      .update({ status: 'completed', processed_at: new Date().toISOString() })
      .eq('id', id);

  } catch (err) {
    console.error(`[JOB:${id.slice(0,8)}] Failed:`, err.message);
    await supabase
      .from('screenshot_queue')
      .update({ status: 'failed', processed_at: new Date().toISOString() })
      .eq('id', id);
  }
}

// ============================================================
// PDF Download
// ============================================================
async function downloadPdf(exportUrl) {
  const response = await fetch(exportUrl);
  if (!response.ok) throw new Error(`PDF download failed: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < 200) throw new Error('PDF too small');
  return buffer;
}

// ============================================================
// pdftoppm + sharp (proper metadata-based stitching)
// ============================================================
async function renderPdfWithPoppler(pdfBuffer) {
  const tempDir = os.tmpdir();
  const timestamp = Date.now();
  const pdfFile = path.join(tempDir, `input_${timestamp}.pdf`);
  const outputPrefix = path.join(tempDir, `page_${timestamp}`);

  try {
    await fs.writeFile(pdfFile, Buffer.from(pdfBuffer));

    const cmd = `pdftoppm -png -r 300 -f 1 -l 5 "${pdfFile}" "${outputPrefix}"`;
    await exec(cmd, { timeout: 60000 });

    const files = await fs.readdir(tempDir);
    const pngFiles = files
      .filter(f => f.startsWith(`page_${timestamp}`) && f.endsWith('.png'))
      .sort();

    if (pngFiles.length === 0) throw new Error('No PNG generated');

    const buffers = await Promise.all(
      pngFiles.map(f => fs.readFile(path.join(tempDir, f)))
    );

    const metadatas = await Promise.all(
      buffers.map(buf => sharp(buf).metadata())
    );

    if (buffers.length === 1) {
      return await sharp(buffers[0])
        .trim({ threshold: 10 })
        .png()
        .toBuffer();
    }

    const pageWidth = metadatas[0].width;
    const totalHeight = metadatas.reduce((sum, m) => sum + m.height, 0);

    const compositeInputs = [];
    let currentTop = 0;
    for (let i = 0; i < buffers.length; i++) {
      compositeInputs.push({
        input: buffers[i],
        top: currentTop,
        left: 0
      });
      currentTop += metadatas[i].height;
    }

    return await sharp({
      create: {
        width: pageWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 }
      }
    })
      .composite(compositeInputs)
      .trim({ threshold: 10 })
      .png()
      .toBuffer();

  } finally {
    try {
      await fs.unlink(pdfFile);
      const allFiles = await fs.readdir(tempDir);
      await Promise.all(
        allFiles
          .filter(f => f.startsWith(`page_${timestamp}`) || f.startsWith(`input_${timestamp}`))
          .map(f => fs.unlink(path.join(tempDir, f)).catch(() => {}))
      );
    } catch(e) {}
  }
}

// ============================================================
// Legacy endpoints (backward compatibility)
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hf-spaces-queue-renderer',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    tokenCached: !!cachedSeaTalkToken
  });
});

// Keep /render for backward compat (optional)
app.post('/render', requireProjectToken, async (req, res) => {
  res.status(501).json({ error: 'Use /wakeup endpoint with Supabase queue instead' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] HF Spaces renderer v2.0 listening on ${PORT}`);
  console.log(`[${new Date().toISOString()}] Supabase: ${SUPABASE_URL}`);
  console.log(`[${new Date().toISOString()}] Concurrency limit: ${CONCURRENCY}`);
});
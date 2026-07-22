/**
 * api/index.js
 * Hugging Face Spaces - Centralized Rendering API
 * Multi-project support via Bearer token
 * Architecture: Worker sends sheet_url + google_access_token
 *               HF Spaces downloads PDF, renders PNG, returns binary
 * 
 * ENDPOINTS:
 * - POST /render - Render Google Sheet to PNG
 * - GET /health - Health check
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 7860;
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB limit
const REQUEST_TIMEOUT = 120000; // 2 minutes for large PDFs

// ============================================================
// MULTI-PROJECT TOKEN CONFIGURATION
// ============================================================
// 1 akun HF, multiple projects
// Format: { "<bearer_token>": "<project_id>" }
const PROJECT_TOKENS = {
  [process.env.TOKEN_SEATALK || 'seatalk_token_123']: 'seatalk_bot',
  // Add more projects here:
  // [process.env.TOKEN_PROJECT_B]: 'project_b',
  // [process.env.TOKEN_PROJECT_C]: 'project_c',
};

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(express.json({ limit: '50mb' }));

// Multi-project Bearer token validation
function requireProjectToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'Unauthorized',
      detail: 'Missing or invalid Authorization header. Use: Authorization: Bearer <token>'
    });
  }

  const token = authHeader.slice(7);
  const projectId = PROJECT_TOKENS[token];

  if (!projectId) {
    return res.status(403).json({
      error: 'Invalid token',
      detail: 'Token not recognized. Check TOKEN_SEATALK environment variable.',
      hint: 'Ensure Worker sends correct Bearer token'
    });
  }

  // Attach project info to request
  req.projectId = projectId;
  req.apiKey = token;
  
  console.log(`[${new Date().toISOString()}] [AUTH] Authenticated: project=${projectId}`);
  
  next();
}

// ============================================================
// ROUTES
// ============================================================

/**
 * Health check endpoint
 * GET /health
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'hf-spaces-renderer',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
    projects: Object.keys(PROJECT_TOKENS).length
  });
});

/**
 * Main render endpoint - NEW Architecture
 * POST /render
 * Body: {
 *   sheet_url: "<Google Sheets export URL>",
 *   google_access_token: "<OAuth token>",
 *   render_options: { scale, max_pages, ... }
 * }
 * Headers: Authorization: Bearer <TOKEN_SEATALK>
 * Response: image/png (binary)
 */
app.post('/render', requireProjectToken, async (req, res) => {
  const startTime = Date.now();
  const reqId = `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  const projectId = req.projectId;
  
  console.log(`[${new Date().toISOString()}] [${reqId}] Render request from project=${projectId}`);

  try {
    // 1. Validate payload
    const { sheet_url, google_access_token, render_options } = req.body;

    if (!sheet_url) {
      return res.status(400).json({
        error: 'sheet_url required',
        requestId: reqId
      });
    }

    if (!google_access_token) {
      return res.status(400).json({
        error: 'google_access_token required (for private sheets)',
        requestId: reqId
      });
    }

    console.log(`[${reqId}] Rendering: ${sheet_url.substring(0, 120)}...`);

    // 2. Download PDF from Google Sheets with OAuth token
    console.log(`[${reqId}] Downloading PDF from Google...`);
    const pdfBuffer = await downloadPdfWithAuth(sheet_url, google_access_token, reqId);
    const pdfSizeMB = (pdfBuffer.byteLength / 1024 / 1024).toFixed(2);
    
    console.log(`[${reqId}] PDF downloaded: ${pdfBuffer.byteLength} bytes (${pdfSizeMB} MB)`);

    if (pdfBuffer.byteLength < 200) {
      return res.status(400).json({
        error: 'PDF too small (sheet might be empty)',
        requestId: reqId
      });
    }

    // 3. Render PDF to PNG
    console.log(`[${reqId}] Rendering PDF to PNG...`);
    const pngBuffer = await renderPdfToPng(pdfBuffer, render_options || {}, reqId);
    const pngSizeMB = (pngBuffer.byteLength / 1024 / 1024).toFixed(2);
    
    const processingTime = Date.now() - startTime;
    console.log(`[${reqId}] Render complete: ${pngBuffer.byteLength} bytes (${pngSizeMB} MB) in ${processingTime}ms`);

    // 4. Return binary PNG
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length,
      'X-Processing-Time': `${processingTime}ms`,
      'X-PDF-Size': `${pdfSizeMB}MB`,
      'X-PNG-Size': `${pngSizeMB}MB`,
      'X-Request-Id': reqId,
      'X-Project': projectId
    });
    
    return res.send(Buffer.from(pngBuffer));

  } catch (err) {
    const processingTime = Date.now() - startTime;
    console.error(`[${reqId}] Render failed after ${processingTime}ms:`, err.message);
    
    res.status(500).json({
      error: 'Rendering failed',
      detail: err.message,
      requestId: reqId,
      processingTime: `${processingTime}ms`
    });
  }
});

/**
 * Legacy endpoint (for backward compatibility)
 * POST /screenshot
 * Body: { pdf_base64: "...", render_options: {...} }
 */
app.post('/screenshot', requireProjectToken, async (req, res) => {
  console.log(`[${new Date().toISOString()}] [LEGACY] /screenshot endpoint called (use /render instead)`);
  
  try {
    const { pdf_base64, render_options } = req.body;

    if (!pdf_base64) {
      return res.status(400).json({ error: 'Missing pdf_base64' });
    }

    const pdfBuffer = Buffer.from(pdf_base64, 'base64');
    const reqId = `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    
    console.log(`[${reqId}] Legacy render: ${pdfBuffer.length} bytes`);
    
    const pngBuffer = await renderPdfToPng(pdfBuffer, render_options || {}, reqId);
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length,
      'X-Request-Id': reqId
    });
    
    return res.send(Buffer.from(pngBuffer));

  } catch (err) {
    console.error(`[${new Date().toISOString()}] [LEGACY] Error:`, err.message);
    res.status(500).json({
      error: err.message || 'Internal server error'
    });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Download PDF from Google Sheets export URL with OAuth token
 */
async function downloadPdfWithAuth(exportUrl, accessToken, reqId) {
  console.log(`[${reqId}] Fetching: ${exportUrl.substring(0, 120)}...`);
  
  const response = await fetch(exportUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => 'Unknown error');
    console.error(`[${reqId}] Google download failed: ${response.status} - ${errText.substring(0, 200)}`);
    throw new Error(`Google PDF download failed: HTTP ${response.status}`);
  }

  const buffer = await response.arrayBuffer();
  return buffer;
}

/**
 * Render PDF buffer to PNG using Puppeteer
 * Uses temp file and HTML wrapper approach to prevent frame detachment
 */
async function renderPdfToPng(pdfBuffer, options, reqId) {
  const {
    scale = 2.5,
    max_pages = 5,
    device_scale_factor: deviceScaleFactor = 2.5,
    render_delay_ms = 1000
  } = options;

  console.log(`[${reqId}] renderPdfToPng: scale=${scale}, max_pages=${max_pages}`);

  let browser = null;
  let tempFilePath = null;
  let htmlFilePath = null;

  try {
    // 1. Write PDF to temp file
    const tempDir = os.tmpdir();
    tempFilePath = path.join(tempDir, `sheet_${Date.now()}.pdf`);
    await fs.writeFile(tempFilePath, Buffer.from(pdfBuffer));
    console.log(`[${reqId}] PDF written to: ${tempFilePath}`);

    // 2. Create HTML wrapper using standard embed/iframe or object with fallback
    htmlFilePath = path.join(tempDir, `viewer_${Date.now()}.html`);
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
          <style>
              html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #ffffff; overflow: hidden; }
              embed { width: 100%; height: 100%; border: none; }
          </style>
      </head>
      <body>
          <embed src="file://${tempFilePath}" type="application/pdf" width="100%" height="100%">
      </body>
      </html>
    `;
    await fs.writeFile(htmlFilePath, htmlContent);

    // 3. Launch Chromium with container-safe arguments
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-web-security',
        '--allow-file-access-from-files',
        '--disable-extensions',
        '--disable-translate',
        '--disable-background-networking',
        '--disable-default-apps',
        '--no-first-run',
        '--disable-popup-blocking'
      ],
      defaultViewport: {
        width: 1920,
        height: 1080,
        deviceScaleFactor
      }
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor });

    // 4. Open HTML wrapper file using domcontentloaded to prevent detachment timeout
    const fileUrl = `file://${htmlFilePath}`;
    console.log(`[${reqId}] Opening HTML viewer: ${fileUrl}`);
    
    await page.goto(fileUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: REQUEST_TIMEOUT 
    });
    
    console.log(`[${reqId}] PDF viewer loaded successfully`);

    // 5. Wait longer for PDF internal plugin viewer to paint the canvas/pages
    console.log(`[${reqId}] Waiting ${render_delay_ms}ms for render...`);
    await new Promise(resolve => setTimeout(resolve, render_delay_ms));

    // 6. Take screenshot
    console.log(`[${reqId}] Taking screenshot...`);
    const screenshot = await page.screenshot({
      type: 'png',
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080
      }
    });

    await page.close();
    console.log(`[${reqId}] Screenshot captured: ${screenshot.length} bytes`);

    return screenshot;

  } catch (err) {
    console.error(`[${reqId}] Rendering error:`, err.message);
    throw new Error(`PDF rendering failed: ${err.message}`);
  } finally {
    // 7. Cleanup temp files and browser
    if (tempFilePath) {
      try { await fs.unlink(tempFilePath); } catch (e) {}
    }
    if (htmlFilePath) {
      try { await fs.unlink(htmlFilePath); } catch (e) {}
    }
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

// ============================================================
// ERROR HANDLING
// ============================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    detail: err.message 
  });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] HF Spaces rendering service listening on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Projects configured: ${Object.keys(PROJECT_TOKENS).length}`);
  console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
  console.log(`[${new Date().toISOString()}] Max PDF size: ${MAX_PDF_SIZE / 1024 / 1024}MB`);
});
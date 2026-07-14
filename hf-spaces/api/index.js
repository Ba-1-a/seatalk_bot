/**
 * api/index.js
 * Hugging Face Spaces - Puppeteer Screenshot API
 * Port: 7860 (HF Spaces standard)
 *
 * SECURITY:
 * - API Key protection via Authorization header
 * - Rate limiting per API key
 * - Request size limit (max 10MB PDF)
 *
 * ENDPOINTS:
 * - POST /screenshot - Convert PDF to PNG
 * - GET /health - Health check
 * - GET /stats - Usage statistics
 */

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 7860;
const API_KEY = process.env.HF_API_KEY || 'your-secret-api-key-here';
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT = 120000; // 120 detik (2 menit) - untuk PDF besar
const BROWSER_CLOSE_TIMEOUT = 10000; // 10 detik

// Rate limiting (in-memory, reset on restart)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 menit
const RATE_LIMIT_MAX = 10; // Max 10 requests per menit per API key

// ============================================================
// MIDDLEWARE
// ============================================================

// JSON body parser (max 10MB)
app.use(express.json({ limit: '10mb' }));

// API Key validation middleware
function requireApiKey(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: 'Missing Authorization header',
      hint: 'Use: Authorization: Bearer YOUR_API_KEY'
    });
  }

  // Support: "Bearer <key>" atau "<key>"
  const apiKey = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader;

  if (apiKey !== API_KEY) {
    return res.status(403).json({
      error: 'Invalid API key',
      hint: 'Check your HF_API_KEY environment variable'
    });
  }

  // Rate limiting check
  const now = Date.now();
  const userLimit = rateLimitMap.get(apiKey) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };

  if (now > userLimit.resetAt) {
    // Reset window
    rateLimitMap.set(apiKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
  } else {
    userLimit.count++;
    if (userLimit.count > RATE_LIMIT_MAX) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: RATE_LIMIT_MAX,
        window: '1 minute',
        retryAfter: Math.ceil((userLimit.resetAt - now) / 1000)
      });
    }
    rateLimitMap.set(apiKey, userLimit);
  }

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
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

/**
 * Stats endpoint (monitoring)
 * GET /stats
 */
app.get('/stats', requireApiKey, (req, res) => {
  const stats = {
    totalRequests: rateLimitMap.size,
    activeKeys: Array.from(rateLimitMap.entries()).map(([key, data]) => ({
      key: key.slice(0, 8) + '...',
      count: data.count,
      resetAt: new Date(data.resetAt).toISOString()
    }))
  };
  res.json(stats);
});

/**
 * Screenshot endpoint
 * POST /screenshot
 * Body: { pdf_base64: "<base64 encoded pdf>" }
 * Headers: Authorization: Bearer <API_KEY>
 * Response: image/png
 */
app.post('/screenshot', requireApiKey, async (req, res) => {
  const startTime = Date.now();
  const reqId = `${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  let browser;

  try {
    const attemptMeta = {
      requestId: reqId,
      apiKey: req.headers.authorization?.slice(-8) || 'unknown',
      receivedAt: new Date().toISOString()
    };

    // Validate input
    const { pdf_base64, render_options } = req.body;
    const renderOpt = render_options || {};

    if (!pdf_base64) {
      return res.status(400).json({
        error: 'Missing pdf_base64 in request body',
        requestId: reqId
      });
    }

    // Decode PDF
    let pdfBuffer;
    try {
      pdfBuffer = Buffer.from(pdf_base64, 'base64');
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid base64 encoding',
        requestId: reqId
      });
    }

    // Validate PDF size
    if (pdfBuffer.length > MAX_PDF_SIZE) {
      return res.status(413).json({
        error: 'PDF too large',
        maxSize: MAX_PDF_SIZE,
        received: pdfBuffer.length,
        requestId: reqId
      });
    }

    if (pdfBuffer.length < 100) {
      return res.status(400).json({
        error: 'PDF too small (possibly empty)',
        requestId: reqId
      });
    }

    console.log(`[${new Date().toISOString()}] [HF] reqId=${reqId} Processing PDF: ${pdfBuffer.length} bytes`, {
      ...attemptMeta,
      renderMode: renderOpt.mode || 'default',
      scale: renderOpt.scale || 2.2,
      maxPages: renderOpt.max_pages || 3,
      timeoutMs: renderOpt.timeout_ms || REQUEST_TIMEOUT
    });

    // Launch browser
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--disable-extensions',
        '--disable-translate',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-background-networking',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
    });

    const page = await browser.newPage();

    page.on('console', msg => {
      console.log(`[${new Date().toISOString()}] [HF] reqId=${reqId} page console:`, msg.text());
    });
    page.on('pageerror', err => {
      console.error(`[${new Date().toISOString()}] [HF] reqId=${reqId} page error:`, err.message);
    });

    await page.setViewport({
      width: 2560,
      height: 1440,
      deviceScaleFactor: 2
    });

    const html = buildHtmlViewer(pdfBuffer, renderOpt);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: REQUEST_TIMEOUT });

    await page.waitForFunction(() => document.body.dataset.ready === 'true', {
      timeout: REQUEST_TIMEOUT
    });

    await new Promise(r => setTimeout(r, 2000));

    const contentWidth = await page.evaluate(() =>
      parseInt(document.body.dataset.contentWidth) || 0
    );
    const contentHeight = await page.evaluate(() =>
      parseInt(document.body.dataset.contentHeight) || 0
    );

    if (contentWidth > 0 && contentHeight > 0) {
      await page.setViewport({
        width: contentWidth,
        height: contentHeight,
        deviceScaleFactor: 2
      });
      await new Promise(r => setTimeout(r, 500));
    }

    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    const executionTime = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] [HF] reqId=${reqId} Screenshot done: ${png.length} bytes in ${executionTime}ms`, {
      pdfSize: pdfBuffer.length,
      pngSize: png.length
    });

    res.set({
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'X-Execution-Time': executionTime,
      'X-PDF-Size': pdfBuffer.length,
      'X-PNG-Size': png.length,
      'X-Request-Id': reqId
    });
    res.send(png);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] [HF] reqId=unknown Error:`, err);
    if (browser) {
      try {
        const closePromise = browser.close();
        const timeoutPromise = new Promise(resolve => setTimeout(resolve, BROWSER_CLOSE_TIMEOUT));
        await Promise.race([closePromise, timeoutPromise]);
      } catch (closeErr) {
        console.error(`[${new Date().toISOString()}] [HF] reqId=unknown Browser close failed:`, closeErr.message);
      }
    }
    res.status(500).json({
      error: err.message || 'Internal server error',
      requestId: reqId,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
// HTML VIEWER BUILDER (sama seperti Vercel)
// ============================================================

function buildHtmlViewer(pdfBuffer, renderOptions = {}) {
  const scale = Number(renderOptions.scale) || 2.2;
  const maxPages = Number(renderOptions.max_pages) || 3;
  const timeoutMs = Number(renderOptions.timeout_ms) || REQUEST_TIMEOUT;
  const renderDelayMs = Number(renderOptions.render_delay_ms) || 800;
  const deviceScaleFactor = Number(renderOptions.device_scale_factor) || 2;
  const pdfBase64 = pdfBuffer.toString('base64');

  // Load pdfjs-dist dari node_modules
  const pdfjsPath = path.join(__dirname, '../node_modules/pdfjs-dist/build/pdf.min.js');
  const workerPath = path.join(__dirname, '../node_modules/pdfjs-dist/build/pdf.worker.min.js');

  let pdfjsCode, workerCode;
  try {
    pdfjsCode = fs.readFileSync(pdfjsPath, 'utf-8');
    workerCode = fs.readFileSync(workerPath, 'utf-8');
  } catch (e) {
    console.error('Failed to load pdfjs-dist:', e);
    throw new Error('pdfjs-dist not found. Run npm install first.');
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#fff;font-family:sans-serif;display:flex;align-items:flex-start;justify-content:flex-start}
#c{display:flex;flex-direction:column;align-items:flex-start;gap:0}
.pw{display:inline-block;line-height:0}
.pw canvas{display:block;margin:0;padding:0}
#s{display:none}
</style>
</head>
<body>
<div id="s">Loading PDF...</div>
<div id="c"></div>
<script>
${pdfjsCode}
</script>
<script>
(function(){
  var wb = new Blob([${JSON.stringify(workerCode)}], {type:'application/javascript'});
  var wu = URL.createObjectURL(wb);
  pdfjsLib.GlobalWorkerOptions.workerSrc = wu;

  var b64 = ${JSON.stringify(pdfBase64)};
  var bytes = Uint8Array.from(atob(b64), function(c){return c.charCodeAt(0)});

  pdfjsLib.getDocument({data: bytes}).promise.then(async function(pdf){
    var c=document.getElementById('c'), s=document.getElementById('s');
    var pageCount = Math.min(pdf.numPages, ${maxPages});
    s.textContent='Rendering '+pageCount+' pages...';
    for(var i=1;i<=pageCount;i++){
      s.textContent='Page '+i+'/'+pageCount+'...';
      var page=await pdf.getPage(i);
      var vp=page.getViewport({scale:${scale}});
      var pw=document.createElement('div');
      pw.className='pw';
      var cv=document.createElement('canvas');
      cv.width=vp.width; cv.height=vp.height;
      cv.style.width=vp.width+'px'; cv.style.height=vp.height+'px';
      pw.appendChild(cv); c.appendChild(pw);
      var ctx=cv.getContext('2d');
      ctx.fillStyle='#FFFFFF';
      ctx.fillRect(0,0,vp.width,vp.height);
      await page.render({canvasContext:ctx, viewport:vp}).promise;
      await new Promise(function(resolve){ setTimeout(resolve, ${renderDelayMs}); });
    }

    // === CROP WHITESPACE (4-DIRECTIONAL EDGE SCAN) ===
    var canvases = c.querySelectorAll('canvas');
    var TH = 8;
    var MIN_PX = 3;

    canvases.forEach(function(cv){
      var ctx = cv.getContext('2d');
      var w = cv.width, h = cv.height;
      var imageData = ctx.getImageData(0,0,w,h);
      var data = imageData.data;

      function isNonWhite(px, py) {
        var idx = (py * w + px) * 4;
        var r = data[idx], g = data[idx+1], b = data[idx+2];
        return Math.abs(r-255)>TH || Math.abs(g-255)>TH || Math.abs(b-255)>TH;
      }

      var edgeTop = 0, found = false;
      for (var y = 0; y < h; y++) {
        var count = 0;
        for (var x = 0; x < w; x++) {
          if (isNonWhite(x, y)) { count++; if (count >= MIN_PX) break; }
        }
        if (count >= MIN_PX) { edgeTop = y; found = true; break; }
      }
      if (!found) return;

      var edgeBottom = h - 1;
      for (var y = h - 1; y >= 0; y--) {
        var count = 0;
        for (var x = 0; x < w; x++) {
          if (isNonWhite(x, y)) { count++; if (count >= MIN_PX) break; }
        }
        if (count >= MIN_PX) { edgeBottom = y; break; }
      }

      var edgeLeft = 0;
      for (var x = 0; x < w; x++) {
        var count = 0;
        for (var y = edgeTop; y <= edgeBottom; y++) {
          if (isNonWhite(x, y)) { count++; if (count >= MIN_PX) break; }
        }
        if (count >= MIN_PX) { edgeLeft = x; break; }
      }

      var edgeRight = w - 1;
      for (var x = w - 1; x >= 0; x--) {
        var count = 0;
        for (var y = edgeTop; y <= edgeBottom; y++) {
          if (isNonWhite(x, y)) { count++; if (count >= MIN_PX) break; }
        }
        if (count >= MIN_PX) { edgeRight = x; break; }
      }

      var cropW = Math.max(1, edgeRight - edgeLeft + 1);
      var cropH = Math.max(1, edgeBottom - edgeTop + 1);
      var cropData = ctx.getImageData(edgeLeft, edgeTop, cropW, cropH);
      cv.width = cropW; cv.height = cropH;
      cv.style.width = cropW + 'px'; cv.style.height = cropH + 'px';
      ctx.putImageData(cropData, 0, 0);
      if (cv.parentElement) {
        cv.parentElement.style.width = cropW + 'px';
        cv.parentElement.style.height = cropH + 'px';
      }
    });

    var totalW = 0, totalH = 0;
    canvases.forEach(function(cv){
      if (totalW < cv.width) totalW = cv.width;
      totalH += cv.height;
    });

    c.style.width = totalW + 'px';
    c.style.height = totalH + 'px';
    document.body.style.width = totalW + 'px';
    document.body.style.height = totalH + 'px';
    document.documentElement.style.width = totalW + 'px';
    document.documentElement.style.height = totalH + 'px';

    s.textContent='Selesai';
    URL.revokeObjectURL(wu);
    document.body.dataset.ready='true';
    document.body.dataset.contentWidth = totalW;
    document.body.dataset.contentHeight = totalH;
  }).catch(function(e){
    document.getElementById('s').textContent='Error: '+e.message;
    document.body.dataset.error=e.message;
  });
})();
</script>
</body>
</html>`;
}

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[${new Date().toISOString()}] HF Spaces API listening on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] API Key: ${API_KEY.slice(0, 8)}...`);
  console.log(`[${new Date().toISOString()}] Health check: http://localhost:${PORT}/health`);
});
# Plan: Hugging Face Spaces Integration
**Tanggal**: 20 Juni 2026  
**Tujuan**: Migrasi heavy lifting (Puppeteer/Chromium) dari Vercel ke Hugging Face Spaces  
**Arsitektur**: Microservices — Vercel (lightweight) + HF Spaces (heavy)

---

## 1. Struktur Folder Proyek

```
seatalk_bot/
├── vercel/                          # Vercel projects (lightweight)
│   ├── api-gateway/                 # Project 1: API Gateway
│   │   ├── api/
│   │   │   └── route.js            # Route ke HF Spaces
│   │   ├── package.json
│   │   └── vercel.json
│   │
│   ├── webhook/                     # Project 2: SeaTalk Webhook
│   │   ├── index.js                # Event callback handler
│   │   ├── package.json
│   │   └── wrangler.toml
│   │
│   └── scheduler/                   # Project 3: Cron Jobs
│       ├── index.js                # Pre-warm ping + job queue
│       ├── package.json
│       └── wrangler.toml
│
├── hf-spaces/                       # Hugging Face Spaces (heavy lifting)
│   ├── Dockerfile                   # Node.js 18 Bullseye + Chromium
│   ├── requirements.txt             # Python dependencies (jika perlu)
│   ├── package.json                 # Node.js dependencies
│   ├── api/
│   │   └── index.js                # Express API (port 7860)
│   ├── src/
│   │   ├── pdfRenderer.js          # pdfjs-dist render logic
│   │   └── cropEngine.js           # JS browser-side crop (V7)
│   └── README.md
│
├── shared/                          # Shared code between Vercel & HF
│   ├── pdfjs-dist/                  # pdfjs-dist library (shared)
│   └── utils.js                     # Common utilities
│
├── docs/
│   ├── plan-hf-spaces-integration.md  # This file
│   └── SECRETS_SETUP.md
│
├── src/                             # Cloudflare Workers (existing)
│   ├── botSheet.js                  # Updated: call HF Spaces
│   ├── botCoding.js
│   └── ...
│
└── README.md
```

---

## 2. Dockerfile (Node.js 18 Bullseye + Chromium)

**File**: `hf-spaces/Dockerfile`

```dockerfile
# Base image: Node.js 18 Bullseye (Debian 11)
FROM node:18-bullseye

# Set working directory
WORKDIR /app

# Install system dependencies for Chromium
# List lengkap dependensi yang dibutuhkan Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
  # Chromium core
  chromium \
  chromium-sandbox \
  # Graphics & display
  libgbm1 \
  libx11-xcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxrandr2 \
  libxss1 \
  libxtst6 \
  libnss3 \
  libnspr4 \
  libxshmfence1 \
  libdrm2 \
  libxkbcommon0 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libgtk-3-0 \
  libasound2 \
  libpangocairo-1.0-0 \
  libpango-1.0-0 \
  libcairo2 \
  libatspi2.0-0 \
  libgdk-pixbuf2.0-0 \
  libpangoft2-1.0-0 \
  libharfbuzz0b \
  libepoxy0 \
  libfribidi0 \
  libthai0 \
  libfontconfig1 \
  libfreetype6 \
  # Fonts
  fonts-liberation \
  fonts-noto-color-emoji \
  fonts-noto-cjk \
  # Utilities
  wget \
  curl \
  unzip \
  xdg-utils \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set Chromium path untuk Puppeteer
ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Node.js dependencies
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Copy source code
COPY . .

# Create non-root user (security best practice)
RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port 7860 (Hugging Face standard)
EXPOSE 7860

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:7860/health || exit 1

# Start Express API
CMD ["node", "api/index.js"]
```

**File**: `hf-spaces/package.json`

```json
{
  "name": "hf-spaces-puppeteer",
  "version": "1.0.0",
  "description": "Puppeteer screenshot API for Hugging Face Spaces",
  "main": "api/index.js",
  "scripts": {
    "start": "node api/index.js",
    "dev": "node --watch api/index.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "puppeteer": "^21.0.0",
    "pdfjs-dist": "^3.11.174"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## 3. Express API dengan API Key Protection

**File**: `hf-spaces/api/index.js`

```javascript
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
const { fileURLToPath } = require('url');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 7860;
const API_KEY = process.env.HF_API_KEY || 'your-secret-api-key-here';
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB
const REQUEST_TIMEOUT = 30000; // 30 detik

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
  
  try {
    // Validate input
    const { pdf_base64 } = req.body;
    
    if (!pdf_base64) {
      return res.status(400).json({ error: 'Missing pdf_base64 in request body' });
    }

    // Decode PDF
    let pdfBuffer;
    try {
      pdfBuffer = Buffer.from(pdf_base64, 'base64');
    } catch (e) {
      return res.status(400).json({ error: 'Invalid base64 encoding' });
    }

    // Validate PDF size
    if (pdfBuffer.length > MAX_PDF_SIZE) {
      return res.status(413).json({ 
        error: 'PDF too large',
        maxSize: MAX_PDF_SIZE,
        received: pdfBuffer.length
      });
    }

    if (pdfBuffer.length < 100) {
      return res.status(400).json({ error: 'PDF too small (possibly empty)' });
    }

    console.log(`[${new Date().toISOString()}] Processing PDF: ${pdfBuffer.length} bytes`);

    // Launch browser
    const browser = await puppeteer.launch({
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
        '--single-process' // Important untuk memory limit
      ]
    });

    const page = await browser.newPage();
    
    // Set viewport (will be adjusted after crop)
    await page.setViewport({ 
      width: 2560, 
      height: 1440, 
      deviceScaleFactor: 2 
    });

    // Build HTML viewer (sama seperti Vercel)
    const html = buildHtmlViewer(pdfBuffer);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: REQUEST_TIMEOUT });

    // Wait for PDF render + crop
    await page.waitForFunction(() => document.body.dataset.ready === 'true', { 
      timeout: REQUEST_TIMEOUT 
    });
    
    // Delay untuk pastikan render selesai
    await new Promise(r => setTimeout(r, 2000));

    // Get content dimensions
    const contentWidth = await page.evaluate(() => 
      parseInt(document.body.dataset.contentWidth) || 0
    );
    const contentHeight = await page.evaluate(() => 
      parseInt(document.body.dataset.contentHeight) || 0
    );

    // Set viewport ke ukuran konten
    if (contentWidth > 0 && contentHeight > 0) {
      await page.setViewport({
        width: contentWidth,
        height: contentHeight,
        deviceScaleFactor: 2
      });
      await new Promise(r => setTimeout(r, 500));
    }

    // Screenshot
    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    await browser.close();

    const executionTime = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] Screenshot done: ${png.length} bytes in ${executionTime}ms`);

    // Return PNG
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'X-Execution-Time': executionTime,
      'X-PDF-Size': pdfBuffer.length,
      'X-PNG-Size': png.length
    });
    res.send(png);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err);
    res.status(500).json({ 
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// ============================================================
// HTML VIEWER BUILDER (sama seperti Vercel)
// ============================================================

function buildHtmlViewer(pdfBuffer) {
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
    s.textContent='Rendering '+pdf.numPages+' pages...';
    for(var i=1;i<=pdf.numPages;i++){
      s.textContent='Page '+i+'/'+pdf.numPages+'...';
      var page=await pdf.getPage(i);
      var vp=page.getViewport({scale:3});
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
```

---

## 4. Environment Variables untuk HF Spaces

**File**: `hf-spaces/.env.example`

```env
# API Key untuk proteksi endpoint
HF_API_KEY=your-secret-api-key-here

# Chromium path (optional, untuk debugging)
CHROME_PATH=/usr/bin/chromium

# Node environment
NODE_ENV=production
```

**Setup di Hugging Face:**
1. Buka HF Spaces → Settings → Variables and secrets
2. Add `HF_API_KEY` dengan value yang sama di Vercel/Cloudflare
3. Save

---

## 5. Integrasi dengan Vercel (API Gateway)

**File**: `vercel/api-gateway/api/route.js`

```javascript
/**
 * Vercel API Gateway
 * Menerima request dari Cloudflare Workers, forward ke HF Spaces
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pdf_base64 } = req.body;
  
  if (!pdf_base64) {
    return res.status(400).json({ error: 'Missing pdf_base64' });
  }

  // HF Spaces URL (ganti dengan URL aktual setelah deploy)
  const HF_SPACES_URL = process.env.HF_SPACES_URL || 'https://ba-1-a-b-cube-tech.hf.space';
  const HF_API_KEY = process.env.HF_API_KEY;

  try {
    const response = await fetch(`${HF_SPACES_URL}/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HF_API_KEY}`
      },
      body: JSON.stringify({ pdf_base64 })
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(response.status).json({ error: error.error || 'HF Spaces error' });
    }

    // Return PNG dari HF Spaces
    const pngBuffer = await response.arrayBuffer();
    
    res.set({
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.byteLength,
      'X-Execution-Time': response.headers.get('X-Execution-Time'),
      'X-PDF-Size': response.headers.get('X-PDF-Size'),
      'X-PNG-Size': response.headers.get('X-PNG-Size')
    });
    res.send(Buffer.from(pngBuffer));

  } catch (err) {
    console.error('HF Spaces proxy error:', err);
    return res.status(500).json({ error: 'Failed to connect to HF Spaces' });
  }
}
```

---

## 6. Update Cloudflare Workers (src/botSheet.js)

**Perubahan:**
- Ganti `VERCEL_PDF_TO_PNG_URL` ke `HF_SPACES_URL`
- Tambah header `Authorization: Bearer <HF_API_KEY>`

```javascript
// Lama:
const vercelUrl = env.VERCEL_PDF_TO_PNG_URL || "https://seatalkbot.vercel.app/api/pdf-to-png";

// Baru:
const hfSpacesUrl = env.HF_SPACES_URL || "https://ba-1-a-b-cube-tech.hf.space";
const hfApiKey = env.HF_API_KEY;

const response = await fetch(hfSpacesUrl, {
  method: "POST",
  headers: { 
    "Content-Type": "application/json",
    "Authorization": `Bearer ${hfApiKey}`
  },
  body: JSON.stringify({ pdf_base64: pdfBase64 })
});
```

---

## 7. Deployment Checklist

### HF Spaces:
- [ ] Push `hf-spaces/` folder ke GitHub repo `ba-1-a/B-Cube_Tech`
- [ ] HF Spaces auto-deploy dari GitHub
- [ ] Set `HF_API_KEY` di HF Spaces Settings → Variables
- [ ] Test health check: `https://ba-1-a-b-cube-tech.hf.space/health`
- [ ] Test screenshot dengan Postman/curl

### Vercel:
- [ ] Buat project baru `seatalkbot-api` di Vercel
- [ ] Connect ke folder `vercel/api-gateway`
- [ ] Set environment variables:
  - `HF_SPACES_URL`
  - `HF_API_KEY`
- [ ] Deploy

### Cloudflare Workers:
- [ ] Update `wrangler.toml` dengan secrets baru:
  - `HF_SPACES_URL`
  - `HF_API_KEY`
- [ ] Update `src/botSheet.js` untuk call HF Spaces
- [ ] Deploy: `npx wrangler deploy`

---

## 8. Testing Plan

### Stage 1: HF Spaces Local Test
```bash
cd hf-spaces
npm install
export HF_API_KEY=test-key
node api/index.js
# Test di terminal lain:
curl -H "Authorization: Bearer test-key" \
  -X POST http://localhost:7860/screenshot \
  -H "Content-Type: application/json" \
  -d '{"pdf_base64": "..."}'
```

### Stage 2: HF Spaces Deploy
- Deploy ke HF Spaces
- Test dengan 10 screenshots
- Monitor: memory usage, execution time, cold start

### Stage 3: Integration Test
- Test via Vercel API Gateway
- Test via Cloudflare Workers
- End-to-end test: SeaTalk → Cloudflare → Vercel → HF Spaces → PNG → SeaTalk

### Stage 4: Load Test
- 100 screenshots spread 1 jam
- Monitor: timeout, memory, error rate
- Target: 0% error, avg execution <15 detik

---

## 9. Rollback Plan

Jika HF Spaces bermasalah:
1. Ganti `HF_SPACES_URL` kembali ke Vercel URL
2. Atau: Gunakan Vercel sebagai primary, HF sebagai backup

---

## 10. Next Steps (Setelah Deploy)

- [ ] Setup pre-warm ping (Cloudflare Cron setiap 1 jam ke HF Spaces)
- [ ] Implementasi job queue di Supabase
- [ ] Setup rate limiting
- [ ] Monitoring dashboard (memory, execution time, error rate)
- [ ] Optimasi Docker image size (target <2GB)

---

## Catatan Penting

1. **HF Spaces tidak sleep** selama ada traffic setiap 48 jam
2. **Pre-warm ping** setiap 1 jam untuk mencegah cold start
3. **API Key** harus sama antara HF Spaces, Vercel, dan Cloudflare
4. **Port 7860** adalah standard HF Spaces (tidak bisa diubah)
5. **Memory limit 16GB** — Puppeteer single-process untuk hemat memory

---

## Referensi

- HF Spaces Docker: https://huggingface.co/docs/hub/spaces-sdks-docker
- Puppeteer best practices: https://pptr.dev/troubleshooting
- Express rate limiting: https://expressjs.com/en/resources/middleware/rate-limiter.html
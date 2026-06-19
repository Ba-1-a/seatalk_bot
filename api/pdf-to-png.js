/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF (base64) ke endpoint ini
 * - Vercel render PDF menggunakan pdfjs-dist via page.setContent()
 * 
 * CROPPING (V5 - 4-DIRECTIONAL EDGE SCAN):
 * - Tidak ada JS crop di browser (canvas dibiarkan utuh)
 * - Tidak ada sharp.trim() atau two-pass
 * - 4-directional edge scan menggunakan sharp.raw() di Node.js:
 *   Scan TOP, BOTTOM, LEFT, RIGHT secara independen
 *   Minimal 3 pixel non-white per baris/kolom (anti false positive)
 *   Potong tepat di batas konten — tanpa padding
 * 
 * Request: POST JSON { pdf_base64: "<base64 encoded pdf>" }
 * Response: image/png
 */

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const config = {
  runtime: 'nodejs'
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildHtmlViewer(pdfBase64, pdfjsCode, workerCode) {
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
    // CROP di-handle oleh server-side sharp (4-directional edge scan)
    // Canvas dibiarkan utuh untuk hasil screenshot maksimal
    s.textContent='Selesai';
    URL.revokeObjectURL(wu);
    document.body.dataset.ready='true';
  }).catch(function(e){
    document.getElementById('s').textContent='Error: '+e.message;
    document.body.dataset.error=e.message;
  });
})();
</script>
</body>
</html>`;
}

/**
 * 4-directional edge scan untuk memotong whitespace dari PNG.
 * 
 * Algoritma:
 * 1. Baca semua pixel PNG via sharp.raw()
 * 2. Scan TOP (y=0 → y=max): cari baris pertama dengan ≥3 pixel non-white
 * 3. Scan BOTTOM (y=max → y=0): cari baris terakhir dengan ≥3 pixel non-white
 * 4. Scan LEFT (x=0 → x=max): cari kolom pertama dengan ≥3 pixel non-white
 * 5. Scan RIGHT (x=max → x=0): cari kolom terakhir dengan ≥3 pixel non-white
 * 6. Jika scan tidak menemukan apapun, return buffer asli (aman)
 * 7. Crop menggunakan sharp.extract()
 * 
 * Threshold: 8 dari 255 (pixel dengan RGB > 247 dianggap putih)
 * Anti false positive: minimal 3 pixel non-white per baris/kolom
 * 
 * @param {Buffer} pngBuffer - Raw PNG buffer
 * @param {Object} sharpInstance - Sharp module instance
 * @returns {Buffer} Cropped PNG buffer
 */
async function cropWhitespace(pngBuffer, sharpInstance) {
  const meta = await sharpInstance(pngBuffer).metadata();
  const w = meta.width;
  const h = meta.height;
  
  console.log(`Crop scan: ${w}x${h}px`);
  
  // Baca semua pixel raw ke memory
  const rawBuffer = await sharpInstance(pngBuffer)
    .raw()
    .toBuffer();
  
  const TH = 8;      // Threshold: selisih dari 255
  const MIN_NON_WHITE = 3;  // Minimal pixel non-white per baris/kolom
  
  // Helper: cek apakah pixel di (x,y) adalah non-white
  function isNonWhite(x, y) {
    const idx = (y * w + x) * 3;
    const r = rawBuffer[idx];
    const g = rawBuffer[idx + 1];
    const b = rawBuffer[idx + 2];
    return Math.abs(r - 255) > TH || Math.abs(g - 255) > TH || Math.abs(b - 255) > TH;
  }
  
  // ============================================================
  // SCAN TOP: cari baris pertama (y terkecil) dengan konten
  // ============================================================
  let cropY1 = 0;
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (isNonWhite(x, y)) {
        count++;
        if (count >= MIN_NON_WHITE) break;
      }
    }
    if (count >= MIN_NON_WHITE) {
      cropY1 = y;
      console.log(`  TOP edge found at y=${y}`);
      break;
    }
  }
  if (cropY1 === 0) {
    // Tidak ada konten ditemukan — return asli
    console.log('  No content found, returning original');
    return pngBuffer;
  }
  
  // ============================================================
  // SCAN BOTTOM: cari baris terakhir (y terbesar) dengan konten
  // ============================================================
  let cropY2 = h - 1;
  for (let y = h - 1; y >= 0; y--) {
    let count = 0;
    for (let x = 0; x < w; x++) {
      if (isNonWhite(x, y)) {
        count++;
        if (count >= MIN_NON_WHITE) break;
      }
    }
    if (count >= MIN_NON_WHITE) {
      cropY2 = y;
      console.log(`  BOTTOM edge found at y=${y}`);
      break;
    }
  }
  
  // ============================================================
  // SCAN LEFT: cari kolom pertama (x terkecil) dengan konten
  // ============================================================
  let cropX1 = 0;
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = cropY1; y <= cropY2; y++) {
      if (isNonWhite(x, y)) {
        count++;
        if (count >= MIN_NON_WHITE) break;
      }
    }
    if (count >= MIN_NON_WHITE) {
      cropX1 = x;
      console.log(`  LEFT edge found at x=${x}`);
      break;
    }
  }
  
  // ============================================================
  // SCAN RIGHT: cari kolom terakhir (x terbesar) dengan konten
  // ============================================================
  let cropX2 = w - 1;
  for (let x = w - 1; x >= 0; x--) {
    let count = 0;
    for (let y = cropY1; y <= cropY2; y++) {
      if (isNonWhite(x, y)) {
        count++;
        if (count >= MIN_NON_WHITE) break;
      }
    }
    if (count >= MIN_NON_WHITE) {
      cropX2 = x;
      console.log(`  RIGHT edge found at x=${x}`);
      break;
    }
  }
  
  // Hitung dimensi hasil crop
  const cropW = cropX2 - cropX1 + 1;
  const cropH = cropY2 - cropY1 + 1;
  
  console.log(`  Crop region: left=${cropX1}, top=${cropY1}, width=${cropW}, height=${cropH}`);
  
  // ============================================================
  // EKSEKUSI CROP menggunakan sharp.extract()
  // ============================================================
  const croppedBuffer = await sharpInstance(pngBuffer)
    .extract({ left: cropX1, top: cropY1, width: cropW, height: cropH })
    .png()
    .toBuffer();
  
  console.log(`  Cropped PNG: ${croppedBuffer.length}B (saved ${pngBuffer.length - croppedBuffer.length}B)`);
  
  return croppedBuffer;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let browser;

  try {
    // Load sharp
    const sharpModule = await import('sharp');
    const sharpInstance = sharpModule.default;
    
    // Load pdfjs-dist
    const buildDir = path.resolve(__dirname, '../node_modules/pdfjs-dist/build');
    let pdfjsPath = path.join(buildDir, 'pdf.min.js');
    let workerPath = path.join(buildDir, 'pdf.worker.min.js');
    if (!fs.existsSync(pdfjsPath)) {
      const legacyDir = path.resolve(__dirname, '../node_modules/pdfjs-dist/legacy/build');
      pdfjsPath = path.join(legacyDir, 'pdf.min.js');
      workerPath = path.join(legacyDir, 'pdf.worker.min.js');
    }
    console.log(`pdfjs: ${pdfjsPath}`);
    const pdfjsCode = fs.readFileSync(pdfjsPath, 'utf-8');
    const workerCode = fs.readFileSync(workerPath, 'utf-8');

    // Get PDF buffer
    const ct = req.headers['content-type'] || '';
    let buf = null;
    if (ct.includes('json')) {
      const { pdf_base64 } = req.body || {};
      if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' });
      buf = Buffer.from(pdf_base64, 'base64');
    } else {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      buf = Buffer.concat(chunks);
    }
    if (!buf || buf.length < 100) return res.status(400).json({ error: 'PDF too small' });
    const b64 = buf.toString('base64');
    console.log(`PDF: ${buf.length}B`);

    // Launch browser
    const exe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath());
    browser = await puppeteer.launch({
      args: [...chromium.args, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      executablePath: exe,
      headless: chromium.headless,
      defaultViewport: { width: 2560, height: 1440, deviceScaleFactor: 2 }
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 2560, height: 1440, deviceScaleFactor: 2 });

    const html = buildHtmlViewer(b64, pdfjsCode, workerCode);
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });

    console.log('Waiting for PDF render...');
    try {
      await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
    } catch (e) {
      const err = await page.evaluate(() => document.body.dataset.error || null);
      if (err) throw new Error('PDF render error: ' + err);
      console.log('Timeout, proceeding...');
    }
    await new Promise(r => setTimeout(r, 3000));

    await page.evaluate(() => {
      document.getElementById('s').style.display = 'none';
    });

    // Delay 1 detik agar render sempurna sebelum screenshot
    await new Promise(r => setTimeout(r, 1000));

    var png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });
    console.log(`Raw PNG: ${png.length}B`);

    // Crop whitespace menggunakan 4-directional edge scan
    try {
      png = await cropWhitespace(png, sharpInstance);
    } catch (cropErr) {
      console.error('Crop failed, using raw PNG:', cropErr.message);
    }

    return res.status(200)
      .setHeader('Content-Type', 'image/png')
      .setHeader('Content-Length', png.length)
      .send(png);

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: err?.message || 'Failed' });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
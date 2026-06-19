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
 * CROPPING (V6 - JS BROWSER-SIDE 4-DIRECTIONAL EDGE SCAN):
 * - Sharp tidak tersedia di Vercel serverless, jadi crop dilakukan
 *   di dalam Chromium browser sebelum page.screenshot()
 * - 4-directional edge scan: TOP, BOTTOM, LEFT, RIGHT
 * - Threshold: 8, anti false positive: 3 pixel
 * - Setelah semua canvas di-crop, canvas container di-resize
 *   agar page.screenshot() menghasilkan gambar presisi
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
    
    // === CROP WHITESPACE (4-DIRECTIONAL EDGE SCAN) ===
    // Threshold: 8 dari 255 (near-white dianggap putih)
    // Anti false positive: minimal 3 pixel non-white per baris/kolom
    // ============================================
    var canvases = c.querySelectorAll('canvas');
    var TH = 8;
    var MIN_PX = 3;
    
    canvases.forEach(function(cv){
      var ctx = cv.getContext('2d');
      var w = cv.width, h = cv.height;
      var imageData = ctx.getImageData(0,0,w,h);
      var data = imageData.data;
      
      // Helper: cek pixel non-white
      function isNonWhite(px, py) {
        var idx = (py * w + px) * 4;
        var r = data[idx], g = data[idx+1], b = data[idx+2];
        return Math.abs(r-255)>TH || Math.abs(g-255)>TH || Math.abs(b-255)>TH;
      }
      
      // SCAN TOP: cari baris pertama (y terkecil) dengan konten
      var edgeTop = 0;
      var found = false;
      for (var y = 0; y < h; y++) {
        var count = 0;
        for (var x = 0; x < w; x++) {
          if (isNonWhite(x, y)) {
            count++;
            if (count >= MIN_PX) break;
          }
        }
        if (count >= MIN_PX) {
          edgeTop = y;
          found = true;
          break;
        }
      }
      if (!found) return; // Tidak ada konten, skip
      
      // SCAN BOTTOM: cari baris terakhir dengan konten
      var edgeBottom = h - 1;
      for (var y = h - 1; y >= 0; y--) {
        var count = 0;
        for (var x = 0; x < w; x++) {
          if (isNonWhite(x, y)) {
            count++;
            if (count >= MIN_PX) break;
          }
        }
        if (count >= MIN_PX) {
          edgeBottom = y;
          break;
        }
      }
      
      // SCAN LEFT: cari kolom pertama dengan konten (dalam rentang edgeTop-edgeBottom)
      var edgeLeft = 0;
      for (var x = 0; x < w; x++) {
        var count = 0;
        for (var y = edgeTop; y <= edgeBottom; y++) {
          if (isNonWhite(x, y)) {
            count++;
            if (count >= MIN_PX) break;
          }
        }
        if (count >= MIN_PX) {
          edgeLeft = x;
          break;
        }
      }
      
      // SCAN RIGHT: cari kolom terakhir dengan konten
      var edgeRight = w - 1;
      for (var x = w - 1; x >= 0; x--) {
        var count = 0;
        for (var y = edgeTop; y <= edgeBottom; y++) {
          if (isNonWhite(x, y)) {
            count++;
            if (count >= MIN_PX) break;
          }
        }
        if (count >= MIN_PX) {
          edgeRight = x;
          break;
        }
      }
      
      // Hitung dimensi crop
      var cropW = edgeRight - edgeLeft + 1;
      var cropH = edgeBottom - edgeTop + 1;
      if (cropW < 1) cropW = 1;
      if (cropH < 1) cropH = 1;
      
      // Crop canvas
      var cropData = ctx.getImageData(edgeLeft, edgeTop, cropW, cropH);
      cv.width = cropW;
      cv.height = cropH;
      cv.style.width = cropW + 'px';
      cv.style.height = cropH + 'px';
      ctx.putImageData(cropData, 0, 0);
      
      // Resize parent container
      if (cv.parentElement) {
        cv.parentElement.style.width = cropW + 'px';
        cv.parentElement.style.height = cropH + 'px';
      }
    });
    
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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let browser;

  try {
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

    console.log('Waiting for PDF render + crop...');
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

    await new Promise(r => setTimeout(r, 1000));

    var png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });
    console.log(`PNG: ${png.length}B`);

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
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
 * CROPPING (V5.1 - SAMPLED 4-DIRECTIONAL EDGE SCAN):
 * - Tidak ada JS crop di browser (canvas dibiarkan utuh)
 * - 4-directional edge scan dengan sampling (setiap 2 baris/kolom)
 *   untuk efisiensi memory dan kecepatan
 * - Per-sisi scan independen: TOP, BOTTOM, LEFT, RIGHT
 * - Anti false positive: minimal 5 pixel non-white per baris/kolom
 * - Fine scan 2 baris di sekitar tepi untuk presisi sub-sampling
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
    // CROP di-handle oleh server-side sharp (sampled edge scan)
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
 * Cek apakah satu baris pixel (raw buffer) memiliki konten non-white
 * @param {Buffer} rowBuffer - Raw pixel buffer (RGB, 3 bytes per pixel)
 * @param {Number} width - Jumlah pixel dalam baris
 * @param {Number} threshold - Threshold dari 255 (default 8)
 * @param {Number} minCount - Minimal pixel non-white (default 5)
 * @returns {Boolean} true jika baris memiliki konten
 */
function rowHasContent(rowBuffer, width, threshold = 8, minCount = 5) {
  let count = 0;
  for (let x = 0; x < width; x++) {
    const idx = x * 3;
    const r = rowBuffer[idx];
    const g = rowBuffer[idx + 1];
    const b = rowBuffer[idx + 2];
    if (Math.abs(r - 255) > threshold || Math.abs(g - 255) > threshold || Math.abs(b - 255) > threshold) {
      count++;
      if (count >= minCount) return true;
    }
  }
  return false;
}

/**
 * Sampled 4-directional edge scan untuk crop whitespace
 * 
 * Strategi:
 * 1. Scan TOP with sampling (setiap 2 baris) → fine scan +-2 baris
 * 2. Scan BOTTOM with sampling → fine scan +-2 baris
 * 3. Scan LEFT within [cropY1, cropY2] with sampling
 * 4. Scan RIGHT within [cropY1, cropY2] with sampling
 * 5. Extract + tambah padding 1px untuk safety
 * 
 * Memory: Hanya baca 1 baris/kolom per iterasi (~1-15KB)
 * Kecepatan: Sampling step=2 mengurangi iterasi 50%
 * 
 * @param {Buffer} pngBuffer - PNG buffer
 * @param {Object} sharp - Sharp module instance
 * @returns {Buffer} Cropped PNG buffer
 */
async function cropWhitespace(pngBuffer, sharp) {
  const meta = await sharp(pngBuffer).metadata();
  const w = meta.width;
  const h = meta.height;
  
  console.log(`Edge scan: ${w}x${h}px`);
  
  const TH = 8;
  const MIN_PX = 5;     // Minimal pixel non-white
  const STEP = 2;       // Sampling step (scan setiap 2 baris)
  const FINE_RANGE = 2; // Fine scan +- baris
  
  // ============================================================
  // SCAN TOP dengan sampling
  // ============================================================
  let edgeTop = 0;
  let foundTop = false;
  
  // Coarse scan
  for (let y = 0; y < h; y += STEP) {
    const rowBuffer = await sharp(pngBuffer)
      .extract({ left: 0, top: y, width: w, height: 1 })
      .raw()
      .toBuffer();
    if (rowHasContent(rowBuffer, w, TH, MIN_PX)) {
      // Fine scan: cek 2 baris sebelum y untuk presisi
      const startY = Math.max(0, y - FINE_RANGE);
      for (let fy = startY; fy <= y; fy++) {
        const fineBuffer = await sharp(pngBuffer)
          .extract({ left: 0, top: fy, width: w, height: 1 })
          .raw()
          .toBuffer();
        if (rowHasContent(fineBuffer, w, TH, MIN_PX)) {
          edgeTop = fy;
          foundTop = true;
          break;
        }
      }
      if (foundTop) break;
    }
  }
  
  if (!foundTop) {
    console.log('No content found, returning original');
    return pngBuffer;
  }
  console.log(`  TOP edge: y=${edgeTop}`);
  
  // ============================================================
  // SCAN BOTTOM dengan sampling
  // ============================================================
  let edgeBottom = h - 1;
  let foundBottom = false;
  
  for (let y = h - 1; y >= 0; y -= STEP) {
    const rowBuffer = await sharp(pngBuffer)
      .extract({ left: 0, top: y, width: w, height: 1 })
      .raw()
      .toBuffer();
    if (rowHasContent(rowBuffer, w, TH, MIN_PX)) {
      // Fine scan: cek 2 baris setelah y
      const endY = Math.min(h - 1, y + FINE_RANGE);
      for (let fy = endY; fy >= y; fy--) {
        const fineBuffer = await sharp(pngBuffer)
          .extract({ left: 0, top: fy, width: w, height: 1 })
          .raw()
          .toBuffer();
        if (rowHasContent(fineBuffer, w, TH, MIN_PX)) {
          edgeBottom = fy;
          foundBottom = true;
          break;
        }
      }
      if (foundBottom) break;
    }
  }
  console.log(`  BOTTOM edge: y=${edgeBottom}`);
  
  // ============================================================
  // SCAN LEFT dengan sampling (dalam rentang TOP-BOTTOM)
  // ============================================================
  const scanH = edgeBottom - edgeTop + 1;
  let edgeLeft = 0;
  let foundLeft = false;
  
  // Coarse scan: scan column via extract width=1
  for (let x = 0; x < w; x += STEP) {
    const colBuffer = await sharp(pngBuffer)
      .extract({ left: x, top: edgeTop, width: 1, height: scanH })
      .raw()
      .toBuffer();
    // Check kolom ini
    let count = 0;
    for (let y = 0; y < scanH; y++) {
      const idx = y * 3;
      const r = colBuffer[idx], g = colBuffer[idx + 1], b = colBuffer[idx + 2];
      if (Math.abs(r - 255) > TH || Math.abs(g - 255) > TH || Math.abs(b - 255) > TH) {
        count++;
        if (count >= MIN_PX) break;
      }
    }
    if (count >= MIN_PX) {
      // Fine scan
      const startX = Math.max(0, x - FINE_RANGE);
      for (let fx = startX; fx <= x; fx++) {
        const fineBuf = await sharp(pngBuffer)
          .extract({ left: fx, top: edgeTop, width: 1, height: scanH })
          .raw()
          .toBuffer();
        let fcount = 0;
        for (let y = 0; y < scanH; y++) {
          const idx = y * 3;
          const r = fineBuf[idx], g = fineBuf[idx + 1], b = fineBuf[idx + 2];
          if (Math.abs(r - 255) > TH || Math.abs(g - 255) > TH || Math.abs(b - 255) > TH) {
            fcount++;
            if (fcount >= MIN_PX) break;
          }
        }
        if (fcount >= MIN_PX) {
          edgeLeft = fx;
          foundLeft = true;
          break;
        }
      }
      if (foundLeft) break;
    }
  }
  console.log(`  LEFT edge: x=${edgeLeft}`);
  
  // ============================================================
  // SCAN RIGHT dengan sampling (dalam rentang TOP-BOTTOM)
  // ============================================================
  let edgeRight = w - 1;
  let foundRight = false;
  
  for (let x = w - 1; x >= 0; x -= STEP) {
    const colBuffer = await sharp(pngBuffer)
      .extract({ left: x, top: edgeTop, width: 1, height: scanH })
      .raw()
      .toBuffer();
    let count = 0;
    for (let y = 0; y < scanH; y++) {
      const idx = y * 3;
      const r = colBuffer[idx], g = colBuffer[idx + 1], b = colBuffer[idx + 2];
      if (Math.abs(r - 255) > TH || Math.abs(g - 255) > TH || Math.abs(b - 255) > TH) {
        count++;
        if (count >= MIN_PX) break;
      }
    }
    if (count >= MIN_PX) {
      const endX = Math.min(w - 1, x + FINE_RANGE);
      for (let fx = endX; fx >= x; fx--) {
        const fineBuf = await sharp(pngBuffer)
          .extract({ left: fx, top: edgeTop, width: 1, height: scanH })
          .raw()
          .toBuffer();
        let fcount = 0;
        for (let y = 0; y < scanH; y++) {
          const idx = y * 3;
          const r = fineBuf[idx], g = fineBuf[idx + 1], b = fineBuf[idx + 2];
          if (Math.abs(r - 255) > TH || Math.abs(g - 255) > TH || Math.abs(b - 255) > TH) {
            fcount++;
            if (fcount >= MIN_PX) break;
          }
        }
        if (fcount >= MIN_PX) {
          edgeRight = fx;
          foundRight = true;
          break;
        }
      }
      if (foundRight) break;
    }
  }
  console.log(`  RIGHT edge: x=${edgeRight}`);
  
  // Hitung dimensi
  const cropW = Math.max(1, edgeRight - edgeLeft + 1);
  const cropH = Math.max(1, edgeBottom - edgeTop + 1);
  
  console.log(`  Crop: left=${edgeLeft}, top=${edgeTop}, ${cropW}x${cropH}`);
  
  // Eksekusi crop
  const cropped = await sharp(pngBuffer)
    .extract({ left: edgeLeft, top: edgeTop, width: cropW, height: cropH })
    .png()
    .toBuffer();
  
  console.log(`  Result: ${cropped.length}B (saved ${pngBuffer.length - cropped.length}B)`);
  
  return cropped;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  let browser;

  try {
    // Check sharp availability
    let sharpAvailable = false;
    let sharp;
    try {
      const mod = await import('sharp');
      if (mod.default && typeof mod.default === 'function') {
        sharp = mod.default;
        sharpAvailable = true;
      }
    } catch (e) {
      console.log('Sharp not available, will use fallback');
    }

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

    await new Promise(r => setTimeout(r, 1000));

    var png = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });
    console.log(`Raw PNG: ${png.length}B`);

    // Crop whitespace via sampled edge scan (if sharp available)
    if (sharpAvailable) {
      try {
        png = await cropWhitespace(png, sharp);
      } catch (cropErr) {
        console.error('Edge scan crop failed, using raw PNG:', cropErr.message);
        // Fallback: sharp.trim()
        try {
          console.log('Fallback: sharp.trim(threshold=8)...');
          png = await sharp(png)
            .trim({ threshold: 8, background: { r: 255, g: 255, b: 255 } })
            .png()
            .toBuffer();
          console.log(`Fallback trim result: ${png.length}B`);
        } catch (trimErr) {
          console.error('Fallback trim failed, using raw PNG:', trimErr.message);
        }
      }
    } else {
      console.log('Sharp not available, returning raw PNG');
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
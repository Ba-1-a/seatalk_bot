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
 * CROPPING (FIXED WHITESPACE ISSUE - V3):
 * - HANYA sharp.trim() server-side — TIDAK ADA JS crop di browser
 * - Two-pass sharp.trim():
 *     Pass 1: threshold=8 — buang whitespace dominan (gridline, margin besar)
 *     Pass 2: threshold=4 — buang sisa padding near-white dari Google PDF
 * - Fallback: sharp.extract() manual (jika trim runtime error)
 * - No more JS DOM crop conflict!
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
    // === CROP WHITESPACE (REMOVED - handled by sharp.trim() server-side) ===
    // Semua crop di browser dihapus untuk menghindari conflict dengan sharp.
    // Canvas dibiarkan utuh, page.screenshot() mengambil gambar penuh.
    // sharp.trim() two-pass di server akan handle cropping.
    // ============================================
    
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
    // Try sharp first
    let sharpAvailable = false;
    try {
      const sharpModule = await import('sharp');
      if (sharpModule.default && typeof sharpModule.default === 'function') {
        sharpAvailable = true;
      }
    } catch (e) {
      // sharp not available, will use JS crop
    }

    console.log(`Sharp available: ${sharpAvailable}`);

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

    // Try sharp trim (if available) — TWO PASS cropping
    // Pass 1: threshold=8 buang whitespace dominan
    // Pass 2: threshold=4 buang sisa padding near-white Google PDF
    // Fallback: sharp.extract() manual scan pixel (tanpa JS browser)
    if (sharpAvailable) {
      try {
        const sharpModule = await import('sharp');
        const sharpInstance = sharpModule.default;
        
        // Pass 1: aggressive trim
        console.log('Sharp pass 1: trim(threshold=8)...');
        let trimmed = await sharpInstance(png)
          .trim({ threshold: 8, background: { r: 255, g: 255, b: 255 } })
          .png()
          .toBuffer();
        console.log(`Sharp pass 1 result: ${trimmed.length}B`);
        
        // Pass 2: fine trim untuk sisa padding near-white
        console.log('Sharp pass 2: trim(threshold=4)...');
        let fineTrimmed = await sharpInstance(trimmed)
          .trim({ threshold: 4, background: { r: 255, g: 255, b: 255 } })
          .png()
          .toBuffer();
        console.log(`Sharp pass 2 result: ${fineTrimmed.length}B (total saved ${png.length - fineTrimmed.length}B)`);
        
        png = fineTrimmed;
      } catch (sharpErr) {
        console.error('Sharp trim failed, trying manual crop fallback:', sharpErr.message);
        // Fallback: scan pixel manual di Node.js menggunakan sharp metadata + stats
        try {
          const sharpModule = await import('sharp');
          const sharpInstance = sharpModule.default;
          const meta = await sharpInstance(png).metadata();
          const stats = await sharpInstance(png).stats();
          const w = meta.width, h = meta.height;
          const channels = stats.channels;
          
          // Cari bounding box konten (threshold 8)
          // Sampling pixel dari edge untuk efisiensi
          let minX = w, minY = h, maxX = 0, maxY = 0;
          
          // Scan horizontal: cari baris pertama & terakhir yang punya non-white
          for (let y = 0; y < h; y++) {
            // Sample pixel di baris ini
            const region = await sharpInstance(png)
              .extract({ left: 0, top: y, width: w, height: 1 })
              .raw()
              .toBuffer();
            let hasContent = false;
            for (let x = 0; x < w; x++) {
              const idx = x * 3;
              const r = region[idx], g = region[idx+1], b = region[idx+2];
              if (Math.abs(r - 255) > 8 || Math.abs(g - 255) > 8 || Math.abs(b - 255) > 8) {
                hasContent = true;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
              }
            }
            if (hasContent) {
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
          
          if (minX < w && minY < h && maxX > 0 && maxY > 0) {
            // Tambah padding 1px
            minX = Math.max(0, minX - 1);
            minY = Math.max(0, minY - 1);
            maxX = Math.min(w - 1, maxX + 1);
            maxY = Math.min(h - 1, maxY + 1);
            
            const cropW = maxX - minX + 1;
            const cropH = maxY - minY + 1;
            
            console.log(`Manual crop fallback: extracting ${cropW}x${cropH} at (${minX},${minY})`);
            png = await sharpInstance(png)
              .extract({ left: minX, top: minY, width: cropW, height: cropH })
              .png()
              .toBuffer();
            console.log(`Manual crop result: ${png.length}B`);
          } else {
            console.log('Manual crop: no content found, using raw PNG');
          }
        } catch (fallbackErr) {
          console.error('All crop fallbacks failed, using raw PNG:', fallbackErr.message);
        }
      }
    } else {
      console.log('Sharp not available, trying manual pixel scan crop...');
      try {
        const sharpModule = await import('sharp');
        const sharpInstance = sharpModule.default;
        // Fallback sama seperti di atas
        const meta = await sharpInstance(png).metadata();
        const w = meta.width, h = meta.height;
        let minX = w, minY = h, maxX = 0, maxY = 0;
        
        // Sample rows untuk efisiensi
        const sampleStep = Math.max(1, Math.floor(h / 200));
        for (let y = 0; y < h; y += sampleStep) {
          const region = await sharpInstance(png)
            .extract({ left: 0, top: y, width: w, height: 1 })
            .raw()
            .toBuffer();
          let hasContent = false;
          for (let x = 0; x < w; x++) {
            const idx = x * 3;
            const r = region[idx], g = region[idx+1], b = region[idx+2];
            if (Math.abs(r - 255) > 8 || Math.abs(g - 255) > 8 || Math.abs(b - 255) > 8) {
              hasContent = true;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
            }
          }
          if (hasContent) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        
        if (minX < w && minY < h && maxX > 0 && maxY > 0) {
          minX = Math.max(0, minX - 1);
          minY = Math.max(0, minY - 1);
          maxX = Math.min(w - 1, maxX + 1);
          maxY = Math.min(h - 1, maxY + 1);
          const cropW = maxX - minX + 1;
          const cropH = maxY - minY + 1;
          console.log(`Manual crop: extracting ${cropW}x${cropH} at (${minX},${minY})`);
          png = await sharpInstance(png)
            .extract({ left: minX, top: minY, width: cropW, height: cropH })
            .png()
            .toBuffer();
          console.log(`Manual crop result: ${png.length}B`);
        }
      } catch (fallbackErr) {
        console.error('Manual crop failed, using raw PNG:', fallbackErr.message);
      }
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
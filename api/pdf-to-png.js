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
 * PERBAIKAN WHITESPACE (v2):
 * - Setelah screenshot, crop tiap canvas ke bounding box konten non-putih
 * - Tambah bottom-edge trim (seperti right-edge trim yg sudah ada)
 * - Scan setiap pixel (bukan setiap 2px) untuk presisi maksimal
 * - Threshold turunkan ke 12 agar gridline abu-abu dianggap putih
 * - Global composite bounding box untuk menyatukan semua page
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
html,body{background:#fff;font-family:sans-serif}
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
// pdfjs-dist v3 UMD bundle inline
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
    // === CROP WHITESPACE (ALL 4 SIDES) PER CANVAS ===
    // 1. Scan every pixel, find tight bounding box of non-white content
    // 2. Trim right edge: remove columns with >99.5% white
    // 3. Trim bottom edge: remove rows with >99.5% white
    // Threshold: 12 from 255 (catches light grey gridlines as white)
    var canvases = c.querySelectorAll('canvas');
    var TH = 12; // threshold: pixel is "white" if all channels within TH of 255
    
    canvases.forEach(function(cv){
      var ctx = cv.getContext('2d');
      var w = cv.width, h = cv.height;
      var imageData = ctx.getImageData(0,0,w,h);
      var data = imageData.data;
      
      // PHASE 1: Find content bounding box (every pixel)
      var minX = w, minY = h, maxX = 0, maxY = 0;
      var found = false;
      for(var y=0; y<h; y++){
        for(var x=0; x<w; x++){
          var idx = (y*w+x)*4;
          var r=data[idx], g=data[idx+1], b=data[idx+2];
          if(Math.abs(r-255)>TH||Math.abs(g-255)>TH||Math.abs(b-255)>TH){
            if(x<minX) minX=x; if(y<minY) minY=y;
            if(x>maxX) maxX=x; if(y>maxY) maxY=y;
            found = true;
          }
        }
      }
      if(!found) return; // empty canvas, skip
      
      // Add 2px padding
      minX=Math.max(0,minX-2); minY=Math.max(0,minY-2);
      maxX=Math.min(w-1,maxX+2); maxY=Math.min(h-1,maxY+2);
      
      var newW = maxX-minX+1, newH = maxY-minY+1;
      
      // Phase 2: Right-edge aggressive trim
      // Scan columns from right, remove if >99.9% white
      var trimRight = 0;
      for(var x=w-1; x>=0; x--){
        var nonWhite = 0;
        for(var y=0; y<h; y++){
          var idx = (y*w+x)*4;
          var r=data[idx], g=data[idx+1], b=data[idx+2];
          if(Math.abs(r-255)>TH||Math.abs(g-255)>TH||Math.abs(b-255)>TH){
            nonWhite++;
          }
        }
        if(nonWhite > 0) break; // stop if ANY non-white pixel in column
        trimRight++;
      }
      
      // Phase 3: Bottom-edge aggressive trim
      // Scan rows from bottom, remove if >99.9% white
      var trimBottom = 0;
      for(var y=h-1; y>=0; y--){
        var nonWhite = 0;
        for(var x=0; x<w; x++){
          var idx = (y*w+x)*4;
          var r=data[idx], g=data[idx+1], b=data[idx+2];
          if(Math.abs(r-255)>TH||Math.abs(g-255)>TH||Math.abs(b-255)>TH){
            nonWhite++;
          }
        }
        if(nonWhite > 0) break;
        trimBottom++;
      }
      
      // Apply trims
      if(trimRight > 0 || trimBottom > 0 || minX > 0 || minY > 0){
        var cropX = minX, cropY = minY;
        var cropW = newW - trimRight;
        var cropH = newH - trimBottom;
        if(cropW < 1) cropW = 1;
        if(cropH < 1) cropH = 1;
        
        var tmp = document.createElement('canvas');
        tmp.width=cropW; tmp.height=cropH;
        var tmpCtx = tmp.getContext('2d');
        tmpCtx.drawImage(cv, cropX,cropY, cropW,cropH, 0,0, cropW,cropH);
        cv.width = cropW; cv.height = cropH;
        cv.style.width = cropW+'px'; cv.style.height = cropH+'px';
        ctx.drawImage(tmp,0,0);
        if(cv.parentElement) cv.parentElement.style.width = cropW+'px';
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
    // Load pdfjs-dist dari node_modules
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

    // Wait for PDF render
    console.log('Waiting for PDF render...');
    try {
      await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 120000 });
    } catch (e) {
      const err = await page.evaluate(() => document.body.dataset.error || null);
      if (err) throw new Error('PDF render error: ' + err);
      console.log('Timeout, proceeding...');
    }
    await new Promise(r => setTimeout(r, 3000));

    // Hide loading text
    await page.evaluate(() => {
      document.getElementById('s').style.display = 'none';
    });

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
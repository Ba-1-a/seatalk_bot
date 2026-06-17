/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF (base64) ke endpoint ini
 * - Vercel render PDF menggunakan pdfjs-dist via page.setContent()
 * - page.setContent() tidak punya batasan size data: URI
 * 
 * Kenapa page.setContent() bukan data: URI:
 * - data: URI dengan pdfjs-dist ~1.5MB menyebabkan ERR_ABORTED
 * - page.setContent() inject HTML langsung tanpa encoding URI
 * - @sparticuz/chromium tidak support navigasi ke PDF (ERR_ABORTED)
 * - Tapi support JavaScript canvas dengan baik
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
  // Embed pdf.min.js content and worker as blob URL
  // NO padding/margin/background - only pure canvas content
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;overflow-x:hidden;background:#fff}
body{font-family:sans-serif}
#c{display:flex;flex-direction:column;align-items:flex-start;gap:0}
.pw{display:inline-block;line-height:0;overflow:hidden}
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
  // Setup worker via blob URL
  var wb = new Blob([${JSON.stringify(workerCode)}], {type:'application/javascript'});
  var wu = URL.createObjectURL(wb);
  pdfjsLib.GlobalWorkerOptions.workerSrc = wu;

  // Read PDF from base64 embedded in page
  var b64 = ${JSON.stringify(pdfBase64)};
  var bytes = Uint8Array.from(atob(b64), function(c){return c.charCodeAt(0)});

  pdfjsLib.getDocument({data: bytes}).promise.then(async function(pdf){
    var c=document.getElementById('c'), s=document.getElementById('s');
    s.textContent='Rendering '+pdf.numPages+' pages...';
    for(var i=1;i<=pdf.numPages;i++){
      s.textContent='Page '+i+'/'+pdf.numPages+'...';
      var page=await pdf.getPage(i);
      // Use higher scale (3x) for better quality
      var vp=page.getViewport({scale:3});
      var w=document.createElement('div');
      w.className='pw';
      var cv=document.createElement('canvas');
      // Set explicit size on canvas
      cv.width=vp.width; cv.height=vp.height;
      cv.style.width=vp.width+'px'; cv.style.height=vp.height+'px';
      w.appendChild(cv); c.appendChild(w);
      var ctx=cv.getContext('2d');
      ctx.fillStyle='#FFFFFF';
      ctx.fillRect(0,0,vp.width,vp.height);
      await page.render({canvasContext:ctx, viewport:vp}).promise;
    }
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
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 }
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });

    // Use page.setContent() instead of data: URI to avoid size limits
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

    // Screenshot - smart crop to actual visible content (eliminate ALL whitespace)
    // Scans canvas pixels to find the tightest bounding box around non-white content
    // This eliminates PDF page margins and padding even within the rendered canvas
    const clipRect = await page.evaluate(() => {
      const canvases = document.querySelectorAll('#c canvas');
      if (canvases.length === 0) return null;
      
      // Find the tight bounding box across ALL canvases by scanning pixels
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      canvases.forEach(function(canvas) {
        var ctx = canvas.getContext('2d');
        var w = canvas.width;
        var h = canvas.height;
        var imageData = ctx.getImageData(0, 0, w, h);
        var data = imageData.data;
        var stride = 4; // RGBA
        
        // We sample every 4th pixel for performance (check pixels at 4px intervals)
        // Also check edge pixels more thoroughly
        var step = 4;
        
        // Scan horizontally for first non-white pixel (top)
        var foundTop = false;
        for (var y = 0; y < h; y += step) {
          for (var x = 0; x < w; x += step) {
            var idx = (y * w + x) * stride;
            var r = data[idx], g = data[idx+1], b = data[idx+2];
            // Consider pixel non-white if any channel differs from white by >30
            if (Math.abs(r - 255) > 30 || Math.abs(g - 255) > 30 || Math.abs(b - 255) > 30) {
              if (y < minY) minY = y;
              foundTop = true;
              break;
            }
          }
          if (foundTop) break;
        }
        
        // Scan from bottom
        var foundBottom = false;
        for (var y = h - 1; y >= 0; y -= step) {
          for (var x = 0; x < w; x += step) {
            var idx = (y * w + x) * stride;
            var r = data[idx], g = data[idx+1], b = data[idx+2];
            if (Math.abs(r - 255) > 30 || Math.abs(g - 255) > 30 || Math.abs(b - 255) > 30) {
              if (y > maxY) maxY = y;
              foundBottom = true;
              break;
            }
          }
          if (foundBottom) break;
        }
        
        // Scan from left
        var foundLeft = false;
        for (var x = 0; x < w; x += step) {
          for (var y = 0; y < h; y += step) {
            var idx = (y * w + x) * stride;
            var r = data[idx], g = data[idx+1], b = data[idx+2];
            if (Math.abs(r - 255) > 30 || Math.abs(g - 255) > 30 || Math.abs(b - 255) > 30) {
              if (x < minX) minX = x;
              foundLeft = true;
              break;
            }
          }
          if (foundLeft) break;
        }
        
        // Scan from right
        var foundRight = false;
        for (var x = w - 1; x >= 0; x -= step) {
          for (var y = 0; y < h; y += step) {
            var idx = (y * w + x) * stride;
            var r = data[idx], g = data[idx+1], b = data[idx+2];
            if (Math.abs(r - 255) > 30 || Math.abs(g - 255) > 30 || Math.abs(b - 255) > 30) {
              if (x > maxX) maxX = x;
              foundRight = true;
              break;
            }
          }
          if (foundRight) break;
        }
      });
      
      // Add 2px padding around content for safety (avoid clipping borders)
      var pad = 2;
      if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
        // Get canvas rendered position on screen (for clipping in screenshot coords)
        var container = document.getElementById('c');
        var rect = container.getBoundingClientRect();
        
        // Account for devicePixelRatio in the rendering
        // The canvas is rendered at 3x scale (from pdfjs), but displayed at 1x CSS pixels
        // We need to map canvas pixel coords to CSS/screenshot pixel coords
        var firstCanvas = canvases[0];
        var cssWidth = firstCanvas.style.width ? parseInt(firstCanvas.style.width) : firstCanvas.width;
        var scaleX = cssWidth / firstCanvas.width;
        var scaleY = cssWidth / firstCanvas.width; // square
        
        return {
          x: Math.round(rect.x + minX * scaleX - pad),
          y: Math.round(rect.y + minY * scaleY - pad),
          width: Math.round((maxX - minX) * scaleX + pad * 2),
          height: Math.round((maxY - minY) * scaleY + pad * 2)
        };
      }
      return null;
    });

    let png;
    if (clipRect && clipRect.width > 0 && clipRect.height > 0) {
      console.log(`Clipping to canvas area: ${JSON.stringify(clipRect)}`);
      png = await page.screenshot({
        type: 'png',
        omitBackground: false,
        clip: clipRect
      });
    } else {
      // Fallback: full page screenshot
      png = await page.screenshot({ type: 'png', fullPage: true, omitBackground: false });
    }
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
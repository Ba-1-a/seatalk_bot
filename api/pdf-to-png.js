/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG menggunakan Puppeteer + pdfjs-dist.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF (base64) ke endpoint ini
 * - Vercel render PDF via pdfjs-dist (dari node_modules) di Puppeteer browser
 * - pdfjs-dist di-inline ke HTML (no CDN, reliable di Vercel)
 * 
 * Kenapa inline pdfjs-dist:
 * - @sparticuz/chromium tidak support Chrome PDF viewer (ERR_ABORTED)
 * - Vercel serverless kadang tidak bisa fetch CDN
 * - pdfjs-dist di-inject langsung dari node_modules sebagai <script>
 * - Render PDF asli ke canvas (bukan HTML rekonstruksi!)
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

/**
 * Load pdfjs-dist v3 UMD build dari node_modules
 * V3 menggunakan pola UMD: <script src="pdf.min.js"> -> window.pdfjsLib tersedia
 */
function loadPdfjsBundle() {
  // Coba legacy build dulu, fallback ke build biasa
  let pdfjsPath = path.resolve(__dirname, '../node_modules/pdfjs-dist/build/pdf.min.js');
  let workerPath = path.resolve(__dirname, '../node_modules/pdfjs-dist/build/pdf.worker.min.js');
  
  if (!fs.existsSync(pdfjsPath)) {
    pdfjsPath = path.resolve(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.min.js');
    workerPath = path.resolve(__dirname, '../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js');
  }
  
  console.log(`Loading pdfjs from: ${pdfjsPath}`);
  const pdfjsContent = fs.readFileSync(pdfjsPath, 'utf-8');
  const workerContent = fs.readFileSync(workerPath, 'utf-8');
  
  return { pdfjsContent, workerContent };
}

function buildHtml(pdfBase64, pdfjsCode, workerCode) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #e8e8e8; font-family: sans-serif; padding: 20px; }
  .page-wrap { background: #fff; box-shadow: 0 2px 8px rgba(0,0,0,0.15); margin: 0 auto 20px auto; overflow: hidden; }
  .page-wrap canvas { display: block; }
  #status { text-align: center; padding: 20px; color: #666; }
</style>
</head>
<body>
<div id="status">Loading PDF...</div>
<div id="pages"></div>
<script>
// pdfjs-dist v3 UMD - di-inject langsung dari node_modules
${pdfjsCode}
</script>
<script>
(function() {
  // Worker juga di-inject sebagai blob URL
  var workerBlob = new Blob([${JSON.stringify(workerCode)}], { type: 'application/javascript' });
  var workerUrl = URL.createObjectURL(workerBlob);
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  
  var b64 = '${pdfBase64}';
  var bytes = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
  
  pdfjsLib.getDocument({ data: bytes }).promise.then(async function(pdf) {
    var container = document.getElementById('pages');
    var statusEl = document.getElementById('status');
    statusEl.textContent = 'Rendering ' + pdf.numPages + ' halaman...';
    
    for (var i = 1; i <= pdf.numPages; i++) {
      statusEl.textContent = 'Halaman ' + i + '/' + pdf.numPages + '...';
      var page = await pdf.getPage(i);
      var viewport = page.getViewport({ scale: 2 });
      
      var wrap = document.createElement('div');
      wrap.className = 'page-wrap';
      wrap.style.width = viewport.width + 'px';
      
      var canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      wrap.appendChild(canvas);
      container.appendChild(wrap);
      
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, viewport.width, viewport.height);
      
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    }
    
    statusEl.textContent = 'Selesai';
    document.body.dataset.ready = 'true';
    URL.revokeObjectURL(workerUrl);
  }).catch(function(err) {
    document.getElementById('status').textContent = 'Error: ' + err.message;
    document.body.dataset.error = err.message;
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
    console.log('Loading pdfjs-dist v3 from node_modules...');
    const { pdfjsContent, workerContent } = loadPdfjsBundle();
    console.log(`pdfjs: ${pdfjsContent.length}B, worker: ${workerContent.length}B`);

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

    // Load HTML (pdfjs-dist inline, no external deps!)
    const html = buildHtml(b64, pdfjsContent, workerContent);
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html), {
      waitUntil: 'networkidle0',
      timeout: 90000
    });

    // Wait for render
    console.log('Waiting for PDF render...');
    try {
      await page.waitForFunction(() => document.body.dataset.ready === 'true', { timeout: 60000 });
    } catch (e) {
      const err = await page.evaluate(() => document.body.dataset.error || null);
      if (err) throw new Error('PDF render error: ' + err);
      console.log('Timeout, proceeding...');
    }
    await new Promise(r => setTimeout(r, 2000));

    // Screenshot
    const png = await page.screenshot({ type: 'png', fullPage: true, omitBackground: false });
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
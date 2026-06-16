/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG menggunakan Puppeteer.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF (base64) ke endpoint ini
 * - Vercel render PDF via Puppeteer + pdfjs-dist canvas rendering
 * 
 * KENAPA Pendekatan ini:
 * - @sparticuz/chromium TIDAK support navigasi langsung ke PDF viewer
 * - Chrome headless ERR_ABORTED untuk PDF URI
 * - pdfjs-dist render halaman PDF ke canvas -> PNG buffer
 * - Gabungkan semua halaman jadi satu PNG
 * 
 * Request: POST JSON { pdf_base64: "<base64 encoded pdf>" }
 * Response: image/png
 */

import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

export const config = {
  runtime: 'nodejs'
};

/**
 * Buat HTML page yang render PDF menggunakan pdfjs-dist (CDN JS)
 * Setiap halaman PDF di-render ke canvas, lalu di-screenshot
 */
function buildPdfViewerHtml(pdfBase64) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { 
    background: #e8e8e8; 
    font-family: sans-serif;
    padding: 20px;
  }
  .page-container {
    background: white;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    margin: 0 auto 20px auto;
    page-break-after: always;
  }
  .page-container canvas {
    display: block;
    width: 100%;
    height: auto;
  }
  .status {
    text-align: center;
    padding: 20px;
    color: #666;
  }
</style>
</head>
<body>
<div id="status" class="status">Loading PDF...</div>
<div id="pages"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.js"></script>
<script>
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.js';

const pdfBase64 = '${pdfBase64}';
const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));

pdfjsLib.getDocument({ data: pdfBytes }).promise.then(async (pdf) => {
  const container = document.getElementById('pages');
  const status = document.getElementById('status');
  status.textContent = '';
  
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    
    const pageDiv = document.createElement('div');
    pageDiv.className = 'page-container';
    pageDiv.style.width = viewport.width + 'px';
    pageDiv.style.height = viewport.height + 'px';
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    pageDiv.appendChild(canvas);
    container.appendChild(pageDiv);
    
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
  }
  
  // Tandai selesai untuk Puppeteer
  document.body.dataset.ready = 'true';
}).catch(err => {
  document.getElementById('status').textContent = 'Error: ' + err.message;
  document.body.dataset.error = err.message;
});
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let browser;

  try {
    // ============================================================
    // STEP 1: Dapatkan PDF buffer
    // ============================================================
    const contentType = req.headers['content-type'] || '';

    let pdfBuffer = null;
    if (contentType.includes('application/json')) {
      const { pdf_base64 } = req.body || {};
      if (!pdf_base64) {
        return res.status(400).json({ error: 'pdf_base64 wajib diisi untuk format JSON.' });
      }
      pdfBuffer = Buffer.from(pdf_base64, 'base64');
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      pdfBuffer = Buffer.concat(chunks);
    }

    if (!pdfBuffer || pdfBuffer.length < 100) {
      return res.status(400).json({ error: 'PDF buffer terlalu kecil atau kosong.' });
    }

    const pdfBase64 = pdfBuffer.toString('base64');
    console.log(`PDF received: ${pdfBuffer.length} bytes`);

    // ============================================================
    // STEP 2: Launch browser dan render PDF viewer HTML
    // ============================================================
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath());
    console.log(`Chrome executable: ${execPath}`);

    browser = await puppeteer.launch({
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ],
      executablePath: execPath,
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1440,
        height: 900,
        deviceScaleFactor: 2
      }
    });

    const page = await browser.newPage();
    await page.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: 2
    });

    // Build HTML viewer dengan pdfjs-dist CDN
    const htmlContent = buildPdfViewerHtml(pdfBase64);
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);

    console.log('Loading PDF viewer HTML...');
    await page.goto(dataUrl, { 
      waitUntil: 'networkidle0', 
      timeout: 60000 
    });

    // Tunggu pdfjs-dist selesai render semua halaman
    console.log('Waiting for PDF rendering...');
    try {
      await page.waitForFunction(
        () => document.body.dataset.ready === 'true',
        { timeout: 45000 }
      );
    } catch (timeoutError) {
      // Cek apakah ada error
      const errorText = await page.evaluate(() => document.body.dataset.error || null);
      if (errorText) {
        throw new Error(`PDF rendering error: ${errorText}`);
      }
      // Jika masih loading, lanjutkan dengan screenshoot apa adanya
      console.log('PDF rendering might still be in progress, proceeding...');
    }

    // Extra wait for rendering to complete
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('PDF rendered, taking screenshot...');

    // ============================================================
    // STEP 3: Screenshot halaman dengan PDF viewer
    // ============================================================
    // Ambil screenshot full page (semua halaman PDF akan terlihat)
    const pngBuffer = await page.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    console.log(`Screenshot generated: ${pngBuffer.length} bytes`);

    return res
      .status(200)
      .setHeader('Content-Type', 'image/png')
      .setHeader('Content-Length', pngBuffer.length)
      .send(pngBuffer);

  } catch (error) {
    console.error('PDF-to-PNG error:', error);
    return res.status(500).json({ 
      error: error?.message || 'Gagal convert PDF ke PNG.'
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
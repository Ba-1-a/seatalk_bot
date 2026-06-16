/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG menggunakan Puppeteer.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF binary ke endpoint ini
 * - Vercel render PDF native di Chrome (bukan HTML buatan!) -> screenshot PNG
 * - Kirim PNG balik ke Cloudflare Worker
 * 
 * ALUR: Export PDF (Google Drive API) -> PDF to PNG (Vercel Puppeteer) -> PNG kirim ke SeaTalk
 * 
 * Request: POST multipart/form-data dengan field "pdf" (file PDF)
 *    ATAU: POST application/octet-stream dengan body raw PDF buffer
 *    ATAU: POST application/json dengan { pdf_base64: "<base64 encoded pdf>" }
 * Response: image/png
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const config = {
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let browser;

  try {
    // ============================================================
    // STEP 1: Dapatkan PDF buffer dari berbagai format input
    // ============================================================
    let pdfBuffer = null;
    const contentType = req.headers['content-type'] || '';

    if (contentType.includes('application/json')) {
      // Format JSON: { pdf_base64: "..." }
      const { pdf_base64 } = req.body || {};
      if (!pdf_base64) {
        return res.status(400).json({ error: 'pdf_base64 wajib diisi untuk format JSON.' });
      }
      pdfBuffer = Buffer.from(pdf_base64, 'base64');
    } else if (contentType.includes('multipart/form-data')) {
      // Format multipart: field "pdf" berisi file PDF
      // NOTE: Vercel serverless tidak mendukung multer built-in,
      // jadi kita gunakan raw buffer approach
      return res.status(400).json({ error: 'Gunakan format application/octet-stream atau JSON.' });
    } else {
      // Format raw: body adalah PDF buffer langsung
      // Read raw body
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      pdfBuffer = Buffer.concat(chunks);
    }

    if (!pdfBuffer || pdfBuffer.length < 100) {
      return res.status(400).json({ error: 'PDF buffer terlalu kecil atau kosong.' });
    }

    console.log(`PDF received: ${pdfBuffer.length} bytes`);

    // ============================================================
    // STEP 2: Render PDF di Chrome native (bukan HTML buatan!)
    // ============================================================
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath()),
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

    // Render PDF native di Chrome menggunakan data URL
    // Chrome native PDF viewer akan merender dengan formatting asli
    const pdfBase64 = pdfBuffer.toString('base64');
    const dataUrl = `data:application/pdf;base64,${pdfBase64}`;
    
    await page.goto(dataUrl, { 
      waitUntil: 'networkidle0', 
      timeout: 60000 
    });

    // Tunggu Chrome PDF viewer selesai render
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log('PDF rendered in Chrome native viewer');

    // ============================================================
    // STEP 3: Screenshot halaman PDF (bukan HTML buatan!)
    // ============================================================
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
      error: error?.message || 'Gagal convert PDF ke PNG.',
      stack: error?.stack?.substring(0, 500)
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
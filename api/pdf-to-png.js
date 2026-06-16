/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk mengubah PDF hasil export Google Sheets menjadi PNG.
 * 
 * ARSITEKTUR:
 * - Vercel hanya sebagai HELPER untuk PDF -> PNG conversion (menggunakan Puppeteer)
 * - Cloudflare Workers tetap menjadi Event Callback utama untuk SeaTalk
 * - Tidak menggunakan API screenshot freemium (htmlcsstoimage, screenshotapi.net, dll)
 * 
 * Alur lengkap screenshot:
 * 1. Cloudflare Worker: Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Cloudflare Worker: POST PDF base64 ke endpoint ini (Vercel)
 * 3. Vercel: Puppeteer render PDF -> screenshot PNG
 * 4. Cloudflare Worker: Kirim PNG ke SeaTalk via base64
 * 
 * Request: POST JSON { pdf_base64, page, scale }
 * Response: image/png
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const config = {
  runtime: 'nodejs'
};

function normalizePdfBase64(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/^data:application\/pdf;base64,/i, '')
    .replace(/^data:application\/x-pdf;base64,/i, '')
    .replace(/\s+/g, '');
}

function isValidBase64(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let tmpDir;
  let browser;

  try {
    const { pdf_base64, page = 1, scale = 2 } = req.body || {};
    const normalizedPdfBase64 = normalizePdfBase64(pdf_base64);

    if (!normalizedPdfBase64 || !isValidBase64(normalizedPdfBase64)) {
      return res.status(400).json({ error: 'pdf_base64 wajib diisi dan harus valid.' });
    }

    const pageNumber = Math.max(1, Math.min(Number(page) || 1, 10));
    const scaleFactor = Math.max(1, Math.min(Number(scale) || 2, 4));

    const pdfBuffer = Buffer.from(normalizedPdfBase64, 'base64');
    if (pdfBuffer.length === 0 || pdfBuffer.toString('ascii', 0, 4) !== '%PDF') {
      return res.status(400).json({ error: 'pdf_base64 bukan file PDF valid.' });
    }

    // Simpan PDF ke file temp untuk dibaca Chromium
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vasa-pdf-to-png-'));
    const pdfPath = path.join(tmpDir, 'input.pdf');
    await fs.writeFile(pdfPath, pdfBuffer);

    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath()),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: 1440,
        height: 900,
        deviceScaleFactor: scaleFactor
      }
    });

    const pageHandle = await browser.newPage();
    await pageHandle.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: scaleFactor
    });

    // Buat HTML page yang embed PDF via object tag
    // Ini lebih reliable daripada langsung buka file:// PDF di headless Chromium
    const htmlContent = `<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { width: 1440px; min-height: 900px; overflow: hidden; }
  embed { width: 100%; height: 100vh; }
</style></head>
<body>
  <embed type="application/pdf" src="${pdfPath}#page=${pageNumber}" width="100%" height="100%">
</body></html>`;

    await pageHandle.setContent(htmlContent, { waitUntil: 'load', timeout: 30000 });

    // Tunggu render
    await new Promise(resolve => setTimeout(resolve, 3000));

    await pageHandle.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    }).catch(() => undefined);

    const pngBuffer = await pageHandle.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    return res
      .status(200)
      .setHeader('Content-Type', 'image/png')
      .send(pngBuffer);
  } catch (error) {
    console.error('PDF to PNG error:', error);
    return res.status(500).json({ error: error?.message || 'Gagal convert PDF ke PNG.' });
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }

    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
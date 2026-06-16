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
import { createLogger, SERVICES } from '../src/logger.js';

const log = createLogger(SERVICES.VERCEL);

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
  log.requestIn(req.method, '/api/pdf-to-png');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let tmpDir;
  let browser;

  try {
    const { pdf_base64, page = 1, scale = 2 } = req.body || {};
    const normalizedPdfBase64 = normalizePdfBase64(pdf_base64);

    if (!normalizedPdfBase64 || !isValidBase64(normalizedPdfBase64)) {
      log.warn('Invalid base64 PDF received');
      return res.status(400).json({ error: 'pdf_base64 wajib diisi dan harus valid.' });
    }

    const pageNumber = Math.max(1, Math.min(Number(page) || 1, 10));
    const scaleFactor = Math.max(1, Math.min(Number(scale) || 2, 4));

    const pdfBuffer = Buffer.from(normalizedPdfBase64, 'base64');
    if (pdfBuffer.length === 0 || pdfBuffer.toString('ascii', 0, 4) !== '%PDF') {
      log.warn('Invalid PDF file detected', { sizeBytes: pdfBuffer.length });
      return res.status(400).json({ error: 'pdf_base64 bukan file PDF valid.' });
    }

    log.info('Processing PDF', { sizeKB: Math.round(pdfBuffer.length / 1024), page: pageNumber, scale: scaleFactor });

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
    log.debug('Chromium browser launched');

    const pageHandle = await browser.newPage();
    await pageHandle.setViewport({
      width: 1440,
      height: 900,
      deviceScaleFactor: scaleFactor
    });

    // Navigasi langsung ke file PDF (Chromium bisa render PDF natif)
    // JANGAN pakai <embed> atau <object> - PDF plugin tidak ada di headless mode
    const fileUrl = `file://${pdfPath}`;
    console.log(`Navigating to PDF: ${fileUrl}#page=${pageNumber}`);

    await pageHandle.goto(`${fileUrl}#page=${pageNumber}`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Tunggu render PDF
    await new Promise(resolve => setTimeout(resolve, 5000));

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

    log.info('Screenshot generated successfully', { sizeBytes: pngBuffer.length });

    return res
      .status(200)
      .setHeader('Content-Type', 'image/png')
      .send(pngBuffer);
  } catch (error) {
    log.error('PDF to PNG conversion failed', error);
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
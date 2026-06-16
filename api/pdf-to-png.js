/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk convert PDF ke PNG menggunakan Puppeteer.
 * 
 * ARSITEKTUR:
 * - Cloudflare Worker export spreadsheet ke PDF via Google Drive API
 * - Kirim PDF (base64) ke endpoint ini
 * - Vercel tulis PDF ke file sementara, render di Chrome native PDF viewer (file://)
 * - Screenshot PNG, kirim balik
 * 
 * KENAPA file:// bukan data: URIs:
 * - Chrome headless PDF viewer (chrome://pdf) TIDAK support data: URIs (ERR_ABORTED)
 * - file:// protocol didukung penuh oleh Chrome native PDF viewer
 * - @sparticuz/chromium menyediakan akses ke /tmp di Vercel
 * 
 * Request: POST JSON { pdf_base64: "<base64 encoded pdf>" }
 * Response: image/png
 */

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const config = {
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  let browser;
  let tempPdfPath = null;

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
      // Raw binary
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
    // STEP 2: Tulis PDF ke file sementara
    // Chrome native PDF viewer TIDAK support data: URIs di headless
    // Tapi support file:// protocol
    // ============================================================
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vasa-pdf-'));
    tempPdfPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(tempPdfPath, pdfBuffer);
    console.log(`PDF written to: ${tempPdfPath}`);

    // ============================================================
    // STEP 3: Launch browser dan render PDF
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
        '--disable-software-rasterizer',
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

    // Gunakan file:// protocol (bukan data: URI) karena Chrome PDF viewer
    // tidak mendukung data: URIs dalam mode headless
    const pdfUrl = `file://${tempPdfPath}`;
    console.log(`Loading PDF via: ${pdfUrl}`);

    await page.goto(pdfUrl, { 
      waitUntil: 'networkidle0', 
      timeout: 60000 
    });

    // Tunggu Chrome PDF viewer selesai render halaman
    // Chrome PDF viewer butuh waktu untuk merender tiap halaman
    await new Promise(resolve => setTimeout(resolve, 4000));

    console.log('PDF rendered in Chrome native viewer');

    // ============================================================
    // STEP 4: Screenshot halaman PDF
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
    // Bersihkan file sementara
    if (tempPdfPath) {
      try {
        fs.unlinkSync(tempPdfPath);
        fs.rmdirSync(path.dirname(tempPdfPath));
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}
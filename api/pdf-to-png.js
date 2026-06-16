/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel endpoint untuk mengubah PDF hasil export Google Sheets menjadi PNG.
 * 
 * ARSITEKTUR:
 * - Vercel hanya sebagai HELPER untuk PDF -> PNG conversion
 * - Cloudflare Workers tetap menjadi Event Callback utama untuk SeaTalk
 * - Tidak menggunakan API screenshot freemium
 * - Menggunakan pdfjs-dist untuk parse PDF, Puppeteer untuk screenshot HTML
 * 
 * Request: POST JSON { pdf_base64, page, scale }
 * Response: image/png
 */

import * as pdfjsLib from 'pdfjs-dist';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const config = {
  runtime: 'nodejs'
};

// Disable web worker - Node.js serverless tidak support web worker
// pdfjs-dist bisa jalan tanpa worker (single-threaded)
delete pdfjsLib.GlobalWorkerOptions.workerSrc;

function normalizePdfBase64(value) {
  if (typeof value !== 'string') return null;
  return value.replace(/^data:application\/pdf;base64,/i, '')
    .replace(/^data:application\/x-pdf;base64,/i, '')
    .replace(/\s+/g, '');
}

function isValidBase64(value) {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, '&#039;');
}

/**
 * Extract text content dari PDF menggunakan pdfjs-dist
 * Mengembalikan array of pages, setiap page berisi array of text items
 */
async function extractPdfText(pdfBuffer, targetPage) {
  const uint8Array = new Uint8Array(pdfBuffer);
  const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
  const pdfDoc = await loadingTask.promise;
  
  const totalPages = pdfDoc.numPages;
  const pageNumber = Math.max(1, Math.min(targetPage, totalPages));
  
  const page = await pdfDoc.getPage(pageNumber);
  const textContent = await page.getTextContent();
  
  // Group text items by Y position (baris)
  const items = textContent.items;
  const lines = {};
  
  for (const item of items) {
    const y = Math.round(item.transform[5]); // Y coordinate
    if (!lines[y]) lines[y] = [];
    lines[y].push({
      text: item.str,
      x: item.transform[4] // X coordinate
    });
  }
  
  // Sort by Y position (dari atas ke bawah, PDF Y axis inverted)
  const sortedY = Object.keys(lines).map(Number).sort((a, b) => b - a);
  
  const rows = [];
  for (const y of sortedY) {
    const lineItems = lines[y].sort((a, b) => a.x - b.x);
    const rowText = lineItems.map(i => i.text).join(' | ');
    if (rowText.trim()) {
      rows.push(rowText);
    }
  }
  
  return { totalPages, pageNumber, rows, viewport: page.getViewport({ scale: 1.0 }) };
}

/**
 * Convert extracted PDF text to styled HTML table
 */
function pdfTextToHtml(pdfData, scaleFactor) {
  const { rows, pageNumber, totalPages, viewport } = pdfData;
  
  // Parse rows menjadi table cells
  const tableRows = rows.map(row => {
    const cells = row.split(' | ').filter(Boolean);
    return cells;
  });
  
  if (tableRows.length === 0) {
    return `<html><body><p>Tidak ada data dalam PDF</p></body></html>`;
  }
  
  // Hitung jumlah kolom maksimal
  const maxCols = Math.max(...tableRows.map(r => r.length));
  
  let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { 
    font-family: 'Segoe UI', Arial, sans-serif; 
    background: #ffffff; 
    padding: 16px;
    width: ${Math.round(viewport.width * scaleFactor)}px;
  }
  .header {
    background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
    color: white;
    padding: 14px 20px;
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 0;
  }
  .sheet-title {
    font-size: 14px;
    opacity: 0.9;
    font-weight: 400;
    margin-top: 4px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    border: 1px solid #dadce0;
  }
  th, td {
    border: 1px solid #e8eaed;
    padding: 10px 14px;
    text-align: left;
    font-size: 13px;
    white-space: nowrap;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  th {
    background: #f8f9fa;
    font-weight: 600;
    color: #3c4043;
    border-bottom: 2px solid #dadce0;
  }
  td { color: #202124; }
  tr:nth-child(even) td { background: #f8f9fa; }
  tr:hover td { background: #e8f0fe; }
  .footer {
    margin-top: 12px;
    font-size: 11px;
    color: #9aa0a6;
    text-align: right;
  }
</style>
</head>
<body>
<div class="header">📊 PDF Export
  <div class="sheet-title">Page ${pageNumber} of ${totalPages}</div>
</div>
<table>
<thead><tr>`;
  
  // Header row (gunakan baris pertama sebagai header)
  if (tableRows.length > 0) {
    const headerCells = tableRows[0];
    for (let i = 0; i < maxCols; i++) {
      html += `<th>${escapeHtml(headerCells[i] || '')}</th>`;
    }
    html += '</tr></thead><tbody>';
    
    // Data rows
    for (let r = 1; r < tableRows.length; r++) {
      html += '<tr>';
      for (let c = 0; c < maxCols; c++) {
        html += `<td>${escapeHtml(tableRows[r][c] || '')}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody>';
  }
  
  html += `</table>
<div class="footer">Generated by VASA • ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</div>
</body></html>`;
  
  return html;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

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

    console.log(`Processing PDF: ${Math.round(pdfBuffer.length / 1024)}KB, page ${pageNumber}, scale ${scaleFactor}`);

    // STEP 1: Extract text dari PDF menggunakan pdfjs-dist (tanpa Chromium!)
    const pdfData = await extractPdfText(pdfBuffer, pageNumber);
    console.log(`Extracted ${pdfData.rows.length} rows from page ${pdfData.pageNumber}/${pdfData.totalPages}`);

    // STEP 2: Convert text ke HTML table
    const htmlContent = pdfTextToHtml(pdfData, scaleFactor);

    // STEP 3: Screenshot HTML menggunakan Puppeteer
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (await chromium.executablePath()),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
      defaultViewport: {
        width: Math.round(pdfData.viewport.width * scaleFactor),
        height: Math.round(pdfData.viewport.height * scaleFactor),
        deviceScaleFactor: scaleFactor
      }
    });

    const pageHandle = await browser.newPage();
    await pageHandle.setViewport({
      width: Math.round(pdfData.viewport.width * scaleFactor),
      height: Math.round(pdfData.viewport.height * scaleFactor),
      deviceScaleFactor: scaleFactor
    });

    // Render HTML sebagai data URL (tanpa file:// dependency)
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(htmlContent);
    await pageHandle.goto(dataUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const pngBuffer = await pageHandle.screenshot({
      type: 'png',
      fullPage: true,
      omitBackground: false
    });

    console.log(`Screenshot generated: ${pngBuffer.length} bytes`);

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
  }
}
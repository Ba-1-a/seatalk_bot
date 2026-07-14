/**
 * src/botSheet.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Engine pemrosesan Google Sheets dan screenshot
 * 
 * ALUR SCREENSHOT (YANG BENAR - TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (GRATIS, preserve formatting asli)
 * 2. Kirim PDF (base64) ke Vercel endpoint /api/pdf-to-png
 * 3. Vercel render PDF native di Chrome (bukan HTML buatan!) -> screenshot PNG
 * 4. Kirim PNG ke SeaTalk via base64 inline
 * 
 * PERBAIKAN KELEMAHAN:
 * - Custom range sekarang didukung via parameter r1,c1,r2,c2 di Google Drive export
 *   Format: "A1:D15" → r1=0,c1=0,r2=15,c2=3
 * - Fungsi exportSpreadsheetToPdf menerima parameter range opsional
 * - Fungsi parseA1Notation untuk konversi A1:D15 ke row/col index
 * 
 * KENAPA INI BENAR:
 * - "Jangan render lewat HTML, tapi benar-benar ambil screenshot"
 * - Google Drive API export PDF GRATIS dan preserve warna, border, merged cells, dll
 * - Chrome native PDF viewer merender PDF apa adanya (bukan HTML table rekonstruksi)
 * - Tidak perlu freemium service (Google Drive API gratis)
 * 
 * FITUR:
 * - Autentikasi Google Service Account (JWT)
 * - Export spreadsheet ke PDF via Google Drive API (GRATIS)
 * - SUPPORT CUSTOM RANGE: A1:D15 via parameter Google Drive export
 * - Convert PDF ke PNG via Vercel Puppeteer (render native Chrome)
 * - Kirim screenshot ke SeaTalk
 * - Baca data spreadsheet untuk AI (text mode)
 * - Handler command: /setsheet, /readsheet, /screenshot
 */

import { replyToUser, sendScreenshotToUser, arrayBufferToBase64 } from './utils.js';
import { importPKCS8, SignJWT } from 'jose';
import { createLogger, SERVICES } from './logger.js';
import { resolveRenderOptions } from './renderOptions.js';

const googleLog = createLogger(SERVICES.GOOGLE);
const vercelLog = createLogger(SERVICES.VERCEL);

// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

/**
 * Parse JSON response dengan error handling
 */
async function parseJsonResponse(response, context) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        googleLog.error(`Invalid JSON from ${context}`, { status: response.status, body: text.substring(0, 300) });
        return null;
    }
}

/**
 * Get Google OAuth token menggunakan Service Account JWT
 * Token di-cache di KV selama ~50 menit
 * Scope mencakup spreadsheet READ dan drive EXPORT (file read)
 */
async function getGoogleToken(env) {
    const cacheKey = "google_oauth_token";
    try {
        const cachedToken = await env.BOT_MEMORY.get(cacheKey);
        if (cachedToken) {
            googleLog.debug('Google OAuth token loaded from cache');
            return cachedToken;
        }
    } catch (err) {
        googleLog.debug('Cache read failed (non-critical), generating new token');
    }

    const now = Math.floor(Date.now() / 1000);
    
    // Validasi: Pastikan semua required credential tersedia
    const missingCredentials = [];
    if (!env.GOOGLE_PRIVATE_KEY) missingCredentials.push('GOOGLE_PRIVATE_KEY');
    if (!env.GOOGLE_CLIENT_EMAIL) missingCredentials.push('GOOGLE_CLIENT_EMAIL');
    
    if (missingCredentials.length > 0) {
        throw new Error(
            `Google credentials tidak lengkap: ${missingCredentials.join(', ')}. ` +
            `Jalankan: npx wrangler secret put ${missingCredentials[0]}`
        );
    }
    googleLog.info('Generating new Google OAuth token via JWT');
    
    // Handle berbagai format GOOGLE_PRIVATE_KEY:
    // 1. Dari wrangler secret: biasanya ada \\n literal (escaped newline)
    // 2. Dari environment variable: ada \n actual newline
    // 3. Dari JSON langsung: ada \n actual newline
    let pemKey = env.GOOGLE_PRIVATE_KEY;
    
    // Jika mengandung literal \\n, convert ke actual newline
    if (pemKey.includes('\\n')) {
        pemKey = pemKey.replace(/\\n/g, '\n');
    }
    
    // Pastikan ada header/footer PEM yang benar
    if (!pemKey.includes('-----BEGIN PRIVATE KEY-----')) {
        // Mungkin key-nya terpotong atau format salah
        throw new Error('GOOGLE_PRIVATE_KEY tidak valid: tidak ditemukan header "BEGIN PRIVATE KEY"');
    }
    
    let privateKey;
    try {
        privateKey = await importPKCS8(pemKey, 'RS256');
    } catch (keyErr) {
        googleLog.error('Failed to parse GOOGLE_PRIVATE_KEY', { error: keyErr.message });
        throw new Error(
            'Gagal memparse GOOGLE_PRIVATE_KEY. Pastikan formatnya benar.\n' +
            'Coba set ulang: cat google-key.pem | npx wrangler secret put GOOGLE_PRIVATE_KEY\n' +
            `Detail: ${keyErr.message}`
        );
    }

    let jwt;
    try {
        jwt = await new SignJWT({
            iss: env.GOOGLE_CLIENT_EMAIL,
            scope: "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600, iat: now,
        }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(privateKey);
    } catch (jwtErr) {
        googleLog.error('JWT signing failed', { error: jwtErr.message });
        throw new Error(`Gagal membuat JWT untuk Google OAuth: ${jwtErr.message}`);
    }

    let res;
    try {
        res = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
        });
    } catch (fetchErr) {
        googleLog.error('Google OAuth network error', { error: fetchErr.message });
        throw new Error(`Gagal terhubung ke Google OAuth server: ${fetchErr.message}`);
    }

    const data = await parseJsonResponse(res, "Google OAuth token");
    if (!data) {
        throw new Error(`Google OAuth merespon dengan status ${res.status} dan body tidak valid`);
    }
    if (!data.access_token) {
        const errorDesc = data.error_description || data.error || 'unknown error';
        googleLog.error('Google OAuth token failed', { 
            status: res.status,
            error: errorDesc,
            fullResponse: JSON.stringify(data).substring(0, 200)
        });
        throw new Error(
            `Google OAuth gagal: ${errorDesc}. ` +
            `Pastikan Service Account (${env.GOOGLE_CLIENT_EMAIL}) aktif dan private key valid.`
        );
    }
    await env.BOT_MEMORY.put(cacheKey, data.access_token, { expirationTtl: 3000 });
    googleLog.info('Google OAuth token obtained and cached');
    return data.access_token;
}

// ============================================================
// SPREADSHEET UTILITIES
// ============================================================

/**
 * Extract spreadsheet ID dari URL Google Sheets
 */
export function extractSpreadsheetId(url) {
    const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return matches ? matches[1] : null;
}

/**
 * Normalize range token
 */
function normalizeRangeToken(rangeStr) {
    if (!rangeStr) return null;
    return rangeStr.trim().replace(/^range\s*[=:]\s*/i, '').replace(/^r\s*[=:]\s*/i, '');
}

/**
 * Parse custom range dari user input
 * Support: A1:D15, A:D, 5-30, D15, range=A1:D15
 */
function parseCustomRange(rangeStr) {
    if (!rangeStr) return null;
    let upperRange = normalizeRangeToken(rangeStr).toUpperCase();

    // Pattern: A1:D15, A1:R28, A:D (column range)
    const explicitMatch = upperRange.match(/^([A-Z]{1,3})?(\d+)?:([A-Z]{1,3})?(\d+)?$/);
    if (explicitMatch) {
        const [, startCol, startRow, endCol, endRow] = explicitMatch;
        if (startCol && endCol && !startRow && !endRow) {
            return `${startCol}1:${endCol}50`;
        }
        if (startCol || endCol || startRow || endRow) {
            const start = (startCol || 'A') + (startRow || '1');
            const end = (endCol || 'Z') + (endRow || '50');
            return `${start}:${end}`;
        }
    }

    // Pattern: 5-30 (baris 5-30, kolom A-Z)
    const rowMatch = upperRange.match(/^(\d+)-(\d+)$/);
    if (rowMatch) {
        const [, startRow, endRow] = rowMatch;
        return `A${startRow}:Z${endRow}`;
    }

    // Pattern: D15 (kolom D dengan baris awal)
    const simpleMatch = upperRange.match(/^([A-Z]{1,3})(\d+)$/);
    if (simpleMatch) {
        const [, col, row] = simpleMatch;
        return `${col}${row}:${col}50`;
    }

    return null;
}

/**
 * Parse A1 notation range menjadi row/col indices untuk Google Drive export
 * 
 * Google Drive export mendukung parameter range via:
 *   r1 = start row index (0-based, inclusive)
 *   r2 = end row index (0-based, exclusive - setara nomor baris terakhir)
 *   c1 = start column index (0-based, inclusive)
 *   c2 = end column index (0-based, exclusive)
 * 
 * Contoh: "A1:D15" → { r1:0, c1:0, r2:15, c2:4 } karena D=3 -> +1 exclusive = 4
 *          "C5:F20"  → { r1:4, c1:2, r2:20, c2:6 }
 * 
 * @param {String} range - A1 notation range (e.g. "A1:D15", "C5:F20")
 * @returns {Object|null} { r1, c1, r2, c2 } atau null jika tidak valid
 */
function parseA1RangeToIndices(range) {
    if (!range) return null;
    
    // Hapus whitespace dan normalize
    const cleanRange = normalizeRangeToken(range).toUpperCase().replace(/\s/g, '');
    
    // Pattern: A1:D15, C5:F20, A:Z (tanpa baris)
    const match = cleanRange.match(/^([A-Z]{1,3})(\d*):([A-Z]{1,3})(\d*)$/);
    if (!match) return null;
    
    const [, startColStr, startRowStr, endColStr, endRowStr] = match;
    
    // Konversi kolom (A=0, B=1, ..., Z=25, AA=26, ...)
    const colToIndex = (colStr) => {
        let index = 0;
        for (let i = 0; i < colStr.length; i++) {
            index = index * 26 + (colStr.charCodeAt(i) - 64); // 'A' = 65
        }
        return index - 1; // 0-based
    };
    
    const c1 = colToIndex(startColStr);
    const c2 = colToIndex(endColStr) + 1; // Exclusive
    
    // Baris: 1-based di A1 notation, konversi ke 0-based
    // Jika tidak ada nomor baris, default ke baris pertama/terakhir
    const startRow = startRowStr ? parseInt(startRowStr, 10) : 1;
    const endRow = endRowStr ? parseInt(endRowStr, 10) : 1000; // reasonable max
    
    const r1 = startRow - 1; // 0-based, inclusive
    const r2 = endRow;       // 0-based, exclusive (Google Drive API: r2 = last row index + 1)
    
    googleLog.info('Parsed A1 range', { range, r1, c1, r2, c2, startColStr, endColStr, startRow, endRow });
    
    return { r1, c1, r2, c2 };
}

/**
 * Baca data spreadsheet secara diam-diam untuk konteks AI
 * (Text mode - BUKAN untuk screenshot)
 */
export async function silentReadSheetForAI(env, spreadsheetId, tabName = "") {
    if (!spreadsheetId) return null;
    const token = await getGoogleToken(env);
    
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
    googleLog.debug(`Spreadsheet metadata loaded: ${sheets.length} sheets`, { spreadsheetId });
    if (sheets.length === 0) return null;

    let targetSheetTitle = sheets[0].properties.title;
    if (tabName) {
        const foundSheet = sheets.find(s => s.properties.title.toLowerCase().includes(tabName.toLowerCase()));
        if (foundSheet) targetSheetTitle = foundSheet.properties.title;
    }

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(targetSheetTitle)}!A1:Z50`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const data = await parseJsonResponse(res, `Sheets values for ${spreadsheetId} / ${targetSheetTitle}`);
    return (data.values || []).map(row => row.join(" | ")).join("\n");
}

// ============================================================
// PDF EXPORT (Google Drive API - GRATIS!)
// ============================================================

/**
 * Export spreadsheet ke PDF via Google Drive API
 * ALUR: Spreadsheet ID -> Google Drive API export -> PDF buffer
 * 
 * PERBAIKAN: Sekarang mendukung custom range via parameter Google Drive export!
 * Parameter yang digunakan:
 *   r1, c1 = start row/col index (0-based, inclusive)
 *   r2, c2 = end row/col index (0-based, exclusive)
 * 
 * Tanpa range: export seluruh sheet
 * Dengan range: export hanya area yang ditentukan
 * 
 * Google Drive API export GRATIS dan mempertahankan formatting asli
 * (warna, border, merged cells, font, dll) karena export dilakukan
 * oleh server Google langsung.
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} sheetGid - Grid ID sheet target (optional, untuk export sheet tertentu)
 * @param {Object|null} rangeIndices - { r1, c1, r2, c2 } untuk custom range (optional)
 * @returns {ArrayBuffer} PDF buffer
 */
async function exportSpreadsheetToPdf(env, spreadsheetId, sheetGid = null, rangeIndices = null) {
    const token = await getGoogleToken(env);
    
    // Build export URL dengan parameter
    // https://docs.google.com/spreadsheets/d/{spreadsheetId}/export?format=pdf
    let exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf`;
    exportUrl += `&gridlines=false`;         // Sembunyikan gridlines untuk tampilan bersih
    exportUrl += `&printtitle=false`;        // Sembunyikan judul spreadsheet
    exportUrl += `&fzr=false`;               // Frozen rows tidak diulang
    exportUrl += `&pagenum=false`;            // No page numbers
    
    // ================================================================
    // ADAPTIVE PAPER SIZE (V6 - RASIO KONTEN + JS CROP)
    // ================================================================
    // Strategi: Pilih paper size berdasarkan rasio konten aktual
    // (jumlah baris vs kolom dari range), bukan hanya jumlah kolom.
    // 
    // Tujuan: Paper size semirip mungkin dengan rasio konten agar
    // whitespace dari Google PDF engine minimal. Sisa whitespace
    // akan di-crop oleh JS browser-side edge scan di Vercel.
    // 
    // Rasio konten = jumlah_baris / jumlah_kolom
    //   - Rasio > 1.2 (lebih tinggi) → portrait
    //   - Rasio < 0.8 (lebih lebar)  → landscape
    //   - Di antaranya → square-ish
    // 
    // Paper size berdasarkan ukuran konten:
    //   - 1-2 kolom + sedikit baris → STATEMENT (5.5"x8.5")
    //   - 1-2 kolom + banyak baris  → LETTER (8.5"x11")
    //   - 3-4 kolom + sedikit baris → EXECUTIVE (7.25"x10.5")
    //   - 3-4 kolom + banyak baris  → LETTER
    //   - 5+ kolom                  → TABLOID (17"x11")
    // ================================================================
    if (rangeIndices) {
      const columnCount = rangeIndices.c2 - rangeIndices.c1;
      const rowCount = rangeIndices.r2 - rangeIndices.r1;
      const aspectRatio = rowCount / Math.max(1, columnCount); // baris per kolom
      
      let paperSize, isPortrait, useFith;
      
      if (columnCount <= 2) {
        if (rowCount <= 10) {
          // 1-2 kolom, sedikit baris → STATEMENT (paling kecil)
          paperSize = 'STATEMENT';
          isPortrait = true;
          useFith = true;
        } else {
          // 1-2 kolom, banyak baris → LETTER
          paperSize = 'LETTER';
          isPortrait = true;
          useFith = true;
        }
      } else if (columnCount <= 4) {
        if (rowCount <= 15) {
          // 3-4 kolom, sedikit baris → EXECUTIVE
          paperSize = 'EXECUTIVE';
          isPortrait = true;
          useFith = true;
        } else {
          // 3-4 kolom, banyak baris → LETTER
          paperSize = 'LETTER';
          isPortrait = true;
          useFith = true;
        }
      } else {
        // 5+ kolom → TABLOID landscape
        paperSize = 'TABLOID';
        isPortrait = false;
        useFith = false;
      }
      
      exportUrl += `&portrait=${isPortrait ? 'true' : 'false'}`;
      exportUrl += `&size=${paperSize}`;
      exportUrl += `&fitw=true`;
      if (useFith) {
        exportUrl += `&fith=true`;
      }
      exportUrl += `&top_margin=0`;
      exportUrl += `&bottom_margin=0`;
      exportUrl += `&left_margin=0`;
      exportUrl += `&right_margin=0`;
      
      googleLog.info('Range export: Adaptive paper V6', { rangeIndices, columnCount, rowCount, aspectRatio, paperSize, isPortrait, useFith });
    } else {
      // Full sheet export (tanpa range)
      exportUrl += `&portrait=true`;
      exportUrl += `&size=A4`;
      exportUrl += `&fitw=true`;
      exportUrl += `&top_margin=0`;
      exportUrl += `&bottom_margin=0`;
      exportUrl += `&left_margin=0`;
      exportUrl += `&right_margin=0`;
    }
    
    // Jika sheet GID diberikan, export sheet tertentu
    if (sheetGid !== null) {
        exportUrl += `&gid=${sheetGid}`;
    }
    
    // ================================================================
    // PERBAIKAN: Custom range support via parameter r1,c1,r2,c2
    // ================================================================
    // Google Drive API export mendukung parameter range:
    //   r1 = start row index (0-based, inclusive)
    //   r2 = end row index (0-based, exclusive)
    //   c1 = start column index (0-based, inclusive)  
    //   c2 = end column index (0-based, exclusive)
    //
    // Contoh: range "A1:D15" → r1=0, c1=0, r2=15, c2=4
    //          range "C5:F20" → r1=4, c1=2, r2=20, c2=6
    //
    // Tanpa parameter ini: export FULL SHEET (seluruh halaman)
    // Dengan parameter: export HANYA area yang ditentukan
    // ================================================================
    if (rangeIndices) {
        exportUrl += `&r1=${rangeIndices.r1}`;
        exportUrl += `&c1=${rangeIndices.c1}`;
        exportUrl += `&r2=${rangeIndices.r2}`;
        exportUrl += `&c2=${rangeIndices.c2}`;
        googleLog.info('Custom range applied to PDF export', rangeIndices);
    } else {
        googleLog.info('No custom range - exporting entire sheet');
    }
    
    googleLog.info('Exporting spreadsheet to PDF', { spreadsheetId, exportUrl: exportUrl.substring(0, 150) });
    
    const response = await fetch(exportUrl, {
        method: "GET",
        headers: {
            "Authorization": `Bearer ${token}`
        }
    });
    
    if (!response.ok) {
        const errorText = await response.text();
        googleLog.error('Google Drive PDF export failed', { 
            status: response.status, 
            body: errorText.substring(0, 300) 
        });
        throw new Error(`Export PDF gagal: HTTP ${response.status}. Pastikan Service Account memiliki akses ke spreadsheet ini.`);
    }
    
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("pdf") && !contentType.includes("application/octet-stream")) {
        const text = await response.text();
        googleLog.error('Google Drive returned non-PDF content type', { contentType, body: text.substring(0, 300) });
        throw new Error(`Google mengembalikan format non-PDF: ${contentType}`);
    }
    
    const pdfBuffer = await response.arrayBuffer();
    
    googleLog.info('PDF exported successfully', { 
        spreadsheetId, 
        sizeBytes: pdfBuffer.byteLength,
        hasRange: !!rangeIndices,
        range: rangeIndices
    });
    
    if (pdfBuffer.byteLength < 200) {
        throw new Error("PDF hasil export terlalu kecil (mungkin spreadsheet kosong).");
    }
    
    return pdfBuffer;
}

/**
 * Dapatkan daftar sheets dari spreadsheet
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @returns {Array} Array of { title, gid, rowCount, columnCount }
 */
async function getSheetsList(env, spreadsheetId) {
    const token = await getGoogleToken(env);
    
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
    
    return sheets.map(s => ({
        title: s.properties.title,
        gid: s.properties.sheetId,
        rowCount: s.properties.gridProperties?.rowCount || 0,
        columnCount: s.properties.gridProperties?.columnCount || 0
    }));
}

// ============================================================
// SCREENSHOT via Vercel (Kirim PDF, BUKAN JSON!)
// ============================================================

/**
 * Kirim PDF ke Vercel API Gateway untuk di-convert ke PNG
 * Vercel API Gateway meneruskan request ke HF Spaces
 * 
 * @param {ArrayBuffer} pdfBuffer - PDF buffer dari Google Drive export
 * @param {Object} env - Environment variables
 * @returns {ArrayBuffer} PNG buffer
 */
async function convertPdfToPng(pdfBuffer, env) {
    const vercelUrl = env.VERCEL_PDF_TO_PNG_URL || "https://seatalkbot.vercel.app/api/pdf-to-png";
    const pdfBase64 = arrayBufferToBase64(pdfBuffer);
    const maxRetries = 2;
    const renderOptions = resolveRenderOptions(pdfBuffer.byteLength);
    let attempt = 0;
    let lastError;

    // Pre-flight size check
    const pdfSizeMB = pdfBuffer.byteLength / 1024 / 1024;
    if (pdfSizeMB > 3.5) {
        vercelLog.warn('PDF too large for reliable conversion', { pdfSizeMB });
        throw new Error(`Sheet terlalu besar (${pdfSizeMB.toFixed(1)}MB). Coba gunakan range yang lebih kecil (misal: /screenshot range=A1:D50)`);
    }
    
    if (pdfSizeMB > 2.5) {
        vercelLog.warn('Large PDF detected, may take longer', { pdfSizeMB });
    }

    vercelLog.info('Sending PDF to Vercel for conversion', {
        url: vercelUrl,
        pdfSizeBytes: pdfBuffer.byteLength,
        pdfSizeMB: pdfSizeMB.toFixed(2),
        renderMode: renderOptions.mode
    });

    while (attempt < maxRetries) {
        attempt += 1;
        const response = await fetch(vercelUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                pdf_base64: pdfBase64,
                render_options: {
                    mode: renderOptions.mode,
                    scale: renderOptions.scale,
                    max_pages: renderOptions.maxPages,
                    render_delay_ms: renderOptions.renderDelayMs,
                    timeout_ms: renderOptions.timeoutMs,
                    device_scale_factor: renderOptions.deviceScaleFactor
                }
            })
        });

        // Inspect headers first — do not consume body unless needed
        const contentType = (response.headers.get("content-type") || "").toLowerCase();

        if (response.ok) {
            // Expect binary image/png (or other image/*). Read as arrayBuffer only.
            if (!contentType.includes("image/png") && !contentType.includes("image")) {
                // Read body text for debugging (only in this error branch)
                const errText = await response.text().catch(() => "");
                const snippet = (errText || "").substring(0, 1000);
                vercelLog.error('Vercel returned wrong content type', {
                    attempt,
                    contentType,
                    body: snippet
                });
                throw new Error(`Vercel mengembalikan format salah: ${contentType}`);
            }

            // Valid image response — read binary
            const pngBuffer = await response.arrayBuffer();
            vercelLog.info('PNG received from Vercel', {
                attempt,
                sizeBytes: pngBuffer.byteLength
            });

            if (pngBuffer.byteLength < 100) {
                throw new Error("PNG hasil convert terlalu kecil/rusak.");
            }

            return pngBuffer;
        }

    // Non-OK responses: read body as text for parsing error details
        const responseText = await response.text().catch(() => "");
        const responseBody = responseText.substring(0, 1000);
        lastError = parseVercelError(response.status, responseBody);
        
        // Add actionable hint based on error
        let userHint = lastError;
        if (response.status === 504) {
            // 504 = timeout. Cause is almost always HF Spaces overload (concurrent requests),
            // NOT pdf size. Same PDF works in private chat, so don't blame size.
            userHint = `⏱️ Layanan render sedang sibuk (antrian penuh). Coba lagi dalam 30-60 detik. Jika masih gagal, gunakan range yang lebih kecil (misal: /screenshot range=A1:D50).`;
        } else if (response.status === 502) {
            userHint = `Layanan HF Spaces gangguan. Coba lagi dalam 1-2 menit atau gunakan range yang lebih kecil.`;
        }
        
        vercelLog.error('Vercel PDF-to-PNG conversion failed', {
            attempt,
            status: response.status,
            body: responseBody,
            pdfSizeMB,
            userHint
        });

        // 504 = timeout from overloaded HF Spaces. Retrying ADDS more load and makes
        // the queue worse. Fail fast instead of retrying.
        if (response.status === 504) {
            throw new Error(userHint);
        }

        if (response.status >= 500 && attempt < maxRetries) {
            vercelLog.warn('Retrying Vercel PDF-to-PNG after server error', {
                attempt,
                status: response.status
            });
            // Exponential backoff: 250ms, 500ms
            const backoffMs = 250 * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            continue;
        }

        throw new Error(userHint);
    }

    throw new Error(lastError || 'Vercel PDF-to-PNG gagal');
}

function parseVercelError(status, body) {
    try {
        const json = JSON.parse(body);
        if (json.error) return `Vercel PDF-to-PNG gagal: HTTP ${status} - ${json.error}`;
        if (json.message) return `Vercel PDF-to-PNG gagal: HTTP ${status} - ${json.message}`;
    } catch (parseErr) {
        // ignore parse error, use raw body
    }
    const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `Vercel PDF-to-PNG gagal: HTTP ${status} - ${snippet}`;
}

// ============================================================
// RATE LIMITING UNTUK SCREENSHOT
// ============================================================

/**
 * Cek rate limit screenshot per user/group dengan chatType awareness
 * Mencegah spam: maksimal 1 screenshot concurrent per user
 * @param {Object} env - Environment variables
 * @param {String} targetId - ID target (employee_code atau group_id)
 * @param {Boolean} isGroup - Apakah ini group chat
 * @param {String} reqId - Request ID untuk logging
 * @returns {Object} { allowed: boolean, message?: string }
 */
async function checkScreenshotRateLimit(env, targetId, isGroup, reqId) {
  // Separate rate limit keys untuk group vs private chat
  // Group chats are more likely to have concurrent requests dari multiple users
  const keyPrefix = isGroup ? 'group' : 'user';
  const processingKey = `screenshot_processing_${keyPrefix}_${targetId}`;
  
  try {
    // Cek apakah ada screenshot yang sedang diproses
    const processing = await env.BOT_MEMORY.get(processingKey);
    if (processing) {
      const chatType = isGroup ? 'group chat ini' : 'anda';
      googleLog.warn('Screenshot rate limit: ongoing screenshot', { 
        targetId, 
        isGroup,
        chatType,
        reqId 
      });
      return {
        allowed: false,
        message: isGroup
          ? "⏳ Sedang memproses screenshot sebelumnya di group chat ini. Mohon tunggu hingga selesai."
          : "⏳ Sedang memproses screenshot sebelumnya. Mohon tunggu hingga selesai sebelum request baru."
      };
    }
    
    // Set flag sedang memproses (TTL 120 detik - cukup untuk proses screenshot)
    await env.BOT_MEMORY.put(processingKey, '1', { expirationTtl: 120 });
    
    googleLog.info('Rate limit check passed', { targetId, isGroup, keyPrefix, reqId });
    return { allowed: true };
  } catch (err) {
    googleLog.error('Rate limit check failed', { error: err.message, targetId, isGroup, reqId });
    // Jika error, tetap allow (fail-open untuk availability)
    return { allowed: true };
  }
}

/**
 * Hapus flag rate limit setelah screenshot selesai
 * @param {Object} env - Environment variables
 * @param {String} targetId - ID target
 * @param {Boolean} isGroup - Apakah ini group chat
 * @param {String} reqId - Request ID untuk logging
 */
async function clearScreenshotRateLimit(env, targetId, isGroup, reqId) {
  const keyPrefix = isGroup ? 'group' : 'user';
  const processingKey = `screenshot_processing_${keyPrefix}_${targetId}`;
  try {
    await env.BOT_MEMORY.delete(processingKey);
    googleLog.debug('Rate limit cleared', { targetId, isGroup, keyPrefix, reqId });
  } catch (err) {
    googleLog.debug('Failed to clear rate limit', { error: err.message, targetId, isGroup, reqId });
  }
}

/**
 * PER-SHEET CONCURRENCY LOCK
 * HF Spaces free tier = single instance. Jika banyak user di group chat request
 * screenshot bersamaan, request akan antri dan timeout (504).
 * Lock ini mencegah 2 request untuk SHEET YANG SAMA dieksekusi bersamaan.
 * Request ke-2 akan menunggu (queue) hingga request ke-1 selesai, bukan langsung timeout.
 *
 * @param {Object} env - Environment variables
 * @param {String} sheetId - Spreadsheet ID (lock key)
 * @param {Number} maxWaitMs - Max waktu tunggu sebelum give up
 * @returns {Boolean} true jika lock didapat, false jika timeout waiting
 */
async function acquireSheetLock(env, sheetId, maxWaitMs = 45000) {
  const lockKey = `sheet_lock_${sheetId}`;
  const start = Date.now();
  const waitStep = 1500;

  while (Date.now() - start < maxWaitMs) {
    const existing = await env.BOT_MEMORY.get(lockKey);
    if (!existing) {
      // Lock bebas, ambil lock dengan TTL 60s (cukup untuk 1 render)
      await env.BOT_MEMORY.put(lockKey, Date.now().toString(), { expirationTtl: 60 });
      googleLog.info('Sheet lock acquired', { sheetId });
      return true;
    }
    googleLog.warn('Sheet lock busy, waiting...', {
      sheetId,
      waitedMs: Date.now() - start,
      lockedAt: existing
    });
    await new Promise(resolve => setTimeout(resolve, waitStep));
  }

  googleLog.error('Sheet lock timeout - giving up', { sheetId, maxWaitMs });
  return false;
}

/**
 * Lepas per-sheet lock setelah render selesai (sukses/gagal)
 */
async function releaseSheetLock(env, sheetId) {
  const lockKey = `sheet_lock_${sheetId}`;
  try {
    await env.BOT_MEMORY.delete(lockKey);
    googleLog.debug('Sheet lock released', { sheetId });
  } catch (err) {
    googleLog.debug('Failed to release sheet lock', { error: err.message, sheetId });
  }
}

// ============================================================
// MAIN SCREENSHOT FUNCTION
// ============================================================

/**
 * Generate PNG dari spreadsheet
 * ALUR YANG BENAR (TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (GRATIS)
 * 2. Kirim PDF ke Vercel untuk di-render native Chrome -> screenshot PNG
 * 3. Kirim PNG ke SeaTalk
 * 
 * PERBAIKAN:
 * - Custom range sekarang diproses dan dikirim ke Google Drive API
 * - parseA1RangeToIndices mengkonversi "A1:D15" ke parameter r1,c1,r2,c2
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @param {String} customRange - Custom range A1 notation (e.g. "A1:D15", optional)
 * @returns {ArrayBuffer} PNG image buffer
 */
export async function generateSheetPng(env, spreadsheetId, tabName = "", customRange = null) {
    googleLog.info('generateSheetPng: Starting', { spreadsheetId, tabName, customRange });
    
    // STEP 1: Parse custom range ke indices untuk Google Drive export
    let rangeIndices = null;
    if (customRange) {
        rangeIndices = parseA1RangeToIndices(customRange);
        if (rangeIndices) {
            googleLog.info('Custom range parsed', { customRange, rangeIndices });
        } else {
            googleLog.warn('Custom range could not be parsed, exporting full sheet', { customRange });
        }
    }
    
    // STEP 2: Dapatkan daftar sheets dan cari GID target jika tabName diberikan
    let sheetGid = null;
    const sheetsList = await getSheetsList(env, spreadsheetId);
    
    if (tabName && sheetsList.length > 0) {
        const foundSheet = sheetsList.find(s => 
            s.title.toLowerCase().includes(tabName.toLowerCase())
        );
        if (foundSheet) {
            sheetGid = foundSheet.gid;
            googleLog.info('Target sheet found', { title: foundSheet.title, gid: foundSheet.gid });
        }
    }
    
    // STEP 3: Export spreadsheet ke PDF via Google Drive API (GRATIS!)
    // Dengan custom range jika ada
    const pdfBuffer = await exportSpreadsheetToPdf(env, spreadsheetId, sheetGid, rangeIndices);
    googleLog.info('PDF exported', { sizeBytes: pdfBuffer.byteLength, hasRange: !!rangeIndices });
    
    // STEP 4: Kirim PDF ke Vercel untuk di-convert ke PNG
    // Vercel akan render PDF native di Chrome, bukan HTML buatan!
    const pngBuffer = await convertPdfToPng(pdfBuffer, env);
    vercelLog.info('PNG from Vercel', { sizeBytes: pngBuffer.byteLength });
    
    return pngBuffer;
}

// ============================================================
// COMMAND HANDLERS
// ============================================================

/**
 * Handler untuk command /setsheet
 * Menyimpan spreadsheet ID sebagai default untuk user
 */
export async function handleSetSheet(env, targetId, text, isGroup, threadId, originalMessageId) {
    const sheetId = extractSpreadsheetId(text);
    if (!sheetId) {
        return await replyToUser(env, "⚠️ URL tidak valid. Gunakan: /setsheet <url_google_sheets>", targetId, isGroup, threadId, originalMessageId);
    }
    await env.BOT_MEMORY.put(`default_sheet_${targetId}`, sheetId);
    await replyToUser(env, "✅ Spreadsheet disimpan sebagai default.", targetId, isGroup, threadId, originalMessageId);
}

/**
 * Handler untuk command /readsheet
 * Membaca dan menampilkan data spreadsheet (text mode)
 */
export async function handleReadSheet(env, targetId, text, isGroup, threadId, originalMessageId) {
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const sheetId = explicitSheetId || await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    const tabName = explicitSheetId ? (tokens.length > 1 ? tokens.slice(1).join(" ") : "") : tokens.join(" ");

    if (!sheetId) {
        return await replyToUser(env, "⚠️ Belum ada sheet terdaftar. Gunakan /setsheet <url> terlebih dahulu.", targetId, isGroup, threadId, originalMessageId);
    }
    
    try {
        const result = await silentReadSheetForAI(env, sheetId, tabName);
        await replyToUser(env, result || "Data kosong.", targetId, isGroup, threadId, originalMessageId);
    } catch (err) {
        await replyToUser(env, `❌ Error: ${err.message}`, targetId, isGroup, threadId, originalMessageId);
    }
}

/**
 * Parse argument untuk screenshot command
 */
function parseScreenshotArguments(tokens) {
    let tabNameParts = [];
    let customRange = null;
    let collectingSheetName = false;

    for (let token of tokens) {
        if (!token) continue;
        const lowerToken = token.toLowerCase();
        if (/^(https?:\/\/|www\.|docs\.google\.com\/spreadsheets)/i.test(token)) {
            continue;
        }
        if (/^url=/i.test(token)) {
            continue;
        }

        if (/^(range|r)=/i.test(token)) {
            const parsed = parseCustomRange(token);
            if (parsed) {
                customRange = parsed;
            }
            collectingSheetName = false;
            continue;
        }

        const sheetNameMatch = token.match(/^(sheet_name|sheet|tab_name)=(.+)$/i);
        if (sheetNameMatch) {
            collectingSheetName = true;
            tabNameParts.push(sheetNameMatch[2]);
            continue;
        }

        const rangeParsed = parseCustomRange(token);
        if (rangeParsed && !customRange) {
            customRange = rangeParsed;
            collectingSheetName = false;
            continue;
        }

        if (collectingSheetName) {
            tabNameParts.push(token);
            continue;
        }

        tabNameParts.push(token);
    }

    return { tabName: tabNameParts.join(" ").trim(), customRange };
}

/**
 * Handler untuk command /screenshot
 * ALUR YANG BENAR (TANPA HTML, TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (GRATIS!)
 * 2. Custom range (A1:D15) diteruskan ke Google Drive API via r1,c1,r2,c2
 * 3. Kirim PDF ke Vercel untuk di-render native Chrome -> screenshot PNG
 * 4. Kirim PNG ke SeaTalk
 * 
 * PERBAIKAN:
 * - "Pesan processing" sudah dikirim oleh index.js via ctx.waitUntil
 * - Custom range diproses dan diteruskan ke Google Drive API export
 */
export async function handleScreenshotCommand(env, targetId, text, isGroup, threadId, originalMessageId) {
    const startTime = Date.now();
    const reqId = crypto.randomUUID().slice(0, 8);
    const log = googleLog.child({ reqId, targetId, isGroup });
    
    log.enter('handleScreenshotCommand', { text: text.substring(0, 50) });
    
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    
    // Cek rate limit SEBELUM kirim processing message (chat-type aware)
    log.decision('Checking rate limit');
    const rateLimitResult = await checkScreenshotRateLimit(env, targetId, isGroup, reqId);
    if (!rateLimitResult.allowed) {
        log.warn('Rate limit exceeded', { targetId, isGroup });
        return await replyToUser(env, rateLimitResult.message, targetId, isGroup, threadId, originalMessageId);
    }
    
    // Kirim pesan "processing" dan tangkap message_id untuk thread chain
    let currentThreadId = threadId;
    if (isGroup) {
        const processingResp = await replyToUser(env, "⏳ Sedang memproses screenshot...", targetId, isGroup, threadId, originalMessageId);
        // Gunakan message_id dari response sebagai thread_id untuk reply selanjutnya
        if (processingResp?.messageId) {
            currentThreadId = processingResp.messageId;
            googleLog.info('Screenshot: Created thread for processing', { threadId: currentThreadId });
        }
    } else {
        // Single chat: kirim processing message tanpa menunggu thread
        await replyToUser(env, "⏳ Sedang memproses screenshot...", targetId, isGroup, threadId, originalMessageId).catch(() => {});
    }
    
    // Cari sheet ID dari URL, lalu dari memory berdasarkan target group/user
    log.decision('Looking for sheet ID');
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const storedSheetId = await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    const sheetId = explicitSheetId || storedSheetId;
    const sheetSource = explicitSheetId ? 'explicit' : storedSheetId ? 'memory' : 'missing';
    
    log.info('Resolved sheetId for screenshot', {
        targetId,
        isGroup,
        sheetId,
        sheetSource,
        explicitSheetId: !!explicitSheetId,
        hasStoredSheet: !!storedSheetId
    });

    if (!sheetId) {
        log.warn('Sheet not found');
        await clearScreenshotRateLimit(env, targetId, isGroup, reqId);
        return await replyToUser(env, "⚠️ Sheet tidak ditemukan. Gunakan /setsheet <url> terlebih dahulu.", targetId, isGroup, currentThreadId, originalMessageId);
    }

    // ================================================================
    // PER-SHEET CONCURRENCY LOCK
    // HF Spaces free tier = single instance. Di group chat, multiple user
    // bisa request sheet yg SAMA bersamaan -> request antri & timeout (504).
    // Lock ini membuat request ke-2 menunggu (queue) hingga ke-1 selesai.
    // ================================================================
    log.decision('Acquiring per-sheet lock', { sheetId });
    const lockAcquired = await acquireSheetLock(env, sheetId, 45000);
    if (!lockAcquired) {
        log.warn('Sheet lock timeout - too many concurrent requests', { sheetId });
        await clearScreenshotRateLimit(env, targetId, isGroup, reqId);
        return await replyToUser(env,
            "⏳ Layanan render sedang sangat sibuk. Mohon tunggu 1-2 menit lalu coba lagi.",
            targetId, isGroup, threadId, originalMessageId);
    }

    const targetLabel = isGroup ? 'grup' : 'chat';
    const processingMessage = isGroup
        ? `⏳ Memproses screenshot untuk ${targetLabel} ini. Proses bisa memakan waktu beberapa detik.`
        : '⏳ Sedang memproses screenshot...';
    if (isGroup) {
        await replyToUser(env, processingMessage, targetId, isGroup, threadId, originalMessageId).catch(() => {});
    }
    
    const tokensForTabAndRange = explicitSheetId
        ? tokens.filter(token => !extractSpreadsheetId(token) && !/^url=/i.test(token))
        : tokens;
    const { tabName, customRange } = parseScreenshotArguments(tokensForTabAndRange);
    
    log.info('Screenshot command received', { sheetId, tabName, customRange });
    
    try {
        log.enter('STEP 1: Get sheets list');
        // STEP 1: Dapatkan daftar sheets dan cari GID target
        let sheetGid = null;
        const sheetsList = await getSheetsList(env, sheetId);
        
        if (tabName && sheetsList.length > 0) {
            const foundSheet = sheetsList.find(s => 
                s.title.toLowerCase().includes(tabName.toLowerCase())
            );
            if (foundSheet) {
                sheetGid = foundSheet.gid;
                log.info('Target sheet found', { title: foundSheet.title, gid: foundSheet.gid });
            }
        }
        
     // ================================================================
     // PERBAIKAN: Parse custom range untuk Google Drive export
     // ================================================================
     // User input: "A1:D15" → parseCustomRange → "A1:D15"
     // → parseA1RangeToIndices → { r1:0, c1:0, r2:15, c2:4 }
     // → exportSpreadsheetToPdf dengan rangeIndices
     // ================================================================
     let rangeIndices = null;
     if (customRange) {
         rangeIndices = parseA1RangeToIndices(customRange);
         if (rangeIndices) {
             googleLog.info('Screenshot: Custom range will be applied', { customRange, rangeIndices });
         } else {
             googleLog.warn('Screenshot: Custom range parsing failed, exporting full sheet', { customRange });
         }
     } else {
         googleLog.info('Screenshot: No custom range provided, exporting full sheet');
     }
     
     log.enter('STEP 2: Export to PDF');
     // STEP 2: Export spreadsheet ke PDF via Google Drive API (GRATIS!)
     // Dengan custom range jika ada
     log.decision('Exporting to PDF via Google Drive API', { rangeIndices, hasCustomRange: !!customRange });
        const pdfStartTime = Date.now();
        const pdfBuffer = await exportSpreadsheetToPdf(env, sheetId, sheetGid, rangeIndices);
        log.timing('PDF export', Date.now() - pdfStartTime, { sizeBytes: pdfBuffer.byteLength });
        
        log.enter('STEP 3: Convert PDF to PNG');
        // STEP 3: Kirim PDF ke Vercel untuk di-convert ke PNG
        // Vercel render PDF native di Chrome (BUKAN HTML buatan!)
        log.decision('Sending PDF to Vercel', { pdfSize: pdfBuffer.byteLength });
        const vercelStartTime = Date.now();
        const pngBuffer = await convertPdfToPng(pdfBuffer, env);
        log.timing('Vercel PDF-to-PNG', Date.now() - vercelStartTime, { pngSize: pngBuffer.byteLength });

        if (!pngBuffer || pngBuffer.byteLength === 0) {
            throw new Error('Vercel PDF-to-PNG gagal: hasil PNG kosong');
        }
        
        // STEP 4: Upload dan kirim PNG ke SeaTalk
        // Gunakan currentThreadId (bukan threadId asli) agar screenshot masuk di thread yang benar
        await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, currentThreadId, originalMessageId);
        
        // STEP 5: Konfirmasi sukses (jika gagah kirim di thread, fallback ke group chat umum)
        const confirmResp = await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, currentThreadId, originalMessageId);
        
        // Fallback: jika gagal kirim di thread (misal thread_id tidak valid), kirim ke group umum
        if (isGroup && confirmResp?.code !== 0 && currentThreadId !== threadId) {
            googleLog.warn('Screenshot: Failed to send in thread, falling back to group chat', { currentThreadId });
            await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, threadId, originalMessageId);
        }
        
    } catch (err) {
        log.error('Screenshot command failed', err);
        const friendlyMessage = err?.message?.includes('timeout') || err?.message?.includes('timed out')
            ? '⏱️ Screenshot memerlukan waktu lebih lama dari biasanya. Coba lagi dengan range yang lebih kecil atau sheet yang lebih ringan.'
            : `❌ Gagal membuat screenshot: ${err.message}`;
        await replyToUser(env, friendlyMessage, targetId, isGroup, threadId, originalMessageId);
    } finally {
        log.timing('Total screenshot', Date.now() - startTime);
        // Bersihkan rate limit flag setelah selesai (baik success maupun error)
        await clearScreenshotRateLimit(env, targetId, isGroup, reqId);
        // Lepas per-sheet lock agar request berikutnya bisa jalan
        await releaseSheetLock(env, sheetId);
    }
}

/**
 * Get data laporan per jam (placeholder)
 */
export async function getHourlyReportData(env) {
    return "Data Laporan (Sistem sedang disinkronisasi)";
}

/**
 * Handler untuk command /inventory
 * Placeholder untuk fitur inventory
 */
export async function handleInventoryQuery(env, targetId, text, isGroup, threadId, originalMessageId) {
    googleLog.info('Inventory query received (placeholder)');
    await replyToUser(env, "📦 Fitur inventory sedang dalam pengembangan.", targetId, isGroup, threadId, originalMessageId);
    return null;
}
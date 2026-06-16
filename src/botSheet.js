/**
 * src/botSheet.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Engine pemrosesan Google Sheets dan screenshot
 * 
 * ALUR SCREENSHOT (TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Kirim PDF ke Vercel endpoint /api/pdf-to-png untuk di-convert ke PNG (puppeteer)
 * 3. Kirim PNG ke SeaTalk via base64
 * 
 * FITUR:
 * - Autentikasi Google Service Account (JWT)
 * - Baca data spreadsheet untuk AI
 * - Export spreadsheet ke PDF via Google Drive API
 * - Convert PDF ke PNG via Vercel Puppeteer endpoint
 * - Kirim screenshot ke SeaTalk
 * - Handler command: /setsheet, /readsheet, /screenshot
 */

import { replyToUser, sendScreenshotToUser } from './utils.js';
import { importPKCS8, SignJWT } from 'jose';

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
        console.error(`DEBUG: Invalid JSON from ${context}. status=${response.status} body=${text.substring(0, 300)}`);
        return null;
    }
}

/**
 * Get Google OAuth token menggunakan Service Account JWT
 * Token di-cache di KV selama ~50 menit
 */
async function getGoogleToken(env) {
    const cacheKey = "google_oauth_token";
    try {
        const cachedToken = await env.BOT_MEMORY.get(cacheKey);
        if (cachedToken) return cachedToken;
    } catch (err) {}

    const now = Math.floor(Date.now() / 1000);
    let pemKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
    const privateKey = await importPKCS8(pemKey, 'RS256');

    const jwt = await new SignJWT({
        iss: env.GOOGLE_CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly",
        aud: "https://oauth2.googleapis.com/token",
        exp: now + 3600, iat: now,
    }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(privateKey);

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const data = await parseJsonResponse(res, "Google OAuth token");
    if (!data?.access_token) {
        throw new Error("Tidak dapat mengambil token Google");
    }
    await env.BOT_MEMORY.put(cacheKey, data.access_token, { expirationTtl: 3000 });
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
 * Baca data spreadsheet secara diam-diam untuk konteks AI
 */
export async function silentReadSheetForAI(env, spreadsheetId, tabName = "") {
    if (!spreadsheetId) return null;
    const token = await getGoogleToken(env);
    
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
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
// PDF EXPORT (Google Drive API - GRATIS)
// ============================================================

/**
 * Export Google Sheets ke PDF menggunakan Google Drive API
 * Ini GRATIS dan tidak perlu API key pihak ketiga
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @returns {ArrayBuffer} PDF file buffer
 */
async function exportSheetToPdf(env, spreadsheetId, tabName = "") {
    const token = await getGoogleToken(env);
    
    // 1. Dapatkan metadata spreadsheet untuk mencari sheet GID
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
    
    if (sheets.length === 0) {
        throw new Error("Spreadsheet tidak memiliki sheet.");
    }

    // 2. Cari sheet berdasarkan nama atau gunakan sheet pertama
    let targetSheet = sheets[0];
    if (tabName) {
        const foundSheet = sheets.find(s => s.properties.title.toLowerCase().includes(tabName.toLowerCase()));
        if (foundSheet) targetSheet = foundSheet;
    }

    const sheetGid = targetSheet.properties.sheetId;
    console.log(`Exporting PDF: ${spreadsheetId} / ${targetSheet.properties.title} (GID: ${sheetGid})`);

    // 3. Export sebagai PDF menggunakan Google Drive API
    // Parameter:
    // - format=pdf: export sebagai PDF
    // - gid: sheet ID (untuk sheet tertentu)
    // - portrait=false: landscape (lebih lebar, cocok untuk spreadsheet)
    // - fitw=true: fit to width
    // - gridlines=false: sembunyikan gridlines
    const exportUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf&gid=${sheetGid}&portrait=false&fitw=true&gridlines=false`;
    
    const pdfRes = await fetch(exportUrl, {
        headers: { "Authorization": `Bearer ${token}` }
    });

    if (!pdfRes.ok) {
        const errorText = await pdfRes.text();
        console.error(`PDF export error: status=${pdfRes.status} body=${errorText.substring(0, 300)}`);
        throw new Error(`Gagal export PDF: HTTP ${pdfRes.status}`);
    }

    const pdfBuffer = await pdfRes.arrayBuffer();
    console.log(`PDF buffer size: ${pdfBuffer.byteLength} bytes`);

    if (pdfBuffer.byteLength < 100) {
        throw new Error("PDF hasil export tidak valid atau kosong.");
    }

    // Validasi PDF signature (%PDF-)
    const header = new Uint8Array(pdfBuffer.slice(0, 5));
    const pdfSignature = [0x25, 0x50, 0x44, 0x46, 0x2D];
    if (!pdfSignature.every((byte, index) => header[index] === byte)) {
        console.log(`Invalid PDF signature, hex: ${Array.from(header).map(b => b.toString(16)).join(' ')}`);
        throw new Error("File hasil export bukan PDF yang valid.");
    }

    return pdfBuffer;
}

// ============================================================
// PDF TO PNG CONVERSION (via Vercel Puppeteer)
// ============================================================

/**
 * Convert PDF ke PNG menggunakan Vercel endpoint /api/pdf-to-png
 * Ini adalah alur baru tanpa freemium API:
 * 1. Export sheet ke PDF (Google Drive API - gratis)
 * 2. Kirim PDF base64 ke Vercel endpoint (puppeteer)
 * 3. Dapatkan PNG buffer
 * 
 * @param {ArrayBuffer} pdfBuffer - Buffer PDF
 * @param {Object} env - Environment variables
 * @returns {ArrayBuffer} PNG buffer
 */
async function convertPdfToPng(pdfBuffer, env) {
    // Konversi PDF buffer ke base64
    let binary = '';
    const bytes = new Uint8Array(pdfBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64Pdf = btoa(binary);
    
    const vercelUrl = env.VERCEL_PDF_TO_PNG_URL || "https://seatalkbot.vercel.app/api/pdf-to-png";
    
    console.log(`Mengirim PDF ke Vercel: ${vercelUrl} (${Math.round(pdfBuffer.byteLength / 1024)}KB)`);
    
    const response = await fetch(vercelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            pdf_base64: base64Pdf,
            page: 1,
            scale: 2
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel PDF-to-PNG gagal: HTTP ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("image/png") && !contentType.includes("image")) {
        const text = await response.text();
        throw new Error(`Vercel mengembalikan format salah: ${contentType} - ${text.substring(0, 200)}`);
    }

    const pngBuffer = await response.arrayBuffer();
    console.log(`PNG buffer diterima: ${pngBuffer.byteLength} bytes`);

    if (pngBuffer.byteLength < 100) {
        throw new Error("PNG hasil convert terlalu kecil/rusak.");
    }

    return pngBuffer;
}

// ============================================================
// MAIN SCREENSHOT FUNCTION
// ============================================================

/**
 * Generate PNG dari spreadsheet
 * ALUR BARU (TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Kirim PDF ke Vercel untuk di-convert ke PNG (puppeteer)
 * 3. Kirim PNG ke SeaTalk
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @param {String} customRange - Custom range (optional)
 * @returns {ArrayBuffer} PNG image buffer
 */
export async function generateSheetPng(env, spreadsheetId, tabName = "", customRange = null) {
    // Gunakan alur: Export PDF -> Kirim ke Vercel -> Dapatkan PNG
    console.log(`generateSheetPng: Exporting sheet ${spreadsheetId}/${tabName} ke PDF dulu...`);
    
    // STEP 1: Export spreadsheet ke PDF (gratis via Google Drive API)
    const pdfBuffer = await exportSheetToPdf(env, spreadsheetId, tabName);
    console.log(`PDF berhasil di-export: ${pdfBuffer.byteLength} bytes`);

    // STEP 2: Convert PDF ke PNG via Vercel endpoint
    const pngBuffer = await convertPdfToPng(pdfBuffer, env);
    console.log(`PNG berhasil di-convert: ${pngBuffer.byteLength} bytes`);
    
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
 * Membaca dan menampilkan data spreadsheet
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
 * ALUR BARU (TANPA FREEMIUM):
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Kirim PDF ke Vercel untuk di-convert ke PNG (puppeteer)
 * 3. Kirim PNG ke SeaTalk via base64
 */
export async function handleScreenshotCommand(env, targetId, text, isGroup, threadId, originalMessageId) {
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    
    // Cari sheet ID dari URL atau dari memory
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const sheetId = explicitSheetId || await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    
    if (!sheetId) {
        return await replyToUser(env, "⚠️ Sheet tidak ditemukan. Gunakan /setsheet <url> terlebih dahulu.", targetId, isGroup, threadId, originalMessageId);
    }
    
    const tokensForTabAndRange = explicitSheetId
        ? tokens.filter(token => !extractSpreadsheetId(token) && !/^url=/i.test(token))
        : tokens;
    const { tabName, customRange } = parseScreenshotArguments(tokensForTabAndRange);
    
    console.log(`Screenshot command: sheetId=${sheetId} tabName="${tabName}" customRange=${customRange}`);
    
    // Kirim pesan "processing"
    await replyToUser(env, "⏳ Sedang memproses screenshot...", targetId, isGroup, threadId, originalMessageId);
    
    try {
        // STEP 1: Export ke PDF via Google Drive API
        const pdfBuffer = await exportSheetToPdf(env, sheetId, tabName);
        console.log(`PDF berhasil di-export: ${pdfBuffer.byteLength} bytes`);

        // STEP 2: Convert PDF ke PNG via Vercel
        const pngBuffer = await convertPdfToPng(pdfBuffer, env);
        console.log(`PNG berhasil di-convert: ${pngBuffer.byteLength} bytes`);
        
        // STEP 3: Kirim PNG ke SeaTalk
        await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, threadId);
        
        await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, threadId, originalMessageId);
        
    } catch (err) {
        console.error("Screenshot error:", err);
        await replyToUser(env, `❌ Gagal membuat screenshot: ${err.message}`, targetId, isGroup, threadId, originalMessageId);
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
    console.log("DEBUG: handleInventoryQuery dipanggil.");
    await replyToUser(env, "📦 Fitur inventory sedang dalam pengembangan.", targetId, isGroup, threadId, originalMessageId);
    return null;
}
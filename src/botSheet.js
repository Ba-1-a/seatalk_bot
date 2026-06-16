/**
 * src/botSheet.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Engine pemrosesan Google Sheets dan screenshot
 * 
 * ALUR SCREENSHOT (TANPA FREEMIUM, TANPA PDF):
 * 1. Fetch data langsung dari Google Sheets API (gratis) - BUKAN export PDF
 * 2. Kirim JSON rows ke Vercel endpoint /api/pdf-to-png
 * 3. Vercel render HTML table + screenshot PNG
 * 4. Kirim PNG ke SeaTalk via file upload
 * 
 * FITUR:
 * - Autentikasi Google Service Account (JWT)
 * - Baca data spreadsheet untuk AI
 * - Fetch data spreadsheet (tanpa PDF conversion)
 * - Convert data rows ke PNG via Vercel Puppeteer
 * - Kirim screenshot ke SeaTalk
 * - Handler command: /setsheet, /readsheet, /screenshot
 */

import { replyToUser, sendScreenshotToUser } from './utils.js';
import { importPKCS8, SignJWT } from 'jose';
import { createLogger, SERVICES } from './logger.js';

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
 */
async function getGoogleToken(env) {
    const cacheKey = "google_oauth_token";
    try {
        const cachedToken = await env.BOT_MEMORY.get(cacheKey);
        if (cachedToken) {
            googleLog.debug('Google OAuth token loaded from cache');
            return cachedToken;
        }
    } catch (err) {}

    const now = Math.floor(Date.now() / 1000);
    
    if (!env.GOOGLE_PRIVATE_KEY) {
        throw new Error("GOOGLE_PRIVATE_KEY belum di-set di Cloudflare Workers. Jalankan: npx wrangler secret put GOOGLE_PRIVATE_KEY");
    }
    googleLog.info('Generating new Google OAuth token via JWT');
    
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
// SHEET DATA FETCH (langsung dari Google Sheets API - GRATIS)
// ============================================================

/**
 * Fetch data langsung dari Google Sheets API
 * Tidak perlu export PDF - kirim JSON rows langsung ke Vercel
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @param {String} customRange - Range kustom (optional)
 * @returns {Object} { title, rows }
 */
async function fetchSheetData(env, spreadsheetId, tabName = "", customRange = null) {
    const token = await getGoogleToken(env);
    
    // 1. Dapatkan metadata spreadsheet
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
    
    if (sheets.length === 0) {
        throw new Error("Spreadsheet tidak memiliki sheet.");
    }

    // 2. Cari sheet target
    let targetSheet = sheets[0];
    if (tabName) {
        const foundSheet = sheets.find(s => s.properties.title.toLowerCase().includes(tabName.toLowerCase()));
        if (foundSheet) targetSheet = foundSheet;
    }

    const targetSheetTitle = targetSheet.properties.title;
    
    // 3. Tentukan range
    let range = customRange || 'A1:Z50';
    if (!customRange) {
        const gridProps = targetSheet.properties.gridProperties;
        if (gridProps) {
            const maxRow = Math.min(gridProps.rowCount || 50, 100);
            const maxCol = Math.min(gridProps.columnCount || 26, 26);
            const endCol = String.fromCharCode(64 + maxCol);
            range = `A1:${endCol}${maxRow}`;
        }
    }

    googleLog.info('Fetching sheet data', { spreadsheetId, targetSheetTitle, range });

    // 4. Ambil data
    const dataRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(targetSheetTitle)}!${range}`, 
        { headers: { "Authorization": `Bearer ${token}` } }
    );
    const sheetData = await parseJsonResponse(dataRes, `Sheets values for ${spreadsheetId}`);
    const values = sheetData?.values || [];

    if (values.length === 0) {
        throw new Error("Tidak ada data dalam spreadsheet.");
    }

    googleLog.info('Sheet data fetched', { rowCount: values.length });

    return { title: targetSheetTitle, rows: values };
}

// ============================================================
// SCREENSHOT via Vercel (kirim data JSON, bukan PDF)
// ============================================================

/**
 * Kirim data rows ke Vercel untuk di-render sebagai HTML table + screenshot PNG
 * ALUR: Fetch data dari API -> Kirim JSON ke Vercel -> Dapatkan PNG
 * Tidak perlu PDF conversion, tidak perlu pdfjs-dist!
 * 
 * @param {Object} sheetData - { title, rows }
 * @param {Object} env - Environment variables
 * @returns {ArrayBuffer} PNG buffer
 */
async function convertSheetDataToPng(sheetData, env) {
    const vercelUrl = env.VERCEL_PDF_TO_PNG_URL || "https://seatalkbot.vercel.app/api/pdf-to-png";
    
    vercelLog.info('Sending sheet data to Vercel for screenshot', { 
        url: vercelUrl, 
        title: sheetData.title, 
        rows: sheetData.rows.length 
    });
    
    const response = await fetch(vercelUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            sheet_title: sheetData.title,
            rows: sheetData.rows,
            scale: 2
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        vercelLog.error('Vercel screenshot conversion failed', { status: response.status, body: errorText.substring(0, 200) });
        throw new Error(`Vercel screenshot gagal: HTTP ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("image/png") && !contentType.includes("image")) {
        const text = await response.text();
        vercelLog.error('Vercel returned wrong content type', { contentType, body: text.substring(0, 200) });
        throw new Error(`Vercel mengembalikan format salah: ${contentType} - ${text.substring(0, 200)}`);
    }

    const pngBuffer = await response.arrayBuffer();
    vercelLog.info('PNG received from Vercel', { sizeBytes: pngBuffer.byteLength });

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
 * ALUR BARU (TANPA FREEMIUM, TANPA FILE:// DEPENDENCY):
 * 1. Fetch data langsung dari Google Sheets API (GRATIS)
 * 2. Kirim JSON rows ke Vercel untuk di-render HTML + screenshot
 * 3. Kirim PNG ke SeaTalk
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @param {String} customRange - Custom range (optional)
 * @returns {ArrayBuffer} PNG image buffer
 */
export async function generateSheetPng(env, spreadsheetId, tabName = "", customRange = null) {
    googleLog.info('generateSheetPng: Starting', { spreadsheetId, tabName, customRange });
    
    // STEP 1: Fetch data langsung dari Google Sheets API
    const sheetData = await fetchSheetData(env, spreadsheetId, tabName, customRange);
    googleLog.info('Sheet data fetched', { title: sheetData.title, rows: sheetData.rows.length });

    // STEP 2: Kirim data ke Vercel untuk di-render HTML + screenshot
    const pngBuffer = await convertSheetDataToPng(sheetData, env);
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
 * ALUR BARU (TANPA PDF, TANPA FREEMIUM):
 * 1. Fetch data langsung dari Google Sheets API (GRATIS)
 * 2. Kirim JSON rows ke Vercel untuk di-render HTML + screenshot
 * 3. Upload PNG ke SeaTalk
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
    
    googleLog.info('Screenshot command received', { sheetId, tabName, customRange });
    
    // Kirim pesan "processing"
    await replyToUser(env, "⏳ Sedang memproses screenshot...", targetId, isGroup, threadId, originalMessageId);
    
    try {
        // STEP 1: Fetch data langsung dari Google Sheets API (BUKAN export PDF)
        const sheetData = await fetchSheetData(env, sheetId, tabName, customRange);
        googleLog.info('Screenshot: Sheet data fetched', { title: sheetData.title, rows: sheetData.rows.length });

        // STEP 2: Kirim data rows ke Vercel untuk di-render HTML + screenshot
        const pngBuffer = await convertSheetDataToPng(sheetData, env);
        vercelLog.info('Screenshot: PNG from Vercel', { sizeBytes: pngBuffer.byteLength });
        
        // STEP 3: Upload dan kirim PNG ke SeaTalk
        await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, threadId);
        
        await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, threadId, originalMessageId);
        
    } catch (err) {
        googleLog.error('Screenshot command failed', err);
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
    googleLog.info('Inventory query received (placeholder)');
    await replyToUser(env, "📦 Fitur inventory sedang dalam pengembangan.", targetId, isGroup, threadId, originalMessageId);
    return null;
}
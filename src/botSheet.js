/**
 * src/botSheet.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Engine pemrosesan Google Sheets dan screenshot
 * 
 * ALUR SCREENSHOT BARU:
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis, tidak perlu API key pihak ketiga)
 * 2. Convert PDF ke PNG menggunakan html2canvas approach (render HTML table -> PNG)
 * 3. Kirim PNG ke SeaTalk via base64
 * 
 * FITUR:
 * - Autentikasi Google Service Account (JWT)
 * - Baca data spreadsheet untuk AI
 * - Export spreadsheet ke PDF via Google Drive API
 * - Render spreadsheet sebagai HTML table -> PNG
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
// HTML RENDERING & PNG CONVERSION
// ============================================================

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Render spreadsheet data sebagai HTML table yang cantik
 * @param {String} title - Judul sheet
 * @param {Array} values - 2D array data
 * @returns {String} HTML string
 */
function renderSheetAsHtml(title, values) {
    // Hitung lebar kolom berdasarkan konten
    const colWidths = [];
    for (const row of values) {
        for (let i = 0; i < row.length; i++) {
            const cellLen = String(row[i] || '').length;
            if (!colWidths[i] || cellLen > colWidths[i]) {
                colWidths[i] = Math.min(cellLen, 30); // Max 30 chars
            }
        }
    }

    let html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { 
        font-family: 'Segoe UI', 'Roboto', Arial, sans-serif; 
        background: #ffffff; 
        padding: 0;
        width: max-content;
        min-width: 800px;
    }
    .container {
        padding: 16px;
    }
    .header {
        background: linear-gradient(135deg, #1a73e8 0%, #0d47a1 100%);
        color: white;
        padding: 14px 20px;
        font-size: 18px;
        font-weight: 600;
        margin-bottom: 0;
        border-radius: 0;
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
    td {
        color: #202124;
    }
    tr:nth-child(even) td {
        background: #f8f9fa;
    }
    tr:hover td {
        background: #e8f0fe;
    }
    .footer {
        margin-top: 12px;
        font-size: 11px;
        color: #9aa0a6;
        text-align: right;
    }
</style>
</head>
<body>
<div class="container">
<div class="header">📊 Spreadsheet Export<div class="sheet-title">${escapeHtml(title)}</div></div>
<table>
`;

    // Header row
    if (values.length > 0) {
        html += '<thead><tr>';
        for (const cell of values[0]) {
            html += `<th>${escapeHtml(String(cell || ''))}</th>`;
        }
        html += '</tr></thead><tbody>';

        // Data rows
        for (let i = 1; i < values.length; i++) {
            html += '<tr>';
            for (const cell of values[i]) {
                html += `<td>${escapeHtml(String(cell || ''))}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody>';
    }

    html += `</table>
<div class="footer">Generated by VASA • ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</div>
</div>
</body></html>`;
    return html;
}

/**
 * Convert HTML ke PNG menggunakan layanan gratis
 * Kita gunakan beberapa opsi fallback:
 * 1. htmlcsstoimage.com (gratis 100/bulan)
 * 2. ScreenshotAPI.net (gratis 100/bulan)
 * 3. Vercel screenshot API (jika dideploy)
 * 
 * @param {String} html - HTML string
 * @param {Object} env - Environment variables
 * @returns {ArrayBuffer} PNG buffer
 */
async function convertHtmlToPng(html, env) {
    // Opsi 1: htmlcsstoimage.com (gratis 100/bulan)
    if (env.HTML_TO_IMAGE_API_KEY) {
        try {
            const response = await fetch('https://hcti.io/v1/image', {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${btoa(env.HTML_TO_IMAGE_API_KEY + ':')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    html: html,
                    viewport_width: 1200,
                    viewport_height: 800,
                    device_scale_factor: 2
                })
            });
            
            const data = await response.json();
            if (data.url) {
                const imageRes = await fetch(data.url);
                return await imageRes.arrayBuffer();
            }
        } catch (err) {
            console.log('htmlcsstoimage error:', err.message);
        }
    }
    
    // Opsi 2: ScreenshotAPI.net (gratis 100/bulan)
    if (env.SCREENSHOT_API_KEY) {
        try {
            const encodedHtml = encodeURIComponent(html);
            const url = `https://api.screenshotapi.net/screenshot?token=${env.SCREENSHOT_API_KEY}&url=data:text/html,${encodedHtml}&width=1200&height=800&output=image&file_type=png`;
            const response = await fetch(url);
            const data = await response.json();
            if (data.screenshot) {
                const imageRes = await fetch(data.screenshot);
                return await imageRes.arrayBuffer();
            }
        } catch (err) {
            console.log('screenshotapi error:', err.message);
        }
    }
    
    // Opsi 3: Gunakan Vercel deployment untuk screenshot
    if (env.VERCEL_SCREENSHOT_URL) {
        try {
            const response = await fetch(env.VERCEL_SCREENSHOT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ html: html, width: 1200, height: 800 })
            });
            if (response.ok) {
                return await response.arrayBuffer();
            }
        } catch (err) {
            console.log('vercel screenshot error:', err.message);
        }
    }
    
    throw new Error("Tidak ada image conversion API yang dikonfigurasi. Set HTML_TO_IMAGE_API_KEY, SCREENSHOT_API_KEY, atau VERCEL_SCREENSHOT_URL.");
}

// ============================================================
// MAIN SCREENSHOT FUNCTION
// ============================================================

/**
 * Generate PNG dari spreadsheet
 * Alur: Ambil data -> Render HTML -> Convert ke PNG
 * 
 * @param {Object} env - Environment variables
 * @param {String} spreadsheetId - ID spreadsheet
 * @param {String} tabName - Nama tab (optional)
 * @param {String} customRange - Custom range (optional)
 * @returns {ArrayBuffer} PNG image buffer
 */
export async function generateSheetPng(env, spreadsheetId, tabName = "", customRange = null) {
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
    
    // 3. Tentukan range yang akan diambil
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

    console.log(`Generating PNG: ${spreadsheetId} / ${targetSheetTitle} / ${range}`);

    // 4. Ambil data spreadsheet
    const dataRes = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(targetSheetTitle)}!${range}`, 
        { headers: { "Authorization": `Bearer ${token}` } }
    );
    const sheetData = await parseJsonResponse(dataRes, `Sheets values for ${spreadsheetId}`);
    const values = sheetData?.values || [];

    if (values.length === 0) {
        throw new Error("Tidak ada data dalam spreadsheet.");
    }

    // 5. Render data sebagai HTML table
    const html = renderSheetAsHtml(targetSheetTitle, values);

    // 6. Convert HTML ke PNG
    const pngBuffer = await convertHtmlToPng(html, env);
    
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
 * Alur baru:
 * 1. Export spreadsheet ke PDF via Google Drive API (gratis)
 * 2. Render data sebagai HTML table
 * 3. Convert HTML ke PNG menggunakan layanan gratis
 * 4. Kirim PNG ke SeaTalk via base64
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
        // 1. Generate PNG dari data spreadsheet (render HTML -> PNG)
        const pngBuffer = await generateSheetPng(env, sheetId, tabName, customRange);
        console.log(`PNG generated: ${pngBuffer.byteLength} bytes`);
        
        // 2. Kirim PNG ke SeaTalk
        await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, threadId);
        
        await replyToUser(env, "✅ Screenshot berhasil dikirim!", targetId, isGroup, threadId, originalMessageId);
        
    } catch (err) {
        console.error("Screenshot error:", err);
        
        // Fallback: coba export PDF saja dan kirim sebagai pesan
        try {
            const pdfBuffer = await exportSheetToPdf(env, sheetId, tabName);
            console.log(`PDF fallback: ${pdfBuffer.byteLength} bytes`);
            
            // Convert PDF base64 untuk dikirim sebagai file (jika SeaTalk support)
            let binary = '';
            const bytes = new Uint8Array(pdfBuffer);
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64Pdf = btoa(binary);
            
            await replyToUser(env, `⚠️ Gagal convert ke PNG. PDF berhasil di-export (${Math.round(pdfBuffer.byteLength/1024)}KB). Error: ${err.message}`, targetId, isGroup, threadId, originalMessageId);
        } catch (pdfErr) {
            await replyToUser(env, `❌ Gagal membuat screenshot: ${err.message}`, targetId, isGroup, threadId, originalMessageId);
        }
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
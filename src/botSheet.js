/**
 * src/botSheet.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * BYPASS MEMORI ARCHITECTURE: Cloudflare Worker → HF Spaces (direct)
 * 
 * ALUR SCREENSHOT (NEW - NO VERCEL):
 * 1. Worker generate Google Sheet export URL (TIDAK download PDF)
 * 2. Get Google OAuth token (untuk private sheets)
 * 3. Kirim message "Memproses..." ke SeaTalk (sync)
 * 4. ctx.waitUntil() untuk background task:
 *    - POST ke HF Spaces dengan sheet_url + google_access_token
 *    - HF Spaces download PDF, render PNG, return binary
 *    - Worker kirim PNG ke SeaTalk
 * 5. Worker langsung return 200 (tidak tunggu HF Spaces)
 * 
 * KEUNTUNGAN:
 * - Tidak ada Vercel dependency
 * - Tidak ada Base64 PDF encoding (hemat bandwidth)
 * - Tidak ada CF Worker timeout (30 detik)
 * - Private sheets supported (Google auth transfer)
 * - Multi-project support via Bearer token
 */

import { replyToUser, sendScreenshotToUser } from './utils.js';
import { importPKCS8, SignJWT } from 'jose';
import { createLogger, SERVICES } from './logger.js';
import { resolveRenderOptions } from './renderOptions.js';

const googleLog = createLogger(SERVICES.GOOGLE);
const hfLog = createLogger(SERVICES.HF_SPACES);

// ============================================================
// GOOGLE AUTHENTICATION
// ============================================================

function sanitizePemKey(raw) {
    if (!raw) throw new Error('GOOGLE_PRIVATE_KEY kosong');
    
    let key = raw.trim();
    
    // Remove surrounding quotes jika ada (kadang secret disimpan dengan quotes)
    if ((key.startsWith('"') && key.endsWith('"')) || 
        (key.startsWith("'") && key.endsWith("'"))) {
        key = key.slice(1, -1);
    }
    
    // Normalize newline variants
    key = key.replace(/\\n/g, '\n');
    key = key.replace(/\r\n/g, '\n');
    key = key.replace(/\r/g, '\n');
    
    // NOTE: Don't trim per-line! Base64 is whitespace-sensitive.
    
    // Validate structure
    if (!key.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('PEM header hilang setelah sanitasi');
    }
    if (!key.includes('-----END PRIVATE KEY-----')) {
        throw new Error('PEM footer hilang setelah sanitasi');
    }
    
    return key;
}

function pemToDer(pem) {
    let b64 = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s/g, '');
    
    if (!b64) throw new Error('PEM base64 kosong');
    
    const binaryString = atob(b64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
}

async function getGoogleToken(env) {
    const cacheKey = "google_oauth_token";
    try {
        const cachedToken = await env.BOT_MEMORY.get(cacheKey);
        if (cachedToken) {
            googleLog.debug('Google OAuth token loaded from cache');
            return cachedToken;
        }
    } catch (err) {
        googleLog.debug('Cache read failed, generating new token');
    }

    const now = Math.floor(Date.now() / 1000);
    
    // Option B: Load dari service account JSON (lebih robust)
    let serviceAccount = null;
    let clientEmail = env.GOOGLE_CLIENT_EMAIL;
    let rawKey = null;
    
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        // Parse service account JSON
        try {
            serviceAccount = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
        } catch (parseErr) {
            throw new Error(
                'Gagal parse GOOGLE_SERVICE_ACCOUNT_JSON. Pastikan secret berisi JSON service account yang valid.\n' +
                `Detail: ${parseErr.message}`
            );
        }
        
        rawKey = serviceAccount.private_key;
        clientEmail = serviceAccount.client_email;
        
        googleLog.info('Loaded service account from JSON', {
            hasPrivateKey: !!rawKey,
            hasClientEmail: !!clientEmail,
            keyLength: rawKey ? rawKey.length : 0
        });
    } else {
        // Fallback ke old path (GOOGLE_PRIVATE_KEY env)
        rawKey = env.GOOGLE_PRIVATE_KEY;
    }
    
    if (!rawKey) {
        throw new Error('GOOGLE_PRIVATE_KEY atau GOOGLE_SERVICE_ACCOUNT_JSON tidak dikonfigurasi');
    }
    
    // Sanitasi ekstrem
    const pemKey = sanitizePemKey(rawKey);
    
    googleLog.info('PEM snippet after sanitize', {
        firstChars: pemKey.slice(0, 20),
        lastChars: pemKey.slice(-20)
    });
    
    // Convert PEM to DER manually for reliable parsing
    const der = pemToDer(pemKey);
    const base64Clean = pemKey.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
    googleLog.info('DER conversion diagnostics', {
        lineCount: pemKey.split('\n').length,
        base64Length: base64Clean.length,
        derLength: der.length,
        firstBytes: Array.from(der.slice(0, 10))
    });
    
    let privateKey;
    try {
        privateKey = await importPKCS8(der, 'der');
    } catch (keyErr) {
        throw new Error(
            'Gagal memparse GOOGLE_PRIVATE_KEY. Pastikan formatnya benar.\n' +
            'Coba set ulang: Get-Content google-key.pem | wrangler secret put GOOGLE_PRIVATE_KEY\n' +
            `Detail: ${keyErr.message}`
        );
    }

    let jwt;
    try {
        jwt = await new SignJWT({
            iss: clientEmail,
            scope: "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600, iat: now,
        }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(privateKey);
    } catch (jwtErr) {
        throw new Error(`Gagal membuat JWT untuk Google OAuth: ${jwtErr.message}`);
    }

    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
    });

    const data = await res.json();
    if (!data.access_token) throw new Error(`Google OAuth failed: ${data.error_description || data.error}`);
    
    await env.BOT_MEMORY.put(cacheKey, data.access_token, { expirationTtl: 3000 });
    googleLog.info('Google OAuth token obtained and cached');
    return data.access_token;
}

// ============================================================
// UTILITIES
// ============================================================

export function extractSpreadsheetId(url) {
    const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return matches ? matches[1] : null;
}

function parseCustomRange(rangeStr) {
    if (!rangeStr) return null;
    let upperRange = rangeStr.trim().replace(/^range\s*[=:]\s*/i, '').replace(/^r\s*[=:]\s*/i, '').toUpperCase();

    const explicitMatch = upperRange.match(/^([A-Z]{1,3})?(\d+)?:([A-Z]{1,3})?(\d+)?$/);
    if (explicitMatch) {
        const [, startCol, startRow, endCol, endRow] = explicitMatch;
        if (startCol && endCol && !startRow && !endRow) return `${startCol}1:${endCol}50`;
        if (startCol || endCol || startRow || endRow) {
            const start = (startCol || 'A') + (startRow || '1');
            const end = (endCol || 'Z') + (endRow || '50');
            return `${start}:${end}`;
        }
    }

    const rowMatch = upperRange.match(/^(\d+)-(\d+)$/);
    if (rowMatch) return `A${rowMatch[1]}:Z${rowMatch[2]}`;

    const simpleMatch = upperRange.match(/^([A-Z]{1,3})(\d+)$/);
    if (simpleMatch) return `${simpleMatch[1]}${simpleMatch[2]}:${simpleMatch[1]}50`;

    return null;
}

function parseA1RangeToIndices(range) {
    if (!range) return null;
    const cleanRange = range.toUpperCase().replace(/\s/g, '');
    const match = cleanRange.match(/^([A-Z]{1,3})(\d*):([A-Z]{1,3})(\d*)$/);
    if (!match) return null;

    const [, startColStr, startRowStr, endColStr, endRowStr] = match;
    const colToIndex = (colStr) => {
        let index = 0;
        for (let i = 0; i < colStr.length; i++) index = index * 26 + (colStr.charCodeAt(i) - 64);
        return index - 1;
    };

    const c1 = colToIndex(startColStr);
    const c2 = colToIndex(endColStr) + 1;
    const startRow = startRowStr ? parseInt(startRowStr, 10) : 1;
    const endRow = endRowStr ? parseInt(endRowStr, 10) : 1000;
    const r1 = startRow - 1;
    const r2 = endRow;

    googleLog.info('Parsed A1 range', { range, r1, c1, r2, c2 });
    return { r1, c1, r2, c2 };
}

function normalizeRangeToken(rangeStr) {
    if (!rangeStr) return null;
    return rangeStr.trim().replace(/^range\s*[=:]\s*/i, '').replace(/^r\s*[=:]\s*/i, '');
}

// ============================================================
// GOOGLE EXPORT URL GENERATOR (NEW - No PDF download)
// ============================================================

function generateGoogleExportUrl(spreadsheetId, tabName, rangeIndices, env) {
    let url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=pdf`;
    url += `&gridlines=false&printtitle=false&fzr=false&pagenum=false`;
    
    let paperSize = 'TABLOID';
    let isPortrait = false;
    
    if (rangeIndices) {
        const colCount = rangeIndices.c2 - rangeIndices.c1;
        if (colCount <= 4) { paperSize = 'EXECUTIVE'; isPortrait = true; }
        else if (colCount <= 8) { paperSize = 'LETTER'; isPortrait = true; }
        else { paperSize = 'TABLOID'; isPortrait = false; }
    }
    
    url += `&portrait=${isPortrait}&size=${paperSize}`;
    url += `&fitw=true&fith=true&scale=2`;
    url += `&top_margin=0&bottom_margin=0&left_margin=0&right_margin=0`;
    
    if (tabName) {
        getSheetsList(env, spreadsheetId).then(sheetsList => {
            const foundSheet = sheetsList.find(s => s.title.toLowerCase().includes(tabName.toLowerCase()));
            if (foundSheet) url += `&gid=${foundSheet.gid}`;
        }).catch(() => {});
    }
    
    if (rangeIndices) {
        url += `&r1=${rangeIndices.r1}&c1=${rangeIndices.c1}&r2=${rangeIndices.r2}&c2=${rangeIndices.c2}`;
    }
    
    googleLog.info('Generated Google export URL', { paperSize, colCount: rangeIndices ? rangeIndices.c2 - rangeIndices.c1 : 'full' });
    return url;
}

async function getSheetsList(env, spreadsheetId) {
    const token = await getGoogleToken(env);
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, {
        headers: { "Authorization": `Bearer ${token}` }
    });
    const metaData = await metaRes.json();
    const sheets = metaData?.sheets || [];
    return sheets.map(s => ({
        title: s.properties.title,
        gid: s.properties.sheetId,
        rowCount: s.properties.gridProperties?.rowCount || 0,
        columnCount: s.properties.gridProperties?.columnCount || 0
    }));
}

// ============================================================
// HF SPACES CLIENT (NEW - Direct call, no Vercel)
// ============================================================

async function renderViaHfSpaces(exportUrl, googleAccessToken, env) {
    const HF_URL = env.HF_SPACES_URL;
    const HF_TOKEN = env.HF_API_KEY;
    
    if (!HF_URL || !HF_TOKEN) {
        throw new Error('HF_SPACES_URL atau HF_API_KEY tidak dikonfigurasi di wrangler.toml');
    }
    
    hfLog.info('Calling HF Spaces for rendering', { url: HF_URL });
    
    const response = await fetch(`${HF_URL}/render`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${HF_TOKEN}`,
            'X-Project-ID': 'seatalk_bot'
        },
        body: JSON.stringify({
            sheet_url: exportUrl,
            google_access_token: googleAccessToken,
            render_options: {
                scale: 2.5,
                max_pages: 5,
                device_scale_factor: 2.5
            }
        }),
        signal: AbortSignal.timeout(120000) // 2 menit timeout
    });
    
    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        hfLog.error('HF Spaces render failed', { status: response.status, body: errText.substring(0, 300) });
        throw new Error(`HF Spaces error: HTTP ${response.status} - ${errText.substring(0, 100)}`);
    }
    
    const pngBuffer = await response.arrayBuffer();
    hfLog.info('PNG received from HF Spaces', { sizeBytes: pngBuffer.byteLength });
    
    if (pngBuffer.byteLength < 100) {
        throw new Error("PNG hasil render terlalu kecil/rusak.");
    }
    
    return pngBuffer;
}

// ============================================================
// ASYNC SCREENSHOT HANDLER (ctx.waitUntil)
// ============================================================

export async function handleScreenshotCommand(env, targetId, text, isGroup, threadId, originalMessageId, ctx) {
    const reqId = crypto.randomUUID().slice(0, 8);
    const log = googleLog.child({ reqId, targetId, isGroup });
    
    log.enter('handleScreenshotCommand', { text: text.substring(0, 50) });
    
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    
    const rateLimitResult = await checkScreenshotRateLimit(env, targetId, isGroup, reqId);
    if (!rateLimitResult.allowed) {
        return await replyToUser(env, rateLimitResult.message, targetId, isGroup, threadId, originalMessageId);
    }
    
    await replyToUser(env, "⏳ Memproses screenshot...", targetId, isGroup, threadId, originalMessageId);
    
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const storedSheetId = await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    const sheetId = explicitSheetId || storedSheetId;
    
    if (!sheetId) {
        await clearScreenshotRateLimit(env, targetId, isGroup, reqId);
        return await replyToUser(env, "⚠️ Sheet tidak ditemukan. Gunakan /setsheet <url> terlebih dahulu.", targetId, isGroup, threadId, originalMessageId);
    }
    
    let tabName = "";
    let customRange = null;
    
    const tokensForTabAndRange = explicitSheetId
        ? tokens.filter(token => !extractSpreadsheetId(token) && !/^url=/i.test(token))
        : tokens;
    
    for (let token of tokensForTabAndRange) {
        if (!token) continue;
        const tabMatch = token.match(/^tab_name=(.+)$/i);
        if (tabMatch) { tabName = tabMatch[1]; continue; }
        
        const rangeParsed = parseCustomRange(token);
        if (rangeParsed) { customRange = rangeParsed; continue; }
        
        if (!/^\/screenshot$/.test(token)) tabName += (tabName ? " " : "") + token;
    }
    
    let rangeIndices = null;
    if (customRange) {
        rangeIndices = parseA1RangeToIndices(customRange);
        log.info('Custom range parsed', { customRange, rangeIndices });
    }
    
    log.decision('Starting background render');
    ctx.waitUntil(
        renderAndSendAsync(env, targetId, isGroup, threadId, originalMessageId, sheetId, tabName, rangeIndices, reqId)
    );
    
    return;
}

async function renderAndSendAsync(env, targetId, isGroup, threadId, originalMessageId, sheetId, tabName, rangeIndices, reqId) {
    const log = googleLog.child({ reqId, targetId, isGroup });
    
    try {
        log.decision('Getting Google token');
        const googleToken = await getGoogleToken(env);
        
        log.decision('Generating export URL');
        const exportUrl = generateGoogleExportUrl(sheetId, tabName, rangeIndices, env);
        
        log.decision('Calling HF Spaces');
        const pngBuffer = await renderViaHfSpaces(exportUrl, googleToken, env);
        
        log.decision('Sending PNG to SeaTalk');
        await sendScreenshotToUser(env, pngBuffer, targetId, isGroup, threadId, originalMessageId);
        
        log.info('Screenshot completed', { sizeBytes: pngBuffer.byteLength });
        
    } catch (err) {
        log.error('Background render failed', { error: err.message });
        await replyToUser(env, `❌ Gagal membuat screenshot: ${err.message}`, targetId, isGroup, threadId, originalMessageId);
    } finally {
        await clearScreenshotRateLimit(env, targetId, isGroup, reqId);
    }
}

// ============================================================
// RATE LIMITING
// ============================================================

async function checkScreenshotRateLimit(env, targetId, isGroup, reqId) {
    const keyPrefix = isGroup ? 'group' : 'user';
    const processingKey = `screenshot_processing_${keyPrefix}_${targetId}`;
    
    try {
        const processing = await env.BOT_MEMORY.get(processingKey);
        if (processing) {
            return {
                allowed: false,
                message: isGroup
                    ? "⏳ Sedang memproses screenshot sebelumnya di group chat ini. Mohon tunggu hingga selesai."
                    : "⏳ Sedang memproses screenshot sebelumnya. Mohon tunggu hingga selesai sebelum request baru."
            };
        }
        
        await env.BOT_MEMORY.put(processingKey, '1', { expirationTtl: 120 });
        return { allowed: true };
    } catch (err) {
        return { allowed: true };
    }
}

async function clearScreenshotRateLimit(env, targetId, isGroup, reqId) {
    const keyPrefix = isGroup ? 'group' : 'user';
    const processingKey = `screenshot_processing_${keyPrefix}_${targetId}`;
    try {
        await env.BOT_MEMORY.delete(processingKey);
    } catch (err) {
        // ignore
    }
}

// ============================================================
// COMMAND HANDLERS (TIDAK BERUBAH)
// ============================================================

export async function handleSetSheet(env, targetId, text, isGroup, threadId, originalMessageId) {
    const sheetId = extractSpreadsheetId(text);
    if (!sheetId) {
        return await replyToUser(env, "⚠️ URL tidak valid. Gunakan: /setsheet <url_google_sheets>", targetId, isGroup, threadId, originalMessageId);
    }
    await env.BOT_MEMORY.put(`default_sheet_${targetId}`, sheetId);
    await replyToUser(env, "✅ Spreadsheet disimpan sebagai default.", targetId, isGroup, threadId, originalMessageId);
}

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

export async function silentReadSheetForAI(env, spreadsheetId, tabName = "") {
    if (!spreadsheetId) return null;
    const token = await getGoogleToken(env);
    
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await metaRes.json();
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
    const data = await res.json();
    return (data.values || []).map(row => row.join(" | ")).join("\n");
}

export async function getHourlyReportData(env) {
    return "Data Laporan (Sistem sedang disinkronisasi)";
}

export async function handleInventoryQuery(env, targetId, text, isGroup, threadId, originalMessageId) {
    googleLog.info('Inventory query received (placeholder)');
    await replyToUser(env, "📦 Fitur inventory sedang dalam pengembangan.", targetId, isGroup, threadId, originalMessageId);
    return null;
}
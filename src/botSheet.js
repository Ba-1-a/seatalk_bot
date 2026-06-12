/**
 * src/botSheet.js
 * Engine pemrosesan Google Sheets dan rendering biner.
 */

import { replyToUser, sendScreenshotToUser } from './utils.js';
import { importPKCS8, SignJWT } from 'jose';

async function parseJsonResponse(response, context) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (err) {
        console.error(`DEBUG: Invalid JSON response from ${context}. status=${response.status} body=${text.substring(0, 300)}`);
        return null;
    }
}

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
        scope: "https://www.googleapis.com/auth/spreadsheets",
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

export function extractSpreadsheetId(url) {
    const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
    return matches ? matches[1] : null;
}

function normalizeRangeToken(rangeStr) {
    if (!rangeStr) return null;
    const normalized = rangeStr.trim().replace(/^range\s*[=:]\s*/i, '').replace(/^r\s*[=:]\s*/i, '');
    return normalized;
}

function parseCustomRange(rangeStr) {
    if (!rangeStr) return null;
    let upperRange = normalizeRangeToken(rangeStr).toUpperCase();

    // Pattern: A1:D15, A1:R28, dll dengan digit multi, atau A:D (column range)
    // Limit columns ke max 3 huruf (A-Z, AA-ZZ, AAA-ZZZ)
    const explicitMatch = upperRange.match(/^([A-Z]{1,3})?(\d+)?:([A-Z]{1,3})?(\d+)?$/);
    if (explicitMatch) {
        const [, startCol, startRow, endCol, endRow] = explicitMatch;
        // If both columns exist without numbers = pure column range like A:D
        if (startCol && endCol && !startRow && !endRow) {
            console.log(`Range parse: ${rangeStr} -> ${startCol}1:${endCol}50`);
            return `${startCol}1:${endCol}50`;
        }
        // Otherwise normal range parsing
        if (startCol || endCol || startRow || endRow) {
            const start = (startCol || 'A') + (startRow || '1');
            const end = (endCol || 'Z') + (endRow || '50');
            console.log(`Range parse: ${rangeStr} -> ${start}:${end}`);
            return `${start}:${end}`;
        }
    }

    // Pattern alternatif: 5-30 (baris 5-30, kolom A-Z)
    const rowMatch = upperRange.match(/^(\d+)-(\d+)$/);
    if (rowMatch) {
        const [, startRow, endRow] = rowMatch;
        console.log(`Range parse: ${rangeStr} -> A${startRow}:Z${endRow}`);
        return `A${startRow}:Z${endRow}`;
    }

    // Pattern: D15 (kolom D saja dengan baris awal) / OB15
    // PENTING: REQUIRE digit di akhir! Ini hindari match tab names tanpa angka
    const simpleMatch = upperRange.match(/^([A-Z]{1,3})(\d+)$/);
    if (simpleMatch) {
        const [, col, row] = simpleMatch;
        console.log(`Range parse: ${rangeStr} -> ${col}${row}:${col}50`);
        return `${col}${row}:${col}50`;
    }

    console.log(`Range parse: ${rangeStr} -> NOT A RANGE (tab name)`);
    return null;
}

export async function silentReadSheetForAI(env, spreadsheetId, tabName = "") {
    if (!spreadsheetId) return null;
    const token = await getGoogleToken(env);
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { headers: { "Authorization": `Bearer ${token}` } });
    const metaData = await parseJsonResponse(metaRes, `Google Sheets metadata for ${spreadsheetId}`);
    const sheets = metaData?.sheets || [];
    if (sheets.length === 0) return null;

    let targetSheetTitle = sheets[0].properties.title;
    if (tabName) {
        const foundSheet = sheets.find(s => s.properties.title.toLowerCase().includes(tabName.toLowerCase()));
        if (foundSheet) targetSheetTitle = foundSheet.properties.title;
    }

    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(targetSheetTitle)}!A1:Z50`, { headers: { "Authorization": `Bearer ${token}` } });
    const data = await parseJsonResponse(res, `Google Sheets values for ${spreadsheetId} / ${targetSheetTitle}`);
    return (data.values || []).map(row => row.join(" | ")).join("\n");
}

export async function generatePrivateSheetBuffer(env, spreadsheetId, tabName = "", customRange = null) {
    const token = await getGoogleToken(env);
    
    // 1. Ambil metadata untuk mendapatkan GID dari sheet yang ditargetkan
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`, { 
        headers: { "Authorization": `Bearer ${token}` } 
    });
    const metaData = await parseJsonResponse(metaRes, `Google Sheets metadata for ${spreadsheetId}`);
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

    const targetSheetTitle = targetSheet.properties.title;
    const sheetGid = targetSheet.properties.sheetId;

    console.log(`Generating screenshot: ${spreadsheetId} / ${targetSheetTitle} (GID: ${sheetGid})`);

    // 3. Construct Google Sheets URL untuk di-screenshot
    // Format: https://docs.google.com/spreadsheets/d/{id}/edit#gid={gid}
    const sheetsUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetGid}`;

    // 4. Gunakan urlbox.io untuk screenshot
    // Dokumentasi: https://urlbox.io/docs
    if (!env.URLBOX_API_KEY) {
        throw new Error("URLBOX_API_KEY tidak dikonfigurasi di environment variables.");
    }

    const urlboxApiUrl = "https://api.urlbox.io/v1/render";
    const urlboxParams = {
        url: sheetsUrl,
        width: 1200,
        height: 800,
        format: "png",
        full_page: false,
        timeout: 30,
        wait_for: ".waffle-container", // Wait for Sheets to load
        retina: false
    };

    // Encode parameters untuk Basic Auth
    const authHeader = `Basic ${btoa(`${env.URLBOX_API_KEY}:`)}`;

    console.log(`Requesting screenshot from urlbox.io: ${sheetsUrl}`);

    const urlboxRes = await fetch(urlboxApiUrl, {
        method: "POST",
        headers: {
            "Authorization": authHeader,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(urlboxParams)
    });

    console.log(`Urlbox response status: ${urlboxRes.status}`);

    if (!urlboxRes.ok) {
        const errorText = await urlboxRes.text();
        console.log(`Urlbox error: ${errorText.substring(0, 300)}`);
        throw new Error(`Gagal mengambil screenshot dari urlbox.io: HTTP ${urlboxRes.status}`);
    }

    const buffer = await urlboxRes.arrayBuffer();
    console.log(`Screenshot buffer size: ${buffer.byteLength} bytes`);

    if (buffer.byteLength < 100) {
        throw new Error("Screenshot hasil dari urlbox.io tidak valid atau kosong.");
    }

    // 5. Validasi PNG signature
    const header = new Uint8Array(buffer.slice(0, 8));
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (!pngSignature.every((byte, index) => header[index] === byte)) {
        console.log(`Invalid PNG signature, hex: ${Array.from(header).map(b => b.toString(16)).join(' ')}`);
        throw new Error("Screenshot bukan PNG yang valid.");
    }

    return buffer;
}

export async function handleSetSheet(env, targetId, text, isGroup, threadId, originalMessageId) {
    const sheetId = extractSpreadsheetId(text);
    if (!sheetId) return await replyToUser(env, "⚠️ URL tidak valid.", targetId, isGroup, threadId, originalMessageId);
    await env.BOT_MEMORY.put(`default_sheet_${targetId}`, sheetId);
    await replyToUser(env, "✅ Spreadsheet disimpan.", targetId, isGroup, threadId, originalMessageId);
}

export async function handleReadSheet(env, targetId, text, isGroup, threadId, originalMessageId) {
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const sheetId = explicitSheetId || await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    const tabName = explicitSheetId ? (tokens.length > 1 ? tokens.slice(1).join(" ") : "") : tokens.join(" ");

    if (!sheetId) return await replyToUser(env, "⚠️ Belum ada sheet terdaftar.", targetId, isGroup, threadId, originalMessageId);
    const result = await silentReadSheetForAI(env, sheetId, tabName);
    await replyToUser(env, result || "Data kosong.", targetId, isGroup, threadId, originalMessageId);
}

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

async function triggerScreenshotWorkflow(env, spreadsheetId, targetId, isGroup, threadId, originalMessageId) {
    const repo = env.GITHUB_REPOSITORY || 'bp-pratama/seatalk_bot';
    const [owner, repoName] = repo.split('/');
    const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/screenshot.yml/dispatches`;
    
    const payload = {
        ref: 'main',
        inputs: {
            spreadsheet_id: spreadsheetId || '',
            target_id: targetId || '',
            is_group: isGroup ? '1' : '0',
            thread_id: threadId || '',
            original_message_id: originalMessageId || ''
        }
    };
    
    const token = env.GITHUB_TRIGGER_TOKEN;
    if (!token) {
        console.error('GITHUB_TRIGGER_TOKEN tidak tersedia');
        return null;
    }

    console.log(`DEBUG: Dispatching workflow with SPREADSHEET_ID=${spreadsheetId}`);
    
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `token ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'seatalk-bot'
        },
        body: JSON.stringify(payload)
    });
    
    const text = await res.text();
    console.log(`Workflow dispatch response: status=${res.status} body=${text.substring(0, 300)}`);
    
    if (res.status === 204) {
        console.log('Workflow dispatch accepted');
        return { success: true, spreadsheetId };
    }
    
    try {
        const data = JSON.parse(text);
        console.log('Workflow dispatch error:', data);
    } catch (e) {}
    
    return null;
}

export async function handleScreenshotCommand(env, targetId, text, isGroup, threadId, originalMessageId) {
    const args = text.replace(/^\S+\s*/, "").trim();
    const tokens = args.split(/\s+/).filter(Boolean);
    
    // Cari sheet ID dari URL atau dari memory
    const explicitSheetId = extractSpreadsheetId(args) || (tokens[0] && extractSpreadsheetId(tokens[0]));
    const sheetId = explicitSheetId || await env.BOT_MEMORY.get(`default_sheet_${targetId}`);
    
    if (!sheetId) return await replyToUser(env, "⚠️ Sheet tidak ditemukan.", targetId, isGroup, threadId, originalMessageId);
    
    const tokensForTabAndRange = explicitSheetId
        ? tokens.filter(token => !extractSpreadsheetId(token) && !/^url=/i.test(token))
        : tokens;
    const { tabName, customRange } = parseScreenshotArguments(tokensForTabAndRange);
    
    console.log(`Screenshot command: sheetId=${sheetId} tabName="${tabName}" customRange=${customRange}`);
    
    // Dispatch ke GitHub Actions workflow dengan SPREADSHEET_ID
    const workflowResult = await triggerScreenshotWorkflow(env, sheetId, targetId, isGroup, threadId, originalMessageId);
    
    if (workflowResult?.success) {
        await replyToUser(env, `✅ Permintaan screenshot dikirim untuk sheet "${tabName || 'default'}". Workflow sedang berjalan dan hasil akan dikirim ke SeaTalk.`, targetId, isGroup, threadId, originalMessageId);
    } else {
        await replyToUser(env, "❌ Gagal mengirim permintaan ke workflow. Coba lagi nanti.", targetId, isGroup, threadId, originalMessageId);
    }
}

export async function getHourlyReportData(env) {
    return "Data Laporan (Sistem sedang disinkronisasi)";
}

export async function handleInventoryQuery(env, targetId, text, isGroup, threadId, originalMessageId) {
    console.log("DEBUG: handleInventoryQuery dipanggil.");
    return null;
}
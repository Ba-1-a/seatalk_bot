/**
 * api/pdf-to-png.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Vercel lightweight proxy — forward PDF ke HF Spaces, return PNG
 *
 * ARSITEKTUR BARU (Microservices):
 * - Vercel: entry point ringan, hanya routing
 * - HF Spaces: heavy lifting (Puppeteer/Chromium/pdfjs-dist)
 * - HF Spaces bisa dipanggil oleh project Vercel LAIN juga (general purpose)
 *
 * Request:  POST JSON { pdf_base64: "<base64 encoded pdf>" }
 * Response: image/png (dari HF Spaces)
 *
 * Environment Variables:
 * - HF_SPACES_URL (optional, default: https://ba-1-a-b-cube-tech.hf.space)
 * - HF_API_KEY (required, untuk autentikasi ke HF Spaces)
 */

export const config = {
  runtime: 'nodejs',
  maxDuration: 60, // 60 detik timeout (cukup untuk HF Spaces processing)
};

// Timeout untuk request ke HF Spaces (45 detik - sisanya untuk overhead)
const HF_SPACES_TIMEOUT = 45000;
// Retry configuration (1 retry saja, tidak agresif)
const MAX_RETRIES = 1;
const RETRY_DELAY = 2000; // 2 detik delay sebelum retry

export default async function handler(req, res) {
  const startTime = Date.now();
  const reqId = crypto.randomUUID().slice(0, 8);
  
  if (req.method !== 'POST') {
    console.log(`[${new Date().toISOString()}] [DEBUG] [VERCEL] reqId=${reqId} → ${req.method} ${req.url} (405 Method Not Allowed)`);
    return res.status(405).json({ error: 'Use POST.' });
  }

  const HF_SPACES_URL = process.env.HF_SPACES_URL || 'https://ba-1-a-b-cube-tech.hf.space';
  const HF_API_KEY = process.env.HF_API_KEY;

  if (!HF_API_KEY) {
    console.error(`[${new Date().toISOString()}] [ERROR] [VERCEL] reqId=${reqId} HF_API_KEY not configured`);
    return res.status(500).json({ error: 'HF_API_KEY not configured' });
  }

  // Extract PDF base64 dari request
  const ct = req.headers['content-type'] || '';
  let pdfBase64 = null;

  if (ct.includes('json')) {
    const body = req.body || {};
    pdfBase64 = body.pdf_base64;
    if (!pdfBase64) return res.status(400).json({ error: 'pdf_base64 required' });
  } else {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    if (buf.length < 100) return res.status(400).json({ error: 'PDF too small' });
    pdfBase64 = buf.toString('base64');
  }

  console.log(`[${new Date().toISOString()}] [INFO] [VERCEL] reqId=${reqId} Forwarding PDF (${Math.round(pdfBase64.length * 0.75)} bytes) to HF Spaces`);

  try {
    // ================================================================
    // RETRY MECHANISM: Coba request ke HF Spaces dengan timeout + retry
    // ================================================================
    let lastError = null;
    let pngBuffer = null;
    // Deklarasi di scope luar agar bisa diakses setelah loop (fix: ReferenceError)
    let execTime, pdfSize, pngSize;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          console.log(`[${new Date().toISOString()}] [WARN] [VERCEL] reqId=${reqId} Retry attempt ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY}ms delay`);
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
        
        // Buat AbortController untuk timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), HF_SPACES_TIMEOUT);
        
        console.log(`[${new Date().toISOString()}] [INFO] [VERCEL] reqId=${reqId} Attempt ${attempt + 1}: Sending PDF to HF Spaces...`);
        const response = await fetch(`${HF_SPACES_URL}/screenshot`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${HF_API_KEY}`
          },
          body: JSON.stringify({ pdf_base64: pdfBase64 }),
          signal: controller.signal
        });
        
        // Clear timeout jika request berhasil
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          const errorBody = await response.text();
          console.error(`[${new Date().toISOString()}] [ERROR] [VERCEL] reqId=${reqId} HF Spaces error (attempt ${attempt + 1}):`, response.status, errorBody.substring(0, 300));
          
          // Jika error 5xx, coba retry. Jika 4xx, langsung return error
          if (response.status >= 500 && attempt < MAX_RETRIES) {
            lastError = new Error(`HF Spaces error: ${response.status} - ${errorBody.substring(0, 200)}`);
            continue;
          }
          
          return res.status(response.status).json({
            error: `HF Spaces error: ${response.status}`,
            detail: errorBody.substring(0, 500)
          });
        }

        pngBuffer = await response.arrayBuffer();
        console.log(`[${new Date().toISOString()}] [INFO] [VERCEL] reqId=${reqId} PNG received from HF Spaces (attempt ${attempt + 1}): ${pngBuffer.byteLength} bytes`);
        
        // Forward headers dari HF Spaces (assign, bukan const - fix: ReferenceError)
        execTime = response.headers.get('X-Execution-Time');
        pdfSize = response.headers.get('X-PDF-Size');
        pngSize = response.headers.get('X-PNG-Size');
        
        // Success! Break dari retry loop
        break;
        
      } catch (err) {
        lastError = err;
        console.error(`[${new Date().toISOString()}] [ERROR] [VERCEL] reqId=${reqId} Attempt ${attempt + 1} failed: ${err.message}`);
        
        // Jika ini attempt terakhir, throw error
        if (attempt >= MAX_RETRIES) {
          break;
        }
        
        // Jika timeout atau network error, coba retry
        if (err.name === 'AbortError' || err.message.includes('fetch') || err.message.includes('timeout')) {
          continue;
        }
        
        // Error lain, langsung throw
        throw err;
      }
    }
    
    // Jika semua attempt gagal
    if (!pngBuffer) {
      console.error(`[${new Date().toISOString()}] [ERROR] [VERCEL] reqId=${reqId} All attempts failed`);
      throw lastError || new Error('Failed to get PNG from HF Spaces after retries');
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', pngBuffer.byteLength);
    if (execTime) res.setHeader('X-Execution-Time', execTime);
    if (pdfSize) res.setHeader('X-PDF-Size', pdfSize);
    if (pngSize) res.setHeader('X-PNG-Size', pngSize);

    const totalDuration = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] [INFO] [VERCEL] reqId=${reqId} PNG forwarded to client (${pngBuffer.byteLength} bytes) in ${totalDuration}ms`);
    
    return res.status(200).send(Buffer.from(pngBuffer));

  } catch (err) {
    const totalDuration = Date.now() - startTime;
    console.error(`[${new Date().toISOString()}] [ERROR] [VERCEL] reqId=${reqId} HF Spaces proxy error after ${totalDuration}ms:`, err);
    
    // Tentukan error message yang user-friendly
    let errorMessage = 'Failed to connect to HF Spaces';
    if (err.name === 'AbortError') {
      errorMessage = 'HF Spaces processing timeout (>45s)';
    } else if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) {
      errorMessage = 'HF Spaces service unavailable';
    }
    
    return res.status(502).json({
      error: errorMessage,
      detail: err.message,
      hint: 'Check HF Spaces status at https://ba-1-a-b-cube-tech.hf.space'
    });
  }
}
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
  runtime: 'nodejs'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  const HF_SPACES_URL = process.env.HF_SPACES_URL || 'https://ba-1-a-b-cube-tech.hf.space';
  const HF_API_KEY = process.env.HF_API_KEY;

  if (!HF_API_KEY) {
    console.error('HF_API_KEY not configured');
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

  console.log(`Forwarding PDF (${Math.round(pdfBase64.length * 0.75)} bytes) to HF Spaces`);

  try {
    const response = await fetch(`${HF_SPACES_URL}/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${HF_API_KEY}`
      },
      body: JSON.stringify({ pdf_base64: pdfBase64 })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('HF Spaces error:', response.status, errorBody.substring(0, 300));
      return res.status(response.status).json({
        error: `HF Spaces error: ${response.status}`,
        detail: errorBody.substring(0, 500)
      });
    }

    const pngBuffer = await response.arrayBuffer();
    console.log(`PNG received from HF Spaces: ${pngBuffer.byteLength} bytes`);

    // Forward headers dari HF Spaces
    const execTime = response.headers.get('X-Execution-Time');
    const pdfSize = response.headers.get('X-PDF-Size');
    const pngSize = response.headers.get('X-PNG-Size');

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Length', pngBuffer.byteLength);
    if (execTime) res.setHeader('X-Execution-Time', execTime);
    if (pdfSize) res.setHeader('X-PDF-Size', pdfSize);
    if (pngSize) res.setHeader('X-PNG-Size', pngSize);

    return res.status(200).send(Buffer.from(pngBuffer));

  } catch (err) {
    console.error('HF Spaces proxy error:', err);
    return res.status(502).json({
      error: 'Failed to connect to HF Spaces',
      detail: err.message
    });
  }
}
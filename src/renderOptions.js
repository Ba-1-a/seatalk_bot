/**
 * src/renderOptions.js
 * VASA - Virtual Assistant SOC Arjawinangun
 * Maximum quality render options untuk screenshot spreadsheet
 * 
 * TIDAK ADA ADAPTIVE PAPER SIZE - selalu maximum quality:
 * - Scale 2.5x untuk sharp text
 * - Device scale factor 2.5x untuk retina-ready
 * - Max pages 5 untuk cover sheet besar
 * - Render delay 1 detik untuk Chrome stabil
 * 
 * PDF Size tiers (untuk timeout management):
 * - <1.5MB: full quality, timeout 90s
 * - 1.5-3.5MB: full quality, timeout 90s
 * - 3.5-10MB: maximum quality dengan timeout aman 85s
 * - >10MB: FORCE SPLIT (throw error untuk auto-split)
 */

export class SplitRequiredError extends Error {
  constructor(pdfSizeBytes, message) {
    super(message || `PDF terlalu besar (${(pdfSizeBytes / 1024 / 1024).toFixed(1)}MB). Harus di-split.`);
    this.name = 'SplitRequiredError';
    this.pdfSizeBytes = pdfSizeBytes;
  }
}

export function resolveRenderOptions(pdfSizeBytes, overrides = {}) {
  const normalizedSize = Number.isFinite(pdfSizeBytes) ? Math.max(0, pdfSizeBytes) : 0;

  // >10MB: Force split - tidak boleh render single
  if (normalizedSize > 10_000_000) {
    throw new SplitRequiredError(normalizedSize, 
      `PDF terlalu besar (${(normalizedSize / 1024 / 1024).toFixed(1)}MB). ` +
      `Gunakan range yang lebih kecil (misal: /screenshot range=A1:D250)`
    );
  }

  // 3.5-10MB: Maximum quality dengan timeout agak lebih kecil untuk safety margin
  if (normalizedSize > 3_500_000) {
    return {
      mode: 'maximum_quality',
      scale: 2.5,
      maxPages: 5,
      renderDelayMs: 1000,
      timeoutMs: 85000, // Safety margin dari Vercel 90s
      deviceScaleFactor: 2.5,
      ...overrides
    };
  }

  // <3.5MB: Maximum quality dengan timeout penuh
  return {
    mode: 'maximum_quality',
    scale: 2.5,
    maxPages: 5,
    renderDelayMs: 1000,
    timeoutMs: 90000, // Maksimal Vercel
    deviceScaleFactor: 2.5,
    ...overrides
  };
}

export function resolveRenderOptions(pdfSizeBytes, overrides = {}) {
  const normalizedSize = Number.isFinite(pdfSizeBytes) ? Math.max(0, pdfSizeBytes) : 0;

  if (normalizedSize >= 2_500_000) {
    // Large PDF: aggressive optimization to prevent timeout
    return {
      mode: 'compact',
      scale: 1.4,
      maxPages: 1,
      renderDelayMs: 400,
      timeoutMs: 40000, // Reduced from 45s to stay well within Vercel 90s limit
      deviceScaleFactor: 1.25,
      ...overrides
    };
  }

  if (normalizedSize >= 1_500_000) {
    // Medium-large PDF: balanced with conservative timeout
    return {
      mode: 'balanced',
      scale: 1.7,
      maxPages: 2,
      renderDelayMs: 500,
      timeoutMs: 45000, // Reduced from 50s
      deviceScaleFactor: 1.4,
      ...overrides
    };
  }

  if (normalizedSize >= 1_000_000) {
    // Medium PDF: slightly optimized
    return {
      mode: 'default',
      scale: 2.0,
      maxPages: 2,
      renderDelayMs: 600,
      timeoutMs: 50000, // Reduced from 60s
      deviceScaleFactor: 1.6,
      ...overrides
    };
  }

  // Small PDF: default settings with safe timeout
  return {
    mode: 'default',
    scale: 2.2,
    maxPages: 3,
    renderDelayMs: 700,
    timeoutMs: 55000, // Reduced from 60s for safety margin
    deviceScaleFactor: 2,
    ...overrides
  };
}

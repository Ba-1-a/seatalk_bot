export function resolveRenderOptions(pdfSizeBytes, overrides = {}) {
  const normalizedSize = Number.isFinite(pdfSizeBytes) ? Math.max(0, pdfSizeBytes) : 0;

  if (normalizedSize >= 2_500_000) {
    return {
      mode: 'compact',
      scale: 1.4,
      maxPages: 1,
      renderDelayMs: 400,
      timeoutMs: 45000,
      deviceScaleFactor: 1.25,
      ...overrides
    };
  }

  if (normalizedSize >= 1_000_000) {
    return {
      mode: 'balanced',
      scale: 1.8,
      maxPages: 2,
      renderDelayMs: 600,
      timeoutMs: 50000,
      deviceScaleFactor: 1.5,
      ...overrides
    };
  }

  return {
    mode: 'default',
    scale: 2.2,
    maxPages: 3,
    renderDelayMs: 800,
    timeoutMs: 60000,
    deviceScaleFactor: 2,
    ...overrides
  };
}

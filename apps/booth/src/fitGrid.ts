/**
 * Largest frame preview that fits `n` cards in a W×H box without overlap.
 * `chromeW`/`chromeH` = card space that is not the frame (padding, border, name, chip).
 * Below `minH` the grid scrolls instead of shrinking further.
 */
export function fitGrid(n: number, W: number, H: number, ratio: number, gap: number, chromeW: number, chromeH: number, minH: number) {
  let best = { cols: 1, frameH: 0, scroll: false };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const cellW = (W - (cols - 1) * gap) / cols;
    const cellH = (H - (rows - 1) * gap) / rows;
    const frameH = Math.min(cellH - chromeH, (cellW - chromeW) / ratio);
    if (frameH > best.frameH) best = { cols, frameH, scroll: false };
  }
  if (best.frameH >= minH) return { ...best, frameH: Math.floor(best.frameH) };
  // Too many to fit: fixed min size, as many columns as fit, vertical scroll.
  const cols = Math.max(1, Math.floor((W + gap) / (minH * ratio + chromeW + gap)));
  return { cols, frameH: minH, scroll: true };
}

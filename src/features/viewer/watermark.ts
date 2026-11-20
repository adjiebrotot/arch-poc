export const WATERMARK_TEXT = 'DRAFT — NOT FOR CONSTRUCTION';

/** Draw the repeated diagonal watermark onto a 2D canvas context (used on screen and in exports). */
export function drawWatermark(ctx: CanvasRenderingContext2D, w: number, h: number, scale = 1) {
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = '#A3342B';
  ctx.font = `700 ${Math.round(34 * scale)}px Inter Variable, Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const stepX = 620 * scale, stepY = 230 * scale;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 7);
  const R = Math.hypot(w, h);
  let row = 0;
  for (let y = -R; y < R; y += stepY, row++) {
    for (let x = -R + (row % 2) * (stepX / 2); x < R; x += stepX) ctx.fillText(WATERMARK_TEXT, x, y);
  }
  ctx.restore();
}

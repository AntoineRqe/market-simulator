// ============================================================================
// Chart rendering for price visualization
// ============================================================================

import { ge } from './utils.js';
import type { ChartPoint } from './types.js';

// Chart styling constants
const CHART_COLORS = {
  bg: '#0a0c10',
  grid: '#1e2330',
  label: '#5a6070',
  line: '#00e676',
  fill: 'rgba(0,230,118,.18)',
  fillEnd: 'rgba(0,230,118,0)',
  lastPrice: '#ffd740',
  text: '#0d0f14',
};

const CHART_PADDING = {
  left: 52,
  right: 8,
  top: 14,
  bottom: 28,
};

const CHART_FONT = {
  small: '8px Courier New',
  normal: '9px Courier New',
  bold: 'bold 9px Courier New',
  title: '10px Courier New',
};

/**
 * Draw price chart on canvas
 */
export function drawChart(chartPoints: ChartPoint[]): void {
  const wrap = ge('chart-wrap');
  const canvas = ge('price-canvas') as HTMLCanvasElement;

  if (!wrap || !canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth || 240;
  const H = wrap.clientHeight || 300;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.scale(dpr, dpr);

  // Clear background
  ctx.fillStyle = CHART_COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Show placeholder if not enough data
  if (chartPoints.length < 2) {
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = CHART_FONT.title;
    ctx.textAlign = 'center';
    ctx.fillText('waiting for trades…', W / 2, H / 2);
    return;
  }

  // Calculate dimensions and price scale
  const { left: PAD_L, right: PAD_R, top: PAD_T, bottom: PAD_B } = CHART_PADDING;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T - PAD_B;

  const prices = chartPoints.map((p) => p.price);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);

  // Ensure min and max are different
  if (maxP === minP) {
    minP -= 0.5;
    maxP += 0.5;
  }

  // Add 10% padding on top and bottom
  const lo = minP - (maxP - minP) * 0.1;
  const hi = maxP + (maxP - minP) * 0.1;

  // Helper functions for coordinate conversion
  const xOf = (i: number) => PAD_L + (i / (chartPoints.length - 1)) * cW;
  const yOf = (p: number) => PAD_T + (1 - (p - lo) / (hi - lo)) * cH;

  // Draw grid lines with price labels
  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const p = lo + (hi - lo) * (i / 4);
    const y = yOf(p);
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W - PAD_R, y);
    ctx.stroke();

    // Price label
    ctx.fillStyle = CHART_COLORS.label;
    ctx.font = CHART_FONT.normal;
    ctx.textAlign = 'right';
    ctx.fillText(p.toFixed(2), PAD_L - 4, y + 3);
  }

  // Draw gradient area under the line
  const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + cH);
  grad.addColorStop(0, CHART_COLORS.fill);
  grad.addColorStop(1, CHART_COLORS.fillEnd);

  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(chartPoints[0].price));
  chartPoints.forEach((pt, i) => {
    if (i > 0) ctx.lineTo(xOf(i), yOf(pt.price));
  });
  ctx.lineTo(xOf(chartPoints.length - 1), PAD_T + cH);
  ctx.lineTo(xOf(0), PAD_T + cH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw price line
  ctx.beginPath();
  ctx.strokeStyle = CHART_COLORS.line;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  chartPoints.forEach((pt, i) => {
    if (i === 0) {
      ctx.moveTo(xOf(i), yOf(pt.price));
    } else {
      ctx.lineTo(xOf(i), yOf(pt.price));
    }
  });
  ctx.stroke();

  // Draw dots at each point
  chartPoints.forEach((pt, i) => {
    ctx.beginPath();
    ctx.arc(xOf(i), yOf(pt.price), 3, 0, Math.PI * 2);
    ctx.fillStyle = CHART_COLORS.line;
    ctx.fill();
  });

  // Draw last price dashed line and label
  const last = chartPoints[chartPoints.length - 1];
  const ly = yOf(last.price);

  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = CHART_COLORS.lastPrice;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD_L, ly);
  ctx.lineTo(W - PAD_R, ly);
  ctx.stroke();
  ctx.setLineDash([]);

  // Last price label box
  const lbl = last.price.toFixed(4);
  ctx.font = CHART_FONT.bold;
  const tw = ctx.measureText(lbl).width + 8;
  ctx.fillStyle = CHART_COLORS.lastPrice;
  ctx.fillRect(PAD_L - tw - 2, ly - 7, tw, 14);
  ctx.fillStyle = CHART_COLORS.text;
  ctx.textAlign = 'right';
  ctx.fillText(lbl, PAD_L - 5, ly + 4);

  // X-axis timestamps
  ctx.fillStyle = CHART_COLORS.label;
  ctx.font = CHART_FONT.small;
  ctx.textAlign = 'center';

  const timestampPoints: [number, number][] = [
    [0, PAD_L],
    [Math.floor((chartPoints.length - 1) / 2), W / 2],
    [chartPoints.length - 1, W - PAD_R],
  ];

  timestampPoints.forEach(([idx, x]) => {
    const pt = chartPoints[idx];
    if (pt) {
      const timeStr = formatTimestamp(pt.timestamp);
      ctx.fillText(timeStr, x, H - 8);
    }
  });
}

/**
 * Format timestamp for chart display
 */
function formatTimestamp(timestamp: number): string {
  if (typeof timestamp === 'number') {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
  }
  return '';
}

/**
 * Clear the chart
 */
export function clearChart(): void {
  const canvas = ge('price-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = CHART_COLORS.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

/**
 * Get chart canvas element
 */
export function getChartCanvas(): HTMLCanvasElement | null {
  return ge('price-canvas') as HTMLCanvasElement | null;
}

/**
 * Check if chart is visible
 */
export function isChartVisible(): boolean {
  const wrap = ge('chart-wrap');
  return wrap ? wrap.offsetHeight > 0 : false;
}

/**
 * Redraw chart when window resizes
 */
export function handleChartResize(chartPoints: ChartPoint[]): void {
  drawChart(chartPoints);
}

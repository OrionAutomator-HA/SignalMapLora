export type OverlayColor = 'red' | 'green' | 'blue'
export type OverlayStyle = OverlayColor | 'heatmap'

const SOLID: Record<OverlayColor, [number, number, number]> = {
  red: [220, 56, 48],
  green: [46, 196, 122],
  blue: [40, 118, 224],
}

export const HEATMAP_SPAN_DB = 40

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Weak (blue) → strong (red). t is 0..1. */
export function heatmapRgb(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t))
  if (x < 0.25) {
    const u = x / 0.25
    return [lerp(32, 0, u), lerp(48, 180, u), lerp(180, 220, u)]
  }
  if (x < 0.5) {
    const u = (x - 0.25) / 0.25
    return [lerp(0, 40, u), lerp(180, 200, u), lerp(220, 70, u)]
  }
  if (x < 0.75) {
    const u = (x - 0.5) / 0.25
    return [lerp(40, 250, u), lerp(200, 210, u), lerp(70, 40, u)]
  }
  const u = (x - 0.75) / 0.25
  return [lerp(250, 230, u), lerp(210, 40, u), lerp(40, 30, u)]
}

export function maskToDataUrl(
  mask: Uint8Array,
  cols: number,
  rows: number,
  color: OverlayColor = 'green',
): string {
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(cols, rows)
  const [r, g, b] = SOLID[color]
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (mask[i]) {
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = b
      img.data[o + 3] = 150
    } else {
      img.data[o + 3] = 0
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

export function rssiHeatmapToDataUrl(
  rssi: Float32Array,
  cols: number,
  rows: number,
  cutoffDbm: number,
  spanDb = HEATMAP_SPAN_DB,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(cols, rows)
  const span = Math.max(8, spanDb)
  for (let i = 0; i < rssi.length; i++) {
    const o = i * 4
    const v = rssi[i]
    if (!Number.isFinite(v)) {
      img.data[o + 3] = 0
      continue
    }
    const t = Math.min(1, Math.max(0, (v - cutoffDbm) / span))
    const [r, g, b] = heatmapRgb(t)
    img.data[o] = r
    img.data[o + 1] = g
    img.data[o + 2] = b
    img.data[o + 3] = 90 + Math.round(t * 80)
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

export function paintCoverageOverlay(
  mask: Uint8Array,
  cols: number,
  rows: number,
  style: OverlayStyle,
  rssi: Float32Array | null,
  cutoffDbm: number,
): string {
  if (style === 'heatmap' && rssi) {
    return rssiHeatmapToDataUrl(rssi, cols, rows, cutoffDbm)
  }
  const color: OverlayColor = style === 'heatmap' ? 'green' : style
  return maskToDataUrl(mask, cols, rows, color)
}

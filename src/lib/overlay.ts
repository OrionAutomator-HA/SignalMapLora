export function maskToDataUrl(
  mask: Uint8Array,
  cols: number,
  rows: number,
): string {
  const canvas = document.createElement('canvas')
  canvas.width = cols
  canvas.height = rows
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const img = ctx.createImageData(cols, rows)
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (mask[i]) {
      img.data[o] = 46
      img.data[o + 1] = 196
      img.data[o + 2] = 122
      img.data[o + 3] = 150
    } else {
      img.data[o + 3] = 0
    }
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toDataURL('image/png')
}

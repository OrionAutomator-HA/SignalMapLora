import type { BBox, DemGrid } from '../types'
import { clamp } from './geo'

function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lon + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )
  return { x: clamp(x, 0, n - 1), y: clamp(y, 0, n - 1) }
}

function lonLatToPixel(
  lon: number,
  lat: number,
  z: number,
): { x: number; y: number } {
  const n = 2 ** z
  const x = ((lon + 180) / 360) * n * 256
  const latRad = (lat * Math.PI) / 180
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n * 256
  return { x, y }
}

function terrariumMeters(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

function tileCount(bbox: BBox, z: number): number {
  const nw = lonLatToTile(bbox.west, bbox.north, z)
  const se = lonLatToTile(bbox.east, bbox.south, z)
  return (se.x - nw.x + 1) * (se.y - nw.y + 1)
}

function pickZoom(bbox: BBox): number {
  for (let z = 12; z >= 6; z--) {
    if (tileCount(bbox, z) <= 25) return z
  }
  return 6
}

async function fetchTile(
  z: number,
  x: number,
  y: number,
): Promise<ImageBitmap> {
  const res = await fetch(`/dem/${z}/${x}/${y}.png`)
  if (!res.ok) {
    throw new Error(`Terrain tile ${z}/${x}/${y} failed (${res.status})`)
  }
  const blob = await res.blob()
  return createImageBitmap(blob)
}

export async function loadDemGrid(
  bbox: BBox,
  cols: number,
  rows: number,
  onProgress?: (message: string, fraction: number) => void,
): Promise<DemGrid> {
  try {
    return await loadDemFromTiles(bbox, cols, rows, onProgress)
  } catch {
    onProgress?.('Terrain tiles unavailable, using Open-Meteo elevation…', 0.05)
    return loadDemFromOpenMeteo(bbox, cols, rows, onProgress)
  }
}

async function loadDemFromTiles(
  bbox: BBox,
  cols: number,
  rows: number,
  onProgress?: (message: string, fraction: number) => void,
): Promise<DemGrid> {
  const z = pickZoom(bbox)
  const nw = lonLatToTile(bbox.west, bbox.north, z)
  const se = lonLatToTile(bbox.east, bbox.south, z)
  const minX = nw.x
  const maxX = se.x
  const minY = nw.y
  const maxY = se.y
  const tilesX = maxX - minX + 1
  const tilesY = maxY - minY + 1
  const mosaic = document.createElement('canvas')
  mosaic.width = tilesX * 256
  mosaic.height = tilesY * 256
  const ctx = mosaic.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Could not create terrain canvas')

  let loaded = 0
  const totalTiles = tilesX * tilesY
  const jobs: Promise<void>[] = []
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      jobs.push(
        fetchTile(z, tx, ty).then((bmp) => {
          ctx.drawImage(bmp, (tx - minX) * 256, (ty - minY) * 256)
          bmp.close()
          loaded++
          onProgress?.(
            `Loading terrain tiles (${loaded}/${totalTiles})`,
            (loaded / totalTiles) * 0.35,
          )
        }),
      )
    }
  }
  await Promise.all(jobs)

  const pixels = ctx.getImageData(0, 0, mosaic.width, mosaic.height).data
  const elev = new Float32Array(cols * rows)
  const originX = minX * 256
  const originY = minY * 256

  for (let row = 0; row < rows; row++) {
    const lat = bbox.north - ((row + 0.5) / rows) * (bbox.north - bbox.south)
    for (let col = 0; col < cols; col++) {
      const lon = bbox.west + ((col + 0.5) / cols) * (bbox.east - bbox.west)
      const p = lonLatToPixel(lon, lat, z)
      const px = clamp(p.x - originX, 0, mosaic.width - 1)
      const py = clamp(p.y - originY, 0, mosaic.height - 1)
      const x0 = Math.floor(px)
      const y0 = Math.floor(py)
      const x1 = Math.min(mosaic.width - 1, x0 + 1)
      const y1 = Math.min(mosaic.height - 1, y0 + 1)
      const fx = px - x0
      const fy = py - y0
      const sample = (x: number, y: number) => {
        const i = (y * mosaic.width + x) * 4
        return terrariumMeters(pixels[i], pixels[i + 1], pixels[i + 2])
      }
      elev[row * cols + col] =
        sample(x0, y0) * (1 - fx) * (1 - fy) +
        sample(x1, y0) * fx * (1 - fy) +
        sample(x0, y1) * (1 - fx) * fy +
        sample(x1, y1) * fx * fy
    }
  }

  return {
    elev,
    cols,
    rows,
    west: bbox.west,
    south: bbox.south,
    east: bbox.east,
    north: bbox.north,
  }
}

async function loadDemFromOpenMeteo(
  bbox: BBox,
  cols: number,
  rows: number,
  onProgress?: (message: string, fraction: number) => void,
): Promise<DemGrid> {
  const lats: number[] = []
  const lons: number[] = []
  for (let row = 0; row < rows; row++) {
    const lat = bbox.north - ((row + 0.5) / rows) * (bbox.north - bbox.south)
    for (let col = 0; col < cols; col++) {
      const lon = bbox.west + ((col + 0.5) / cols) * (bbox.east - bbox.west)
      lats.push(lat)
      lons.push(lon)
    }
  }

  const elev = new Float32Array(cols * rows)
  const batchSize = 100
  let done = 0
  for (let i = 0; i < lats.length; i += batchSize) {
    const slat = lats.slice(i, i + batchSize)
    const slon = lons.slice(i, i + batchSize)
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${slat.join(',')}&longitude=${slon.join(',')}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Elevation API failed (${res.status})`)
    const json = (await res.json()) as { elevation?: number[]; reason?: string }
    if (!json.elevation) throw new Error(json.reason ?? 'Elevation API returned no data')
    for (let j = 0; j < json.elevation.length; j++) {
      elev[i + j] = json.elevation[j]
    }
    done += slat.length
    onProgress?.(
      `Loading elevation (${done}/${lats.length})`,
      0.05 + (done / lats.length) * 0.3,
    )
  }

  return {
    elev,
    cols,
    rows,
    west: bbox.west,
    south: bbox.south,
    east: bbox.east,
    north: bbox.north,
  }
}

export function downsampleGrid(grid: DemGrid, cols: number, rows: number): DemGrid {
  const elev = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const srcC = ((col + 0.5) / cols) * grid.cols - 0.5
      const srcR = ((row + 0.5) / rows) * grid.rows - 0.5
      const c0 = Math.min(grid.cols - 1, Math.max(0, Math.floor(srcC)))
      const r0 = Math.min(grid.rows - 1, Math.max(0, Math.floor(srcR)))
      const c1 = Math.min(grid.cols - 1, c0 + 1)
      const r1 = Math.min(grid.rows - 1, r0 + 1)
      const fc = Math.min(1, Math.max(0, srcC - c0))
      const fr = Math.min(1, Math.max(0, srcR - r0))
      const e00 = grid.elev[r0 * grid.cols + c0]
      const e10 = grid.elev[r0 * grid.cols + c1]
      const e01 = grid.elev[r1 * grid.cols + c0]
      const e11 = grid.elev[r1 * grid.cols + c1]
      elev[row * cols + col] =
        e00 * (1 - fc) * (1 - fr) +
        e10 * fc * (1 - fr) +
        e01 * (1 - fc) * fr +
        e11 * fc * fr
    }
  }
  return {
    ...grid,
    cols,
    rows,
    elev,
  }
}

import type { BBox, DemGrid } from '../types'

export const EARTH_RADIUS_M = 6_371_000
export const MAX_REGION_KM = 1200
export const WARN_REGION_KM = 200
export const MAX_COVERAGE_PAD_KM = 50
/** Mesh import union-coverage window, including radio-range padding. */
export const MAX_MESH_SPAN_KM = 1200

export function gridMaxSide(maxSideKm: number, kind: 'fine' | 'coarse'): number {
  if (kind === 'coarse') {
    if (maxSideKm > 500) return 48
    if (maxSideKm > 200) return 64
    if (maxSideKm > 90) return 80
    return 96
  }
  if (maxSideKm > 500) return 64
  if (maxSideKm > 200) return 80
  if (maxSideKm > 90) return 96
  return 160
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

export function latDegToM(dLat: number): number {
  return dLat * 110_574
}

export function lonDegToM(dLon: number, lat: number): number {
  return dLon * 111_320 * Math.cos((lat * Math.PI) / 180)
}

export function bboxCenter(bbox: BBox): { lat: number; lon: number } {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2,
  }
}

export function bboxSizeKm(bbox: BBox): {
  widthKm: number
  heightKm: number
  maxSideKm: number
} {
  const { lat } = bboxCenter(bbox)
  const widthKm = Math.abs(lonDegToM(bbox.east - bbox.west, lat)) / 1000
  const heightKm = Math.abs(latDegToM(bbox.north - bbox.south)) / 1000
  return { widthKm, heightKm, maxSideKm: Math.max(widthKm, heightKm) }
}

export function cellMeters(grid: DemGrid): { mPerCol: number; mPerRow: number } {
  const { lat } = bboxCenter({
    west: grid.west,
    south: grid.south,
    east: grid.east,
    north: grid.north,
  })
  const mPerCol = lonDegToM((grid.east - grid.west) / grid.cols, lat)
  const mPerRow = latDegToM((grid.north - grid.south) / grid.rows)
  return { mPerCol, mPerRow }
}

export function cellAreaKm2(grid: DemGrid): number {
  const { mPerCol, mPerRow } = cellMeters(grid)
  return (Math.abs(mPerCol) * Math.abs(mPerRow)) / 1_000_000
}

export function colRowToLatLon(
  grid: Pick<DemGrid, 'cols' | 'rows' | 'west' | 'south' | 'east' | 'north'>,
  col: number,
  row: number,
): { lat: number; lon: number } {
  const lon = grid.west + ((col + 0.5) / grid.cols) * (grid.east - grid.west)
  const lat = grid.north - ((row + 0.5) / grid.rows) * (grid.north - grid.south)
  return { lat, lon }
}

export function latLonToColRowFloat(
  grid: Pick<DemGrid, 'cols' | 'rows' | 'west' | 'south' | 'east' | 'north'>,
  lat: number,
  lon: number,
): { col: number; row: number } {
  const col = ((lon - grid.west) / (grid.east - grid.west)) * grid.cols - 0.5
  const row = ((grid.north - lat) / (grid.north - grid.south)) * grid.rows - 0.5
  return { col, row }
}

export function latLonToColRow(
  grid: Pick<DemGrid, 'cols' | 'rows' | 'west' | 'south' | 'east' | 'north'>,
  lat: number,
  lon: number,
): { col: number; row: number } {
  const col = clamp(
    Math.floor(((lon - grid.west) / (grid.east - grid.west)) * grid.cols),
    0,
    grid.cols - 1,
  )
  const row = clamp(
    Math.floor(((grid.north - lat) / (grid.north - grid.south)) * grid.rows),
    0,
    grid.rows - 1,
  )
  return { col, row }
}

export function bboxCellRange(
  grid: Pick<DemGrid, 'cols' | 'rows' | 'west' | 'south' | 'east' | 'north'>,
  bbox: BBox,
): { col0: number; col1: number; row0: number; row1: number } {
  const corners = [
    latLonToColRow(grid, bbox.south, bbox.west),
    latLonToColRow(grid, bbox.south, bbox.east),
    latLonToColRow(grid, bbox.north, bbox.west),
    latLonToColRow(grid, bbox.north, bbox.east),
  ]
  return {
    col0: Math.min(...corners.map((p) => p.col)),
    col1: Math.max(...corners.map((p) => p.col)),
    row0: Math.min(...corners.map((p) => p.row)),
    row1: Math.max(...corners.map((p) => p.row)),
  }
}

export function pointInBBox(lat: number, lon: number, bbox: BBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north
}

export function bboxAroundPoint(lat: number, lon: number, radiusKm: number): BBox {
  return expandBbox({ west: lon, east: lon, south: lat, north: lat }, radiusKm)
}

export function bboxFromPoints(
  points: { lat: number; lon: number }[],
  padKm: number,
): BBox {
  let west = 180
  let east = -180
  let south = 90
  let north = -90
  for (const p of points) {
    west = Math.min(west, p.lon)
    east = Math.max(east, p.lon)
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  return expandBbox({ west, south, east, north }, padKm)
}

export function expandBbox(bbox: BBox, padKm: number): BBox {
  const { lat } = bboxCenter(bbox)
  const dLat = padKm / 110.574
  const denom = 111.32 * Math.cos((lat * Math.PI) / 180)
  const dLon = padKm / Math.max(denom, 1e-6)
  return {
    west: bbox.west - dLon,
    south: clamp(bbox.south - dLat, -85, 85),
    east: bbox.east + dLon,
    north: clamp(bbox.north + dLat, -85, 85),
  }
}

export function chooseGridShape(
  bbox: BBox,
  maxSide: number,
): { cols: number; rows: number } {
  const { widthKm, heightKm } = bboxSizeKm(bbox)
  if (widthKm >= heightKm) {
    const cols = maxSide
    const rows = Math.max(8, Math.round((maxSide * heightKm) / widthKm))
    return { cols, rows }
  }
  const rows = maxSide
  const cols = Math.max(8, Math.round((maxSide * widthKm) / heightKm))
  return { cols, rows }
}

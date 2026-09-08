import type { BBox, DemGrid, RadioParams, RankedSite } from '../types'
import { bboxCellRange, colRowToLatLon } from './geo'
import { scoreCoverage } from './coverage'

type Peak = { col: number; row: number; elev: number }

function isLocalMax(
  grid: DemGrid,
  col: number,
  row: number,
  radius: number,
  col0: number,
  col1: number,
  row0: number,
  row1: number,
): boolean {
  const e = grid.elev[row * grid.cols + col]
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dc === 0 && dr === 0) continue
      const c = col + dc
      const r = row + dr
      if (c < col0 || r < row0 || c > col1 || r > row1) continue
      if (grid.elev[r * grid.cols + c] > e) return false
    }
  }
  return true
}

function thinPeaks(peaks: Peak[], minSep: number, limit: number): Peak[] {
  const chosen: Peak[] = []
  const sep2 = minSep * minSep
  for (const p of peaks) {
    if (chosen.some((q) => (q.col - p.col) ** 2 + (q.row - p.row) ** 2 < sep2)) {
      continue
    }
    chosen.push(p)
    if (chosen.length >= limit) break
  }
  return chosen
}

function searchExtent(
  grid: DemGrid,
  searchBbox?: BBox,
): { col0: number; col1: number; row0: number; row1: number } {
  if (!searchBbox) {
    return {
      col0: 0,
      col1: grid.cols - 1,
      row0: 0,
      row1: grid.rows - 1,
    }
  }
  return bboxCellRange(grid, searchBbox)
}

export function collectCandidates(
  grid: DemGrid,
  maxCount: number,
  searchBbox?: BBox,
): Peak[] {
  const { col0, col1, row0, row1 } = searchExtent(grid, searchBbox)
  const inside: Peak[] = []
  let elevMin = Infinity
  let elevMax = -Infinity

  for (let r = row0; r <= row1; r++) {
    for (let c = col0; c <= col1; c++) {
      const elev = grid.elev[r * grid.cols + c]
      inside.push({ col: c, row: r, elev })
      elevMin = Math.min(elevMin, elev)
      elevMax = Math.max(elevMax, elev)
    }
  }

  if (inside.length === 0) return []

  const hiCut = elevMin + 0.55 * (elevMax - elevMin || 1)
  const local: Peak[] = []
  const high: Peak[] = []
  for (const cell of inside) {
    if (isLocalMax(grid, cell.col, cell.row, 1, col0, col1, row0, row1)) {
      local.push(cell)
    } else if (cell.elev >= hiCut) {
      high.push(cell)
    }
  }

  local.sort((a, b) => b.elev - a.elev)
  high.sort((a, b) => b.elev - a.elev)
  inside.sort((a, b) => b.elev - a.elev)

  const span = Math.max(col1 - col0 + 1, row1 - row0 + 1)
  const minSep = Math.max(1, Math.round(span / 10))
  const picked = thinPeaks([...local, ...high, ...inside], minSep, maxCount)
  return picked.length > 0 ? picked : inside.slice(0, Math.min(maxCount, inside.length))
}

function toSite(
  grid: DemGrid,
  peak: Peak,
  score: ReturnType<typeof scoreCoverage>,
  rank: number,
): RankedSite {
  const { lat, lon } = colRowToLatLon(grid, peak.col, peak.row)
  return {
    rank,
    lat,
    lon,
    col: peak.col,
    row: peak.row,
    elevM: peak.elev,
    coveredKm2: score.coveredKm2,
    coveredPct: score.coveredPct,
    coveredCells: score.coveredCells,
  }
}

export function rankCandidates(
  grid: DemGrid,
  peaks: Peak[],
  radio: RadioParams,
  onProgress?: (done: number, total: number) => void,
  searchBbox?: BBox,
): RankedSite[] {
  const scored: RankedSite[] = []
  peaks.forEach((peak, i) => {
    const score = scoreCoverage(grid, peak.col, peak.row, radio, undefined, searchBbox)
    scored.push(toSite(grid, peak, score, 0))
    onProgress?.(i + 1, peaks.length)
  })
  scored.sort((a, b) => b.coveredCells - a.coveredCells)
  return scored.map((s, i) => ({ ...s, rank: i + 1 }))
}

export function refineTopSites(
  coarseSites: RankedSite[],
  fine: DemGrid,
  radio: RadioParams,
  keep: number,
  onProgress?: (done: number, total: number) => void,
  searchBbox?: BBox,
  limit = 10,
): RankedSite[] {
  const seeds = coarseSites.slice(0, keep)
  const extent = searchExtent(fine, searchBbox)
  const radius = Math.max(
    1,
    Math.round(Math.max(extent.col1 - extent.col0, extent.row1 - extent.row0) / 16),
  )
  const seen = new Set<string>()
  const peaks: Peak[] = []

  for (const site of seeds) {
    const { lat, lon } = site
    const col0 = Math.round(((lon - fine.west) / (fine.east - fine.west)) * fine.cols)
    const row0 = Math.round(((fine.north - lat) / (fine.north - fine.south)) * fine.rows)
    for (let r = row0 - radius; r <= row0 + radius; r++) {
      for (let c = col0 - radius; c <= col0 + radius; c++) {
        if (c < extent.col0 || r < extent.row0 || c > extent.col1 || r > extent.row1) continue
        const key = `${c},${r}`
        if (seen.has(key)) continue
        if (
          !isLocalMax(fine, c, r, 1, extent.col0, extent.col1, extent.row0, extent.row1) &&
          (c !== col0 || r !== row0)
        ) {
          continue
        }
        seen.add(key)
        peaks.push({ col: c, row: r, elev: fine.elev[r * fine.cols + c] })
      }
    }
  }

  if (peaks.length === 0) {
    return coarseSites.slice(0, limit)
  }

  return rankCandidates(fine, peaks, radio, onProgress, searchBbox).slice(0, limit)
}

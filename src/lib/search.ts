import type { BBox, DemGrid, RadioParams, RankedSite } from '../types'
import { bboxSizeKm, latLonToColRow } from './geo'
import { sampleElevAtLatLon, scoreSearchArea } from './coverage'

type Peak = { lat: number; lon: number; elev: number }

function thinByMeters(peaks: Peak[], minSepM: number, limit: number): Peak[] {
  const chosen: Peak[] = []
  const sep2 = minSepM * minSepM
  for (const p of peaks) {
    const tooClose = chosen.some((q) => {
      const dLat = (q.lat - p.lat) * 110_574
      const dLon = (q.lon - p.lon) * 111_320 * Math.cos((p.lat * Math.PI) / 180)
      return dLat * dLat + dLon * dLon < sep2
    })
    if (tooClose) continue
    chosen.push(p)
    if (chosen.length >= limit) break
  }
  return chosen
}

function sampleGrid(bbox: BBox, n: number): { lat: number; lon: number }[] {
  const pts: { lat: number; lon: number }[] = []
  const latPad = (bbox.north - bbox.south) * 0.04
  const lonPad = (bbox.east - bbox.west) * 0.04
  const south = bbox.south + latPad
  const north = bbox.north - latPad
  const west = bbox.west + lonPad
  const east = bbox.east - lonPad
  for (let r = 0; r < n; r++) {
    const lat = south + ((r + 0.5) / n) * (north - south)
    for (let c = 0; c < n; c++) {
      const lon = west + ((c + 0.5) / n) * (east - west)
      pts.push({ lat, lon })
    }
  }
  return pts
}

export function collectCandidates(
  grid: DemGrid,
  maxCount: number,
  searchBbox?: BBox,
): Peak[] {
  if (!searchBbox) {
    const pts: Peak[] = []
    for (let r = 1; r < grid.rows - 1; r++) {
      for (let c = 1; c < grid.cols - 1; c++) {
        const { lat, lon } = {
          lon: grid.west + ((c + 0.5) / grid.cols) * (grid.east - grid.west),
          lat: grid.north - ((r + 0.5) / grid.rows) * (grid.north - grid.south),
        }
        pts.push({ lat, lon, elev: grid.elev[r * grid.cols + c] })
      }
    }
    pts.sort((a, b) => b.elev - a.elev)
    return thinByMeters(pts, 400, maxCount)
  }

  const n = Math.min(28, Math.max(8, Math.ceil(Math.sqrt(maxCount * 8))))
  const coords = sampleGrid(searchBbox, n)
  const cells: Peak[] = coords.map(({ lat, lon }) => ({
    lat,
    lon,
    elev: sampleElevAtLatLon(grid, lat, lon),
  }))

  let elevMin = Infinity
  let elevMax = -Infinity
  for (const cell of cells) {
    elevMin = Math.min(elevMin, cell.elev)
    elevMax = Math.max(elevMax, cell.elev)
  }
  const hiCut = elevMin + 0.45 * (elevMax - elevMin || 1)
  const local: Peak[] = []
  const high: Peak[] = []
  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / n)
    const c = i % n
    const e = cells[i].elev
    let isMax = true
    for (let dr = -1; dr <= 1 && isMax; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dc === 0 && dr === 0) continue
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
        if (cells[rr * n + cc].elev > e) {
          isMax = false
          break
        }
      }
    }
    if (isMax) local.push(cells[i])
    else if (e >= hiCut) high.push(cells[i])
  }

  local.sort((a, b) => b.elev - a.elev)
  high.sort((a, b) => b.elev - a.elev)
  cells.sort((a, b) => b.elev - a.elev)

  const { widthKm, heightKm } = bboxSizeKm(searchBbox)
  const minSepM = Math.max(
    40,
    (Math.min(widthKm, heightKm) * 1000) / Math.max(2, Math.sqrt(maxCount) * 1.6),
  )
  const picked = thinByMeters([...local, ...high, ...cells], minSepM, maxCount)
  return picked.length > 0 ? picked : cells.slice(0, maxCount)
}

function toSite(
  grid: DemGrid,
  peak: Peak,
  score: ReturnType<typeof scoreSearchArea>,
  rank: number,
): RankedSite {
  const { col, row } = latLonToColRow(grid, peak.lat, peak.lon)
  return {
    rank,
    lat: peak.lat,
    lon: peak.lon,
    col,
    row,
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
  if (!searchBbox) return []
  const scored: RankedSite[] = []
  peaks.forEach((peak, i) => {
    const score = scoreSearchArea(grid, peak.lat, peak.lon, searchBbox, radio)
    scored.push(toSite(grid, peak, score, 0))
    onProgress?.(i + 1, peaks.length)
  })
  scored.sort((a, b) => b.coveredCells - a.coveredCells || b.elevM - a.elevM)
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
  if (!searchBbox) return coarseSites.slice(0, limit)
  const seeds = coarseSites.slice(0, Math.max(keep, limit))
  const extra = collectCandidates(fine, Math.min(80, Math.max(limit * 5, 24)), searchBbox)
  const nearSeeds: Peak[] = seeds.map((s) => ({ lat: s.lat, lon: s.lon, elev: s.elevM }))
  const merged = [...nearSeeds, ...extra]
  if (merged.length === 0) return coarseSites.slice(0, limit)
  return rankCandidates(fine, merged, radio, onProgress, searchBbox).slice(0, limit)
}

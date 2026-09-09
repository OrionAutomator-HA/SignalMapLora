import type { BBox, DemGrid, ExistingNode, RadioParams, RankedSite } from '../types'
import { bboxSizeKm, latLonToColRow } from './geo'
import { coversLatLon, sampleElevAtLatLon, scoreSearchArea } from './coverage'
import { collectCandidates } from './search'

type DemandPt = { lat: number; lon: number }

function demandGrid(bbox: BBox, n: number): DemandPt[] {
  const pts: DemandPt[] = []
  for (let r = 0; r < n; r++) {
    const lat = bbox.south + ((r + 0.5) / n) * (bbox.north - bbox.south)
    for (let c = 0; c < n; c++) {
      const lon = bbox.west + ((c + 0.5) / n) * (bbox.east - bbox.west)
      pts.push({ lat, lon })
    }
  }
  return pts
}

function dist2(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (a.lat - b.lat) * 110_574
  const dLon = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
  return dLat * dLat + dLon * dLon
}

function coverMask(
  grid: DemGrid,
  tx: { lat: number; lon: number },
  demand: DemandPt[],
  radio: RadioParams,
): boolean[] {
  return demand.map((p) => coversLatLon(grid, tx.lat, tx.lon, p.lat, p.lon, radio))
}

export type MultiPlan = {
  sites: RankedSite[]
  existingPct: number
  finalPct: number
  coveredKm2: number
}

export function planMultiRepeaters(
  grid: DemGrid,
  searchBbox: BBox,
  radio: RadioParams,
  newCount: number,
  existing: ExistingNode[],
  onProgress?: (done: number, total: number) => void,
): MultiPlan {
  const wanted = Math.min(12, Math.max(1, newCount))
  const demand = demandGrid(searchBbox, 18)
  const area = bboxSizeKm(searchBbox).widthKm * bboxSizeKm(searchBbox).heightKm
  const covered = new Uint8Array(demand.length)

  for (const node of existing) {
    const mask = coverMask(grid, node, demand, radio)
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) covered[i] = 1
    }
  }

  const existingCovered = covered.reduce((n, v) => n + v, 0)
  const existingPct = demand.length === 0 ? 0 : (100 * existingCovered) / demand.length

  const pool = collectCandidates(grid, Math.min(64, Math.max(wanted * 8, 24)), searchBbox)
  const used = existing.map((n) => ({ lat: n.lat, lon: n.lon }))
  const minSepM = Math.max(
    80,
    (Math.min(bboxSizeKm(searchBbox).widthKm, bboxSizeKm(searchBbox).heightKm) * 1000) / 6,
  )
  const minSep2 = minSepM * minSepM

  const sites: RankedSite[] = []
  const totalSteps = wanted
  for (let step = 0; step < wanted; step++) {
    onProgress?.(step, totalSteps)
    let bestIdx = -1
    let bestGain = 0
    let bestCover: boolean[] | null = null
    for (let idx = 0; idx < pool.length; idx++) {
      const cand = pool[idx]
      if (used.some((u) => dist2(u, cand) < minSep2)) continue
      const mask = coverMask(grid, cand, demand, radio)
      let gain = 0
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] && !covered[i]) gain++
      }
      if (gain > bestGain) {
        bestGain = gain
        bestIdx = idx
        bestCover = mask
      }
    }
    if (bestIdx < 0 || bestCover === null || bestGain === 0) break
    const pick = pool[bestIdx]
    const chosen = bestCover
    used.push(pick)
    for (let i = 0; i < chosen.length; i++) {
      if (chosen[i]) covered[i] = 1
    }
    const now = covered.reduce((n, v) => n + v, 0)
    const pct = demand.length === 0 ? 0 : (100 * now) / demand.length
    const { col, row } = latLonToColRow(grid, pick.lat, pick.lon)
    const solo = scoreSearchArea(grid, pick.lat, pick.lon, searchBbox, radio)
    sites.push({
      rank: sites.length + 1,
      lat: pick.lat,
      lon: pick.lon,
      col,
      row,
      elevM: sampleElevAtLatLon(grid, pick.lat, pick.lon),
      coveredKm2: (area * bestGain) / demand.length,
      coveredPct: pct,
      coveredCells: solo.coveredCells,
    })
  }
  onProgress?.(wanted, totalSteps)

  const finalCovered = covered.reduce((n, v) => n + v, 0)
  const finalPct = demand.length === 0 ? 0 : (100 * finalCovered) / demand.length
  return {
    sites,
    existingPct,
    finalPct,
    coveredKm2: (area * finalCovered) / demand.length,
  }
}

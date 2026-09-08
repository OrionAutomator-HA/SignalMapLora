import type { BBox, DemGrid, RadioParams } from '../types'
import { EARTH_RADIUS_M, cellAreaKm2, cellMeters, colRowToLatLon, pointInBBox } from './geo'

export function fsplDbm(distanceM: number, frequencyMhz: number): number {
  const dKm = Math.max(distanceM, 1) / 1000
  return 20 * Math.log10(dKm) + 20 * Math.log10(frequencyMhz) + 32.44
}

export function maxRangeM(radio: RadioParams): number {
  const budget =
    radio.txPowerDbm +
    radio.txGainDbi +
    radio.rxGainDbi -
    radio.cutoffDbm -
    32.44 -
    20 * Math.log10(radio.frequencyMhz)
  const dKm = 10 ** (budget / 20)
  return Math.min(Math.max(dKm, 0.05) * 1000, 200_000)
}

function sampleElev(grid: DemGrid, col: number, row: number): number {
  const c = Math.min(grid.cols - 1, Math.max(0, col))
  const r = Math.min(grid.rows - 1, Math.max(0, row))
  const c0 = Math.floor(c)
  const r0 = Math.floor(r)
  const c1 = Math.min(grid.cols - 1, c0 + 1)
  const r1 = Math.min(grid.rows - 1, r0 + 1)
  const fc = c - c0
  const fr = r - r0
  const e00 = grid.elev[r0 * grid.cols + c0]
  const e10 = grid.elev[r0 * grid.cols + c1]
  const e01 = grid.elev[r1 * grid.cols + c0]
  const e11 = grid.elev[r1 * grid.cols + c1]
  return e00 * (1 - fc) * (1 - fr) + e10 * fc * (1 - fr) + e01 * (1 - fc) * fr + e11 * fc * fr
}

export function pathClear(
  grid: DemGrid,
  c0: number,
  r0: number,
  c1: number,
  r1: number,
  txAmsl: number,
  rxAmsl: number,
  mPerCol: number,
  mPerRow: number,
  twoKR: number,
): boolean {
  const distM = Math.hypot((c1 - c0) * mPerCol, (r1 - r0) * mPerRow)
  if (distM < 2) return true

  const steps = Math.max(2, Math.ceil(Math.hypot(c1 - c0, r1 - r0)))
  const rxAdj = rxAmsl - (distM * distM) / twoKR

  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const elev = sampleElev(grid, c0 + t * (c1 - c0), r0 + t * (r1 - r0))
    const d = t * distM
    const sampleAdj = elev - (d * d) / twoKR
    const losAdj = txAmsl + t * (rxAdj - txAmsl)
    if (sampleAdj > losAdj + 0.5) return false
  }
  return true
}

export type CoverageScore = {
  coveredCells: number
  coveredKm2: number
  coveredPct: number
}

export function scoreCoverage(
  grid: DemGrid,
  txCol: number,
  txRow: number,
  radio: RadioParams,
  mask?: Uint8Array,
  scoreBbox?: BBox,
): CoverageScore {
  const { mPerCol, mPerRow } = cellMeters(grid)
  const twoKR = 2 * radio.kFactor * EARTH_RADIUS_M
  const rangeM = maxRangeM(radio)
  const area = cellAreaKm2(grid)
  const txIdx = txRow * grid.cols + txCol
  const txAmsl = grid.elev[txIdx] + radio.txHeightM
  let covered = 0
  let scoreTotal = 0

  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c
      const { lat, lon } = colRowToLatLon(grid, c, r)
      const inScore = !scoreBbox || pointInBBox(lat, lon, scoreBbox)
      if (inScore) scoreTotal++

      if (!mask && !inScore) continue

      if (c === txCol && r === txRow) {
        if (inScore) covered++
        if (mask) mask[i] = 1
        continue
      }
      const distM = Math.hypot((c - txCol) * mPerCol, (r - txRow) * mPerRow)
      if (distM > rangeM) {
        if (mask) mask[i] = 0
        continue
      }
      const rxAmsl = grid.elev[i] + radio.rxHeightM
      const rssi =
        radio.txPowerDbm +
        radio.txGainDbi +
        radio.rxGainDbi -
        fsplDbm(distM, radio.frequencyMhz)
      if (rssi < radio.cutoffDbm) {
        if (mask) mask[i] = 0
        continue
      }
      const ok = pathClear(
        grid,
        txCol,
        txRow,
        c,
        r,
        txAmsl,
        rxAmsl,
        mPerCol,
        mPerRow,
        twoKR,
      )
      if (ok) {
        if (inScore) covered++
        if (mask) mask[i] = 1
      } else if (mask) {
        mask[i] = 0
      }
    }
  }

  const total = scoreBbox ? scoreTotal : grid.cols * grid.rows
  return {
    coveredCells: covered,
    coveredKm2: covered * area,
    coveredPct: total === 0 ? 0 : (100 * covered) / total,
  }
}

import type { BBox, DemGrid, RadioParams } from '../types'
import {
  EARTH_RADIUS_M,
  bboxSizeKm,
  cellMeters,
  colRowToLatLon,
  latLonToColRowFloat,
} from './geo'

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

export function sampleElev(grid: DemGrid, col: number, row: number): number {
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

export function sampleElevAtLatLon(grid: DemGrid, lat: number, lon: number): number {
  const { col, row } = latLonToColRowFloat(grid, lat, lon)
  return sampleElev(grid, col, row)
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

function linkCovered(
  grid: DemGrid,
  txCol: number,
  txRow: number,
  rxCol: number,
  rxRow: number,
  radio: RadioParams,
  mPerCol: number,
  mPerRow: number,
  twoKR: number,
  rangeM: number,
): boolean {
  const distM = Math.hypot((rxCol - txCol) * mPerCol, (rxRow - txRow) * mPerRow)
  if (distM < 2) return true
  if (distM > rangeM) return false
  const rssi =
    radio.txPowerDbm +
    radio.txGainDbi +
    radio.rxGainDbi -
    fsplDbm(distM, radio.frequencyMhz)
  if (rssi < radio.cutoffDbm) return false
  const txAmsl = sampleElev(grid, txCol, txRow) + radio.txHeightM
  const rxAmsl = sampleElev(grid, rxCol, rxRow) + radio.rxHeightM
  return pathClear(grid, txCol, txRow, rxCol, rxRow, txAmsl, rxAmsl, mPerCol, mPerRow, twoKR)
}

export function scoreSearchArea(
  grid: DemGrid,
  txLat: number,
  txLon: number,
  searchBbox: BBox,
  radio: RadioParams,
): CoverageScore {
  const { mPerCol, mPerRow } = cellMeters(grid)
  const twoKR = 2 * radio.kFactor * EARTH_RADIUS_M
  const rangeM = maxRangeM(radio)
  const tx = latLonToColRowFloat(grid, txLat, txLon)
  const { widthKm, heightKm } = bboxSizeKm(searchBbox)
  const area = widthKm * heightKm
  const samples = 20
  let covered = 0
  let total = 0
  for (let r = 0; r < samples; r++) {
    const lat =
      searchBbox.south + ((r + 0.5) / samples) * (searchBbox.north - searchBbox.south)
    for (let c = 0; c < samples; c++) {
      const lon =
        searchBbox.west + ((c + 0.5) / samples) * (searchBbox.east - searchBbox.west)
      total++
      const rx = latLonToColRowFloat(grid, lat, lon)
      if (
        linkCovered(grid, tx.col, tx.row, rx.col, rx.row, radio, mPerCol, mPerRow, twoKR, rangeM)
      ) {
        covered++
      }
    }
  }
  return {
    coveredCells: covered,
    coveredKm2: total === 0 ? 0 : (area * covered) / total,
    coveredPct: total === 0 ? 0 : (100 * covered) / total,
  }
}

export function fillCoverageMask(
  grid: DemGrid,
  txLat: number,
  txLon: number,
  radio: RadioParams,
  mask: Uint8Array,
): void {
  const { mPerCol, mPerRow } = cellMeters(grid)
  const twoKR = 2 * radio.kFactor * EARTH_RADIUS_M
  const rangeM = maxRangeM(radio)
  const tx = latLonToColRowFloat(grid, txLat, txLon)
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const i = r * grid.cols + c
      const { lat, lon } = colRowToLatLon(grid, c, r)
      const rx = latLonToColRowFloat(grid, lat, lon)
      mask[i] = linkCovered(
        grid,
        tx.col,
        tx.row,
        rx.col,
        rx.row,
        radio,
        mPerCol,
        mPerRow,
        twoKR,
        rangeM,
      )
        ? 1
        : 0
    }
  }
}

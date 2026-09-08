export type BBox = {
  west: number
  south: number
  east: number
  north: number
}

export type RadioParams = {
  frequencyMhz: number
  txPowerDbm: number
  txGainDbi: number
  rxGainDbi: number
  txHeightM: number
  rxHeightM: number
  cutoffDbm: number
  kFactor: number
}

export type DemGrid = {
  elev: Float32Array
  cols: number
  rows: number
  west: number
  south: number
  east: number
  north: number
}

export type RankedSite = {
  rank: number
  lat: number
  lon: number
  col: number
  row: number
  elevM: number
  coveredKm2: number
  coveredPct: number
  coveredCells: number
}

export type SearchProgress = {
  message: string
  fraction: number
}

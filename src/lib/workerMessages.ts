import type { BBox, DemGrid, ExistingNode, RadioParams, RankedSite } from '../types'

export type WorkerRequest =
  | {
      type: 'search'
      jobId: number
      coarse: DemGrid
      fine: DemGrid
      radio: RadioParams
      searchBbox: BBox
      siteCount: number
    }
  | {
      type: 'multi'
      jobId: number
      fine: DemGrid
      radio: RadioParams
      searchBbox: BBox
      newCount: number
      existing: ExistingNode[]
    }
  | {
      type: 'coverage'
      jobId: number
      grid: DemGrid
      lat: number
      lon: number
      radio: RadioParams
    }
  | {
      type: 'unionCoverage'
      jobId: number
      grid: DemGrid
      radio: RadioParams
      transmitters: { lat: number; lon: number }[]
    }

export type WorkerResponse =
  | { type: 'progress'; jobId: number; message: string; fraction: number }
  | {
      type: 'result'
      jobId: number
      sites: RankedSite[]
      mask: Uint8Array
      cols: number
      rows: number
    }
  | {
      type: 'multiResult'
      jobId: number
      sites: RankedSite[]
      mask: Uint8Array
      cols: number
      rows: number
      existingPct: number
      finalPct: number
      coveredKm2: number
    }
  | {
      type: 'coverage'
      jobId: number
      mask: Uint8Array
      cols: number
      rows: number
    }
  | { type: 'error'; jobId: number; message: string }

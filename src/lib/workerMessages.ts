import type { BBox, DemGrid, RadioParams, RankedSite } from '../types'

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
      type: 'coverage'
      jobId: number
      grid: DemGrid
      lat: number
      lon: number
      radio: RadioParams
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
      type: 'coverage'
      jobId: number
      mask: Uint8Array
      cols: number
      rows: number
    }
  | { type: 'error'; jobId: number; message: string }

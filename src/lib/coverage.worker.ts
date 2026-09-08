import { scoreCoverage } from './coverage'
import { latLonToColRow } from './geo'
import { collectCandidates, rankCandidates, refineTopSites } from './search'
import type { WorkerRequest, WorkerResponse } from './workerMessages'

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const jobId = event.data.jobId
  try {
    const msg = event.data
    if (msg.type === 'search') {
      self.postMessage({
        type: 'progress',
        jobId,
        message: 'Finding high ground…',
        fraction: 0.4,
      } satisfies WorkerResponse)

      const wanted = Math.min(40, Math.max(1, Math.round(msg.siteCount) || 10))
      const pool = Math.min(80, Math.max(wanted * 4, wanted + 8))
      const peaks = collectCandidates(msg.coarse, pool, msg.searchBbox)
      const coarseRanked = rankCandidates(
        msg.coarse,
        peaks,
        msg.radio,
        (done, total) => {
          self.postMessage({
            type: 'progress',
            jobId,
            message: `Scoring candidate sites (${done}/${total})`,
            fraction: 0.4 + (done / total) * 0.35,
          } satisfies WorkerResponse)
        },
        msg.searchBbox,
      )

      self.postMessage({
        type: 'progress',
        jobId,
        message: 'Refining top sites…',
        fraction: 0.78,
      } satisfies WorkerResponse)

      const sites = refineTopSites(
        coarseRanked,
        msg.fine,
        msg.radio,
        wanted,
        (done, total) => {
          self.postMessage({
            type: 'progress',
            jobId,
            message: `Fine search (${done}/${total})`,
            fraction: 0.78 + (done / total) * 0.18,
          } satisfies WorkerResponse)
        },
        msg.searchBbox,
        wanted,
      )

      const best = sites[0]
      const mask = new Uint8Array(msg.fine.cols * msg.fine.rows)
      if (best) {
        scoreCoverage(msg.fine, best.col, best.row, msg.radio, mask, msg.searchBbox)
      }

      const response: WorkerResponse = {
        type: 'result',
        jobId,
        sites,
        mask,
        cols: msg.fine.cols,
        rows: msg.fine.rows,
      }
      self.postMessage(response)
      return
    }

    if (msg.type === 'coverage') {
      const { col, row } = latLonToColRow(msg.grid, msg.lat, msg.lon)
      const mask = new Uint8Array(msg.grid.cols * msg.grid.rows)
      scoreCoverage(msg.grid, col, row, msg.radio, mask)
      self.postMessage({
        type: 'coverage',
        jobId,
        mask,
        cols: msg.grid.cols,
        rows: msg.grid.rows,
      } satisfies WorkerResponse)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Coverage search failed'
    self.postMessage({ type: 'error', jobId, message } satisfies WorkerResponse)
  }
}

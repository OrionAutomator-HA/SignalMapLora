import { fillBestRssi, fillCoverageMask, maskFromRssi } from './coverage'
import { planMultiRepeaters } from './optimizer'
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
      const pool = Math.min(80, Math.max(wanted * 5, wanted + 8))
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
        fillCoverageMask(msg.fine, best.lat, best.lon, msg.radio, mask)
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

    if (msg.type === 'multi') {
      self.postMessage({
        type: 'progress',
        jobId,
        message: 'Planning repeater set…',
        fraction: 0.42,
      } satisfies WorkerResponse)
      const plan = planMultiRepeaters(
        msg.fine,
        msg.searchBbox,
        msg.radio,
        msg.newCount,
        msg.existing,
        (done, total) => {
          self.postMessage({
            type: 'progress',
            jobId,
            message: `Placing repeater ${Math.min(done + 1, total)} of ${total}`,
            fraction: 0.42 + (done / Math.max(1, total)) * 0.4,
          } satisfies WorkerResponse)
        },
      )
      const rssi = new Float32Array(msg.fine.cols * msg.fine.rows)
      fillBestRssi(
        msg.fine,
        [...msg.existing, ...plan.sites].map((n) => ({ lat: n.lat, lon: n.lon })),
        msg.radio,
        rssi,
      )
      const mask = maskFromRssi(rssi)
      self.postMessage(
        {
          type: 'multiResult',
          jobId,
          sites: plan.sites,
          mask,
          cols: msg.fine.cols,
          rows: msg.fine.rows,
          existingPct: plan.existingPct,
          finalPct: plan.finalPct,
          coveredKm2: plan.coveredKm2,
          rssi,
        } satisfies WorkerResponse,
        { transfer: [rssi.buffer] },
      )
      return
    }

    if (msg.type === 'coverage') {
      const mask = new Uint8Array(msg.grid.cols * msg.grid.rows)
      fillCoverageMask(msg.grid, msg.lat, msg.lon, msg.radio, mask)
      self.postMessage({
        type: 'coverage',
        jobId,
        mask,
        cols: msg.grid.cols,
        rows: msg.grid.rows,
      } satisfies WorkerResponse)
    }

    if (msg.type === 'unionCoverage') {
      const rssi = new Float32Array(msg.grid.cols * msg.grid.rows)
      fillBestRssi(msg.grid, msg.transmitters, msg.radio, rssi)
      const mask = maskFromRssi(rssi)
      self.postMessage(
        {
          type: 'coverage',
          jobId,
          mask,
          cols: msg.grid.cols,
          rows: msg.grid.rows,
          rssi,
        } satisfies WorkerResponse,
        { transfer: [rssi.buffer] },
      )
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Coverage search failed'
    self.postMessage({ type: 'error', jobId, message } satisfies WorkerResponse)
  }
}

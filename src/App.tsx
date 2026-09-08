import { useMemo, useRef, useState } from 'react'
import { MapView } from './components/MapView'
import { Panel } from './components/Panel'
import { downsampleGrid, loadDemGrid } from './lib/dem'
import { maxRangeM } from './lib/coverage'
import {
  bboxSizeKm,
  chooseGridShape,
  expandBbox,
  MAX_COVERAGE_PAD_KM,
  MAX_REGION_KM,
} from './lib/geo'
import { maskToDataUrl } from './lib/overlay'
import type { WorkerRequest, WorkerResponse } from './lib/workerMessages'
import type { BBox, RadioParams, RankedSite } from './types'
import './App.css'

const defaultRadio: RadioParams = {
  frequencyMhz: 868.3,
  txPowerDbm: 14,
  txGainDbi: 3,
  rxGainDbi: 0,
  txHeightM: 5,
  rxHeightM: 1.5,
  cutoffDbm: -120,
  kFactor: 4 / 3,
}

export default function App() {
  const [radio, setRadio] = useState<RadioParams>(defaultRadio)
  const [bbox, setBbox] = useState<BBox | null>(null)
  const [drawing, setDrawing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sites, setSites] = useState<RankedSite[]>([])
  const [selectedRank, setSelectedRank] = useState<number | null>(null)
  const [overlayUrl, setOverlayUrl] = useState<string | null>(null)
  const [overlayBounds, setOverlayBounds] = useState<BBox | null>(null)
  const [siteCount, setSiteCount] = useState(10)
  const fineGridRef = useRef<Awaited<ReturnType<typeof loadDemGrid>> | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const jobRef = useRef(0)

  const worker = useMemo(() => {
    const w = new Worker(new URL('./lib/coverage.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = w
    return w
  }, [])

  function resetResults() {
    setSites([])
    setSelectedRank(null)
    setOverlayUrl(null)
    setOverlayBounds(null)
    fineGridRef.current = null
  }

  async function runSearch() {
    if (!bbox) return
    const size = bboxSizeKm(bbox)
    if (size.maxSideKm > MAX_REGION_KM) return
    setBusy(true)
    setError(null)
    resetResults()
    setProgress('Loading terrain…')

    try {
      const padKm = Math.min(maxRangeM(radio) / 1000, MAX_COVERAGE_PAD_KM)
      const coverageBbox = expandBbox(bbox, padKm)
      const coverSize = bboxSizeKm(coverageBbox)
      const coarseShape = chooseGridShape(coverageBbox, coverSize.maxSideKm > 90 ? 80 : 96)
      const fineShape = chooseGridShape(coverageBbox, coverSize.maxSideKm > 90 ? 128 : 160)
      const fine = await loadDemGrid(
        coverageBbox,
        fineShape.cols,
        fineShape.rows,
        (message, fraction) => {
          setProgress(`${message} (${Math.round(fraction * 100)}%)`)
        },
      )
      const coarse = downsampleGrid(fine, coarseShape.cols, coarseShape.rows)
      fineGridRef.current = fine
      const jobId = ++jobRef.current

      const result = await new Promise<Extract<WorkerResponse, { type: 'result' }>>(
        (resolve, reject) => {
          const onMessage = (event: MessageEvent<WorkerResponse>) => {
            const msg = event.data
            if (msg.jobId !== jobId) return
            if (msg.type === 'progress') {
              setProgress(`${msg.message} (${Math.round(msg.fraction * 100)}%)`)
              return
            }
            worker.removeEventListener('message', onMessage)
            if (msg.type === 'error') reject(new Error(msg.message))
            else if (msg.type === 'result') resolve(msg)
            else reject(new Error('Unexpected worker response'))
          }
          worker.addEventListener('message', onMessage)
          const payload: WorkerRequest = {
            type: 'search',
            jobId,
            coarse,
            fine,
            radio,
            searchBbox: bbox,
            siteCount,
          }
          worker.postMessage(payload)
        },
      )

      setSites(result.sites)
      setSelectedRank(result.sites[0]?.rank ?? null)
      setOverlayBounds(coverageBbox)
      setOverlayUrl(
        result.sites.length
          ? maskToDataUrl(result.mask, result.cols, result.rows)
          : null,
      )
      setProgress(
        result.sites[0]
          ? `Best site covers ${result.sites[0].coveredKm2.toFixed(1)} km² (${result.sites[0].coveredPct.toFixed(0)}%)`
          : 'No candidate sites found',
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  async function selectSite(rank: number) {
    setSelectedRank(rank)
    const site = sites.find((s) => s.rank === rank)
    const grid = fineGridRef.current
    if (!site || !grid || !workerRef.current) return
    setBusy(true)
    setProgress(`Computing coverage for site #${rank}…`)
    try {
      const result = await new Promise<Extract<WorkerResponse, { type: 'coverage' }>>(
        (resolve, reject) => {
          const jobId = ++jobRef.current
          const onMessage = (event: MessageEvent<WorkerResponse>) => {
            const msg = event.data
            if (msg.jobId !== jobId) return
            if (msg.type === 'progress') return
            workerRef.current?.removeEventListener('message', onMessage)
            if (msg.type === 'coverage') resolve(msg)
            else if (msg.type === 'error') reject(new Error(msg.message))
            else reject(new Error('Unexpected worker response'))
          }
          workerRef.current?.addEventListener('message', onMessage)
          const payload: WorkerRequest = {
            type: 'coverage',
            jobId,
            grid,
            lat: site.lat,
            lon: site.lon,
            radio,
          }
          workerRef.current?.postMessage(payload)
        },
      )
      setOverlayUrl(maskToDataUrl(result.mask, result.cols, result.rows))
      setProgress(
        `Site #${rank} covers ${site.coveredKm2.toFixed(1)} km² (${site.coveredPct.toFixed(0)}%)`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Coverage failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app">
      <Panel
        radio={radio}
        onRadio={setRadio}
        bbox={bbox}
        drawing={drawing}
        onDraw={() => {
          setDrawing(true)
          setError(null)
        }}
        onSearch={() => void runSearch()}
        onClear={() => {
          setBbox(null)
          setDrawing(false)
          resetResults()
          setProgress('')
          setError(null)
        }}
        busy={busy}
        progress={progress}
        error={error}
        sites={sites}
        selectedRank={selectedRank}
        onSelect={(rank) => void selectSite(rank)}
        siteCount={siteCount}
        onSiteCount={(n) => setSiteCount(Math.min(40, Math.max(1, Math.round(n) || 1)))}
      />
      <MapView
        drawing={drawing}
        bbox={bbox}
        onBbox={(next) => {
          setBbox(next)
          resetResults()
        }}
        onDrawEnd={() => setDrawing(false)}
        sites={sites}
        selectedRank={selectedRank}
        onSelect={(rank) => void selectSite(rank)}
        overlayUrl={overlayUrl}
        overlayBounds={overlayBounds}
      />
    </div>
  )
}

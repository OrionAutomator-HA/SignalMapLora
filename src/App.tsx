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
import type { BBox, ExistingNode, PlanMode, RadioParams, RankedSite } from './types'
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
  const [mode, setMode] = useState<PlanMode>('rank')
  const [repeaterCount, setRepeaterCount] = useState(3)
  const [useExisting, setUseExisting] = useState(false)
  const [placingExisting, setPlacingExisting] = useState(false)
  const [existingNodes, setExistingNodes] = useState<ExistingNode[]>([])
  const [existingPct, setExistingPct] = useState<number | null>(null)
  const [finalPct, setFinalPct] = useState<number | null>(null)
  const fineGridRef = useRef<Awaited<ReturnType<typeof loadDemGrid>> | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const jobRef = useRef(0)
  const existingSeq = useRef(0)

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
    setExistingPct(null)
    setFinalPct(null)
    fineGridRef.current = null
  }

  async function loadGrids(search: BBox) {
    const padKm = Math.min(maxRangeM(radio) / 1000, MAX_COVERAGE_PAD_KM)
    const coverageBbox = expandBbox(search, padKm)
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
    return { coarse, fine, coverageBbox }
  }

  function waitForWorker<T extends WorkerResponse['type']>(
    jobId: number,
    type: T,
  ): Promise<Extract<WorkerResponse, { type: T }>> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data
        if (msg.jobId !== jobId) return
        if (msg.type === 'progress') {
          setProgress(`${msg.message} (${Math.round(msg.fraction * 100)}%)`)
          return
        }
        worker.removeEventListener('message', onMessage)
        if (msg.type === 'error') reject(new Error(msg.message))
        else if (msg.type === type) resolve(msg as Extract<WorkerResponse, { type: T }>)
        else reject(new Error('Unexpected worker response'))
      }
      worker.addEventListener('message', onMessage)
    })
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
      const { coarse, fine, coverageBbox } = await loadGrids(bbox)
      const jobId = ++jobRef.current
      if (mode === 'multi') {
        const pending = waitForWorker(jobId, 'multiResult')
        const payload: WorkerRequest = {
          type: 'multi',
          jobId,
          fine,
          radio,
          searchBbox: bbox,
          newCount: repeaterCount,
          existing: useExisting ? existingNodes : [],
        }
        worker.postMessage(payload)
        const result = await pending
        setSites(result.sites)
        setSelectedRank(result.sites[0]?.rank ?? null)
        setOverlayBounds(coverageBbox)
        setOverlayUrl(maskToDataUrl(result.mask, result.cols, result.rows))
        setExistingPct(result.existingPct)
        setFinalPct(result.finalPct)
        setProgress(
          result.sites.length
            ? `Plan covers ${result.coveredKm2.toFixed(1)} km² (${result.finalPct.toFixed(0)}% of the square)`
            : 'Could not place extra repeaters (existing nodes may already cover the square)',
        )
      } else {
        const pending = waitForWorker(jobId, 'result')
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
        const result = await pending
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
      }
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
      const jobId = ++jobRef.current
      const pending = waitForWorker(jobId, 'coverage')
      if (mode === 'multi') {
        const transmitters = [
          ...(useExisting ? existingNodes : []),
          ...sites,
        ].map((n) => ({ lat: n.lat, lon: n.lon }))
        const payload: WorkerRequest = {
          type: 'unionCoverage',
          jobId,
          grid,
          radio,
          transmitters,
        }
        worker.postMessage(payload)
      } else {
        const payload: WorkerRequest = {
          type: 'coverage',
          jobId,
          grid,
          lat: site.lat,
          lon: site.lon,
          radio,
        }
        worker.postMessage(payload)
      }
      const result = await pending
      setOverlayUrl(maskToDataUrl(result.mask, result.cols, result.rows))
      setProgress(
        mode === 'multi'
          ? `Combined coverage ${finalPct?.toFixed(0) ?? '—'}% of the square`
          : `Site #${rank} covers ${site.coveredKm2.toFixed(1)} km² (${site.coveredPct.toFixed(0)}%)`,
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
          setPlacingExisting(false)
          setError(null)
        }}
        onSearch={() => void runSearch()}
        onClear={() => {
          setBbox(null)
          setDrawing(false)
          setPlacingExisting(false)
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
        mode={mode}
        onMode={(next) => {
          setMode(next)
          resetResults()
          setPlacingExisting(false)
          setDrawing(false)
        }}
        repeaterCount={repeaterCount}
        onRepeaterCount={(n) => setRepeaterCount(Math.min(12, Math.max(1, Math.round(n) || 1)))}
        useExisting={useExisting}
        onUseExisting={(v) => {
          setUseExisting(v)
          if (!v) setPlacingExisting(false)
        }}
        placingExisting={placingExisting}
        onPlacingExisting={() => {
          setDrawing(false)
          setPlacingExisting((v) => !v)
        }}
        existingNodes={existingNodes}
        onRemoveExisting={(id) => setExistingNodes((nodes) => nodes.filter((n) => n.id !== id))}
        onAddExistingCoords={(lat, lon) => {
          existingSeq.current += 1
          setExistingNodes((nodes) => [
            ...nodes,
            { id: `n${existingSeq.current}`, lat, lon },
          ])
        }}
        existingPct={existingPct}
        finalPct={finalPct}
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
        placingExisting={placingExisting}
        existingNodes={useExisting ? existingNodes : []}
        onAddExisting={(lat, lon) => {
          existingSeq.current += 1
          setExistingNodes((nodes) => [
            ...nodes,
            { id: `n${existingSeq.current}`, lat, lon },
          ])
        }}
      />
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import { MapView } from './components/MapView'
import { Panel } from './components/Panel'
import { downsampleGrid, loadDemGrid } from './lib/dem'
import { maxRangeM } from './lib/coverage'
import {
  bboxAroundPoint,
  bboxFromPoints,
  bboxSizeKm,
  cellAreaKm2,
  chooseGridShape,
  expandBbox,
  gridMaxSide,
  MAX_COVERAGE_PAD_KM,
  MAX_MESH_SPAN_KM,
  MAX_REGION_KM,
} from './lib/geo'
import { maskToDataUrl } from './lib/overlay'
import { importRepeatersOverIp, importRepeatersOverUsb } from './lib/meshcore'
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
  const [probe, setProbe] = useState<ExistingNode | null>(null)
  const [coveredKm2, setCoveredKm2] = useState<number | null>(null)
  const [meshNodes, setMeshNodes] = useState<ExistingNode[]>([])
  const [helperCommand, setHelperCommand] = useState<string | null>(null)
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
    setCoveredKm2(null)
    fineGridRef.current = null
  }

  function placeNode(lat: number, lon: number) {
    if (mode === 'check') {
      setProbe({ id: 'tx', lat, lon })
      setCoveredKm2(null)
      setOverlayUrl(null)
      setOverlayBounds(null)
      return
    }
    existingSeq.current += 1
    setExistingNodes((nodes) => [...nodes, { id: `n${existingSeq.current}`, lat, lon }])
  }

  async function loadGrids(search: BBox) {
    const padKm = Math.min(maxRangeM(radio) / 1000, MAX_COVERAGE_PAD_KM)
    const coverageBbox = expandBbox(search, padKm)
    const coverSize = bboxSizeKm(coverageBbox)
    const coarseShape = chooseGridShape(coverageBbox, gridMaxSide(coverSize.maxSideKm, 'coarse'))
    const fineShape = chooseGridShape(coverageBbox, gridMaxSide(coverSize.maxSideKm, 'fine'))
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

  async function runUnionCoverage(nodes: ExistingNode[]) {
    if (!nodes.length) return
    const padKm = Math.min(maxRangeM(radio) / 1000, MAX_COVERAGE_PAD_KM)
    const coverageBbox = bboxFromPoints(nodes, padKm)
    const coverSize = bboxSizeKm(coverageBbox)
    if (coverSize.maxSideKm > MAX_MESH_SPAN_KM) {
      throw new Error(
        `Those nodes span more than ${MAX_MESH_SPAN_KM} km including radio range. Import a smaller set, or lower TX power so the map window shrinks.`,
      )
    }
    const maxSide = gridMaxSide(coverSize.maxSideKm, 'fine')
    const fineShape = chooseGridShape(coverageBbox, maxSide)
    const fine = await loadDemGrid(
      coverageBbox,
      fineShape.cols,
      fineShape.rows,
      (message, fraction) => {
        setProgress(`${message} (${Math.round(fraction * 100)}%)`)
      },
    )
    fineGridRef.current = fine
    const jobId = ++jobRef.current
    const pending = waitForWorker(jobId, 'coverage')
    const payload: WorkerRequest = {
      type: 'unionCoverage',
      jobId,
      grid: fine,
      radio,
      transmitters: nodes.map((n) => ({ lat: n.lat, lon: n.lon })),
    }
    worker.postMessage(payload)
    const result = await pending
    let covered = 0
    for (let i = 0; i < result.mask.length; i++) {
      if (result.mask[i]) covered++
    }
    const km2 = covered * cellAreaKm2(fine)
    setOverlayBounds(coverageBbox)
    setOverlayUrl(maskToDataUrl(result.mask, result.cols, result.rows))
    setCoveredKm2(km2)
    setProgress(
      `Imported ${nodes.length} node${nodes.length === 1 ? '' : 's'} · about ${km2.toFixed(1)} km² combined`,
    )
  }

  async function importMesh(loader: () => Promise<ExistingNode[]>) {
    setBusy(true)
    setError(null)
    setSites([])
    setOverlayUrl(null)
    setCoveredKm2(null)
    setProgress('Talking to MeshCore radio…')
    setHelperCommand(null)
    try {
      const nodes = await loader()
      if (!nodes.length) {
        throw new Error(
          'Connected, but no repeater or room-server contacts had a saved location.',
        )
      }
      setMeshNodes(nodes)
      setProgress(`Loaded ${nodes.length} located node${nodes.length === 1 ? '' : 's'}. Fetching terrain…`)
      await runUnionCoverage(nodes)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        setProgress('')
        return
      }
      setError(err instanceof Error ? err.message : 'MeshCore import failed')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  async function runCoverageCheck() {
    if (!probe) return
    setBusy(true)
    setError(null)
    setSites([])
    setSelectedRank(null)
    setCoveredKm2(null)
    setOverlayUrl(null)
    setProgress('Loading terrain…')
    try {
      const padKm = Math.min(maxRangeM(radio) / 1000, MAX_COVERAGE_PAD_KM)
      const coverageBbox = bboxAroundPoint(probe.lat, probe.lon, padKm)
      const coverSize = bboxSizeKm(coverageBbox)
      const fineShape = chooseGridShape(coverageBbox, gridMaxSide(coverSize.maxSideKm, 'fine'))
      const fine = await loadDemGrid(
        coverageBbox,
        fineShape.cols,
        fineShape.rows,
        (message, fraction) => {
          setProgress(`${message} (${Math.round(fraction * 100)}%)`)
        },
      )
      fineGridRef.current = fine
      const jobId = ++jobRef.current
      const pending = waitForWorker(jobId, 'coverage')
      const payload: WorkerRequest = {
        type: 'coverage',
        jobId,
        grid: fine,
        lat: probe.lat,
        lon: probe.lon,
        radio,
      }
      worker.postMessage(payload)
      const result = await pending
      let covered = 0
      for (let i = 0; i < result.mask.length; i++) {
        if (result.mask[i]) covered++
      }
      const km2 = covered * cellAreaKm2(fine)
      setOverlayBounds(coverageBbox)
      setOverlayUrl(maskToDataUrl(result.mask, result.cols, result.rows))
      setCoveredKm2(km2)
      setProgress(`Predicted reach about ${km2.toFixed(1)} km²`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Coverage failed')
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  async function runSearch() {
    if (mode === 'mesh') {
      if (!meshNodes.length) return
      setBusy(true)
      setError(null)
      setProgress('Loading terrain…')
      try {
        await runUnionCoverage(meshNodes)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Coverage failed')
        setProgress('')
      } finally {
        setBusy(false)
      }
      return
    }
    if (mode === 'check') {
      await runCoverageCheck()
      return
    }
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
          setPlacingExisting(mode === 'check')
          setProbe(null)
          setMeshNodes([])
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
          setDrawing(false)
          setPlacingExisting(next === 'check')
          if (next !== 'check') setProbe(null)
          if (next !== 'mesh') setMeshNodes([])
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
        onAddExistingCoords={(lat, lon) => placeNode(lat, lon)}
        existingPct={existingPct}
        finalPct={finalPct}
        probe={probe}
        coveredKm2={coveredKm2}
        meshNodes={meshNodes}
        onUsbImport={() => void importMesh(() => importRepeatersOverUsb())}
        onIpImport={(host, port, viaServerLan) =>
          void importMesh(() =>
            importRepeatersOverIp(host, port, {
              viaServerLan,
              onHelperCommand: (command) => {
                setHelperCommand(command)
                setProgress('Waiting for the PowerShell helper on this PC…')
              },
            }),
          )
        }
        helperCommand={helperCommand}
      />
      <MapView
        drawing={drawing}
        bbox={mode === 'check' || mode === 'mesh' ? null : bbox}
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
        placingExisting={mode === 'check' || placingExisting}
        existingNodes={
          mode === 'mesh'
            ? meshNodes
            : mode === 'check'
              ? probe
                ? [probe]
                : []
              : useExisting
                ? existingNodes
                : []
        }
        onAddExisting={(lat, lon) => placeNode(lat, lon)}
        nodeMarkerStyle={mode === 'mesh' ? 'mesh' : mode === 'check' ? 'probe' : 'existing'}
        fitOverlay={mode === 'check' || mode === 'mesh'}
      />
    </div>
  )
}

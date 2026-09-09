import { useState } from 'react'
import type { BBox, ExistingNode, PlanMode, RadioParams, RankedSite } from '../types'
import { MAX_REGION_KM, WARN_REGION_KM, bboxSizeKm } from '../lib/geo'
import { HEATMAP_SPAN_DB, type OverlayStyle } from '../lib/overlay'

type Props = {
  radio: RadioParams
  onRadio: (next: RadioParams) => void
  bbox: BBox | null
  drawing: boolean
  onDraw: () => void
  onSearch: () => void
  onClear: () => void
  busy: boolean
  progress: string
  error: string | null
  sites: RankedSite[]
  selectedRank: number | null
  onSelect: (rank: number) => void
  siteCount: number
  onSiteCount: (n: number) => void
  mode: PlanMode
  onMode: (mode: PlanMode) => void
  repeaterCount: number
  onRepeaterCount: (n: number) => void
  useExisting: boolean
  onUseExisting: (v: boolean) => void
  placingExisting: boolean
  onPlacingExisting: () => void
  existingNodes: ExistingNode[]
  onRemoveExisting: (id: string) => void
  onAddExistingCoords: (lat: number, lon: number) => void
  existingPct: number | null
  finalPct: number | null
  probe: ExistingNode | null
  coveredKm2: number | null
  meshNodes: ExistingNode[]
  onUsbImport: () => void
  onIpImport: (host: string, port: number, viaServerLan: boolean) => void
  helperCommand: string | null
  overlayStyle: OverlayStyle
  onOverlayStyle: (style: OverlayStyle) => void
  overlayCutoffDbm: number
}

const PRESETS = {
  eu: { frequencyMhz: 868.3, txPowerDbm: 14 },
  us: { frequencyMhz: 915.0, txPowerDbm: 22 },
} as const

function Field({
  label,
  value,
  onChange,
  step,
  unit,
  min,
  max,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  step: number
  unit: string
  min?: number
  max?: number
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="field-input">
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <em>{unit}</em>
      </span>
    </label>
  )
}

export function Panel({
  radio,
  onRadio,
  bbox,
  drawing,
  onDraw,
  onSearch,
  onClear,
  busy,
  progress,
  error,
  sites,
  selectedRank,
  onSelect,
  siteCount,
  onSiteCount,
  mode,
  onMode,
  repeaterCount,
  onRepeaterCount,
  useExisting,
  onUseExisting,
  placingExisting,
  onPlacingExisting,
  existingNodes,
  onRemoveExisting,
  onAddExistingCoords,
  existingPct,
  finalPct,
  probe,
  coveredKm2,
  meshNodes,
  onUsbImport,
  onIpImport,
  helperCommand,
  overlayStyle,
  onOverlayStyle,
  overlayCutoffDbm,
}: Props) {
  const size = bbox ? bboxSizeKm(bbox) : null
  const tooBig = size ? size.maxSideKm > MAX_REGION_KM : false
  const warn = size ? size.maxSideKm > WARN_REGION_KM : false
  const usbBlock = usbSerialBlockReason()
  const [addLat, setAddLat] = useState('')
  const [addLon, setAddLon] = useState('')
  const [meshHost, setMeshHost] = useState('')
  const [meshPort, setMeshPort] = useState('5000')
  const [viaServerLan, setViaServerLan] = useState(false)

  return (
    <aside className="panel">
      <header className="panel-header">
        <h1>Antenna site planner</h1>
        <p>
          {mode === 'mesh'
            ? 'Experimental: pull repeater contacts with locations from a MeshCore companion radio, plot them, and estimate combined coverage.'
            : mode === 'check'
            ? 'Drop your node on the map to see the land it should reach with these radio settings.'
            : mode === 'multi'
              ? 'Draw an area, optionally mark existing repeaters, then place extra masts so the square is covered.'
              : 'Draw a region, set mast and radio values, then rank high ground by MeshCore-style LoRa land coverage.'}
        </p>
      </header>

      <section>
        <h2>Mode</h2>
        <div className="row">
          <button
            type="button"
            className={mode === 'rank' ? 'chip on' : 'chip'}
            onClick={() => onMode('rank')}
            disabled={busy}
          >
            Rank sites
          </button>
          <button
            type="button"
            className={mode === 'multi' ? 'chip on' : 'chip'}
            onClick={() => onMode('multi')}
            disabled={busy}
          >
            Multi-repeater
          </button>
          <button
            type="button"
            className={mode === 'check' ? 'chip on' : 'chip'}
            onClick={() => onMode('check')}
            disabled={busy}
          >
            Coverage check
          </button>
          <button
            type="button"
            className={mode === 'mesh' ? 'chip on' : 'chip'}
            onClick={() => onMode('mesh')}
            disabled={busy}
          >
            Mesh import
          </button>
        </div>
      </section>

      {mode !== 'check' && mode !== 'mesh' && (
      <section>
        <h2>Region</h2>
        <div className="row">
          <button type="button" className={drawing ? 'primary' : ''} onClick={onDraw} disabled={busy}>
            {drawing ? 'Tap two corners on the map' : 'Draw area'}
          </button>
          <button type="button" onClick={onClear} disabled={busy || (!bbox && sites.length === 0)}>
            Clear
          </button>
        </div>
        {drawing && (
          <p className="muted">
            Tap one corner of the area, then tap the opposite corner. Same with a mouse click.
          </p>
        )}
        {size && (
          <p className="muted">
            {size.widthKm.toFixed(1)} × {size.heightKm.toFixed(1)} km
          </p>
        )}
        {warn && !tooBig && (
          <p className="warn">Large area — search will use a coarser grid and take longer.</p>
        )}
        {tooBig && (
          <p className="warn">
            Area is over {MAX_REGION_KM} km on a side. Draw a smaller box.
          </p>
        )}
      </section>
      )}

      <section>
        <h2>Radio</h2>
        <div className="row">
          <button
            type="button"
            className={radio.frequencyMhz < 900 ? 'chip on' : 'chip'}
            onClick={() => onRadio({ ...radio, ...PRESETS.eu })}
          >
            EU 868
          </button>
          <button
            type="button"
            className={radio.frequencyMhz >= 900 ? 'chip on' : 'chip'}
            onClick={() => onRadio({ ...radio, ...PRESETS.us })}
          >
            US 915
          </button>
        </div>
        <Field
          label="Frequency"
          value={radio.frequencyMhz}
          onChange={(frequencyMhz) => onRadio({ ...radio, frequencyMhz })}
          step={0.1}
          unit="MHz"
        />
        <Field
          label="TX power"
          value={radio.txPowerDbm}
          onChange={(txPowerDbm) => onRadio({ ...radio, txPowerDbm })}
          step={1}
          unit="dBm"
        />
        <Field
          label="TX antenna gain"
          value={radio.txGainDbi}
          onChange={(txGainDbi) => onRadio({ ...radio, txGainDbi })}
          step={0.1}
          unit="dBi"
        />
        <Field
          label="TX height AGL"
          value={radio.txHeightM}
          onChange={(txHeightM) => onRadio({ ...radio, txHeightM })}
          step={0.5}
          unit="m"
        />
        <Field
          label="RX height AGL"
          value={radio.rxHeightM}
          onChange={(rxHeightM) => onRadio({ ...radio, rxHeightM })}
          step={0.5}
          unit="m"
        />
        <Field
          label="RX antenna gain"
          value={radio.rxGainDbi}
          onChange={(rxGainDbi) => onRadio({ ...radio, rxGainDbi })}
          step={0.1}
          unit="dBi"
        />
        <Field
          label="RX cutoff"
          value={radio.cutoffDbm}
          onChange={(cutoffDbm) => onRadio({ ...radio, cutoffDbm })}
          step={1}
          unit="dBm"
        />
      </section>

      <section>
        <h2>Overlay</h2>
        <div className="row">
          {(['red', 'green', 'blue'] as const).map((color) => (
            <button
              key={color}
              type="button"
              className={overlayStyle === color ? 'chip on' : 'chip'}
              onClick={() => onOverlayStyle(color)}
            >
              <span className={`swatch swatch-${color}`} />
              {color === 'red' ? 'Red' : color === 'green' ? 'Green' : 'Blue'}
            </button>
          ))}
          {mode === 'multi' && (
            <button
              type="button"
              className={overlayStyle === 'heatmap' ? 'chip on' : 'chip'}
              onClick={() => onOverlayStyle('heatmap')}
            >
              Heatmap
            </button>
          )}
        </div>
        {mode === 'multi' && overlayStyle === 'heatmap' && (
          <div className="heat-legend">
            <span>
              {overlayCutoffDbm} dBm
            </span>
            <div className="heat-bar" aria-hidden />
            <span>
              {overlayCutoffDbm + HEATMAP_SPAN_DB} dBm
            </span>
          </div>
        )}
        <p className="muted">
          {mode === 'multi' && overlayStyle === 'heatmap'
            ? 'Heatmap is estimated RSSI from the strongest mast with line of sight (free-space), not a live survey.'
            : 'Single-colour overlay marks predicted coverage. Heatmap is available in multi-repeater after a plan.'}
        </p>
      </section>

      {mode === 'rank' ? (
        <section>
          <h2>Results</h2>
          <div className="row">
            {([5, 10, 20, 30] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={siteCount === n ? 'chip on' : 'chip'}
                onClick={() => onSiteCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <Field
            label="Best sites"
            value={siteCount}
            onChange={(n) => onSiteCount(n)}
            step={1}
            min={1}
            max={40}
            unit="sites"
          />
        </section>
      ) : mode === 'multi' ? (
        <section>
          <h2>New repeaters</h2>
          <div className="row">
            {([2, 3, 4, 5] as const).map((n) => (
              <button
                key={n}
                type="button"
                className={repeaterCount === n ? 'chip on' : 'chip'}
                onClick={() => onRepeaterCount(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <Field
            label="Place"
            value={repeaterCount}
            onChange={(n) => onRepeaterCount(n)}
            step={1}
            min={1}
            max={12}
            unit="new"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={useExisting}
              onChange={(e) => onUseExisting(e.target.checked)}
            />
            Include existing nodes
          </label>
          {useExisting && (
            <>
              <button
                type="button"
                className={placingExisting ? 'primary' : ''}
                onClick={onPlacingExisting}
                disabled={busy}
              >
                {placingExisting ? 'Tap the map to drop a node' : 'Tap map to add existing node'}
              </button>
              <div className="coord-row">
                <input
                  type="number"
                  step="0.00001"
                  placeholder="Lat"
                  value={addLat}
                  onChange={(e) => setAddLat(e.target.value)}
                />
                <input
                  type="number"
                  step="0.00001"
                  placeholder="Lon"
                  value={addLon}
                  onChange={(e) => setAddLon(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => {
                    const lat = Number(addLat)
                    const lon = Number(addLon)
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
                    onAddExistingCoords(lat, lon)
                    setAddLat('')
                    setAddLon('')
                  }}
                >
                  Add
                </button>
              </div>
              {existingNodes.length > 0 && (
                <ul className="results">
                  {existingNodes.map((node, i) => (
                    <li key={node.id}>
                      <div className="result existing-row">
                        <strong>E{i + 1}</strong>
                        <span className="muted">
                          {node.lat.toFixed(5)}, {node.lon.toFixed(5)}
                        </span>
                        <button type="button" onClick={() => onRemoveExisting(node.id)}>
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      ) : mode === 'check' ? (
        <section>
          <h2>Your node</h2>
          <p className="muted">
            Tap the map to drop or move the transmitter. You can also type coordinates.
          </p>
          <div className="row">
            <button type="button" onClick={onClear} disabled={busy || (!probe && coveredKm2 === null)}>
              Clear
            </button>
          </div>
          <div className="coord-row">
            <input
              type="number"
              step="0.00001"
              placeholder="Lat"
              value={addLat}
              onChange={(e) => setAddLat(e.target.value)}
            />
            <input
              type="number"
              step="0.00001"
              placeholder="Lon"
              value={addLon}
              onChange={(e) => setAddLon(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const lat = Number(addLat)
                const lon = Number(addLon)
                if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
                onAddExistingCoords(lat, lon)
                setAddLat('')
                setAddLon('')
              }}
            >
              Place
            </button>
          </div>
          {probe && (
            <p className="muted">
              TX {probe.lat.toFixed(5)}, {probe.lon.toFixed(5)}
            </p>
          )}
        </section>
      ) : (
        <section>
          <h2>Companion radio</h2>
          <p className="experimental">
            Experimental. USB talks to the radio from this browser (Chrome/Edge).
            IP on a public site cannot use your home 192.168 address from the web
            server — run the PowerShell helper on this PC so TCP stays on your LAN.
            Only saved repeater and room-server contacts with coordinates are
            plotted. Coverage is a generic terrain estimate, not a live RF survey.
          </p>
          <div className="row">
            <button type="button" onClick={onUsbImport} disabled={busy}>
              Connect USB
            </button>
            <button type="button" onClick={onClear} disabled={busy || meshNodes.length === 0}>
              Clear
            </button>
          </div>
          {usbBlock && <p className="warn">{usbBlock}</p>}
          <p className="muted">
            Close the official MeshCore app first — companion Wi‑Fi usually allows
            only one TCP client. Then companion_radio_wifi IPv4 on this PC’s LAN
            (port 5000):
          </p>
          <div className="coord-row">
            <input
              type="text"
              placeholder="192.168.x.x"
              value={meshHost}
              onChange={(e) => setMeshHost(e.target.value)}
            />
            <input
              type="number"
              placeholder="Port"
              value={meshPort}
              onChange={(e) => setMeshPort(e.target.value)}
              style={{ width: 72, flex: '0 0 72px' }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => onIpImport(meshHost, Number(meshPort), viaServerLan)}
            >
              Connect IP
            </button>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={viaServerLan}
              onChange={(e) => setViaServerLan(e.target.checked)}
            />
            Radio is on the website server’s LAN (not this PC)
          </label>
          {helperCommand && (
            <div className="helper-box">
              <p className="warn">
                Paste this into PowerShell on this PC (the window that already shows
                PS C:\...) and leave it open. Do not wrap it in another powershell
                -Command — that strips the script.
              </p>
              <textarea className="helper-cmd" readOnly rows={5} value={helperCommand} />
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(helperCommand)}
              >
                Copy helper command
              </button>
            </div>
          )}
          {meshNodes.length > 0 && (
            <ul className="results">
              {meshNodes.map((node, i) => (
                <li key={node.id}>
                  <div className="result existing-row">
                    <strong>R{i + 1}</strong>
                    <span className="muted">
                      {node.name} · {node.kind === 'room' ? 'room' : 'repeater'} ·{' '}
                      {node.lat.toFixed(4)}, {node.lon.toFixed(4)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <button
        type="button"
        className="primary search-btn"
        onClick={onSearch}
        disabled={
          busy ||
          (mode === 'mesh'
            ? meshNodes.length === 0
            : mode === 'check'
              ? !probe
              : !bbox || tooBig)
        }
      >
        {busy
          ? 'Working…'
          : mode === 'mesh'
            ? 'Show combined coverage'
            : mode === 'check'
              ? 'Show coverage'
              : mode === 'multi'
                ? `Plan ${repeaterCount} new repeaters`
                : `Find ${siteCount} best sites`}
      </button>
      {progress && <p className="muted">{progress}</p>}
      {error && <p className="warn">{error}</p>}
      {mode === 'multi' && existingPct !== null && (
        <p className="muted">
          Existing nodes cover {existingPct.toFixed(0)}% of the square. With new masts:{' '}
          {finalPct?.toFixed(0)}%.
        </p>
      )}
      {mode === 'check' && coveredKm2 !== null && (
        <p className="muted">Predicted land coverage about {coveredKm2.toFixed(1)} km².</p>
      )}
      {mode === 'mesh' && coveredKm2 !== null && (
        <p className="muted">
          Combined estimate about {coveredKm2.toFixed(1)} km² from {meshNodes.length} located
          node{meshNodes.length === 1 ? '' : 's'}.
        </p>
      )}

      {sites.length > 0 && mode !== 'check' && mode !== 'mesh' && (
        <section>
          <h2>{mode === 'multi' ? `New repeaters (${sites.length})` : `Top ${sites.length} sites`}</h2>
          <ul className="results">
            {sites.map((site) => (
              <li key={site.rank}>
                <button
                  type="button"
                  className={site.rank === selectedRank ? 'result on' : 'result'}
                  onClick={() => onSelect(site.rank)}
                >
                  <strong>#{site.rank}</strong>
                  <span>
                    {mode === 'multi'
                      ? `Area after this mast ${site.coveredPct.toFixed(0)}%`
                      : `${site.coveredKm2.toFixed(1)} km² · ${site.coveredPct.toFixed(0)}%`}
                  </span>
                  <span className="muted">
                    {site.lat.toFixed(5)}, {site.lon.toFixed(5)} · {Math.round(site.elevM)} m
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="footnote">
        {mode === 'mesh'
          ? 'Experimental MeshCore import: USB is Web Serial in this browser. IP uses a helper on the site host to open TCP (private IPv4 only). Repeaters without lat/lon are skipped. DEM is ground elevation, not buildings or trees.'
          : mode === 'check'
            ? 'Heatmap is terrain line-of-sight with 4/3 Earth radius plus free-space path loss, out to the radio’s link budget. DEM is ground elevation, not buildings or trees.'
            : 'Pins stay inside the dashed square. Multi-repeater uses a greedy fill: existing nodes first, then new masts that cover the most remaining gaps. DEM is ground elevation, not buildings.'}
      </p>
    </aside>
  )
}

import type { BBox, RadioParams, RankedSite } from '../types'
import { MAX_REGION_KM, WARN_REGION_KM, bboxSizeKm } from '../lib/geo'

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
}: Props) {
  const size = bbox ? bboxSizeKm(bbox) : null
  const tooBig = size ? size.maxSideKm > MAX_REGION_KM : false
  const warn = size ? size.maxSideKm > WARN_REGION_KM : false

  return (
    <aside className="panel">
      <header className="panel-header">
        <h1>Antenna site planner</h1>
        <p>
          Draw a region, set mast and radio values, then rank high ground by MeshCore-style
          LoRa land coverage.
        </p>
      </header>

      <section>
        <h2>Region</h2>
        <div className="row">
          <button type="button" className={drawing ? 'primary' : ''} onClick={onDraw} disabled={busy}>
            {drawing ? 'Click and drag on the map' : 'Draw area'}
          </button>
          <button type="button" onClick={onClear} disabled={busy || (!bbox && sites.length === 0)}>
            Clear
          </button>
        </div>
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

      <button
        type="button"
        className="primary search-btn"
        onClick={onSearch}
        disabled={busy || !bbox || tooBig}
      >
        {busy ? 'Working…' : `Find ${siteCount} best sites`}
      </button>
      {progress && <p className="muted">{progress}</p>}
      {error && <p className="warn">{error}</p>}

      {sites.length > 0 && (
        <section>
          <h2>Top {sites.length} sites</h2>
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
                    {site.coveredKm2.toFixed(1)} km² · {site.coveredPct.toFixed(0)}%
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
        Pins are chosen inside the dashed square. The heatmap shows predicted reach
        beyond that square. Terrain line-of-sight with 4/3 Earth radius plus free-space
        path loss. DEM is ground elevation, not buildings.
      </p>
    </aside>
  )
}

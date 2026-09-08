import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { BBox, RankedSite } from '../types'

type Props = {
  drawing: boolean
  bbox: BBox | null
  onBbox: (bbox: BBox) => void
  onDrawEnd: () => void
  sites: RankedSite[]
  selectedRank: number | null
  onSelect: (rank: number) => void
  overlayUrl: string | null
  overlayBounds: BBox | null
}

function toLeafletBounds(bbox: BBox): L.LatLngBounds {
  return L.latLngBounds(
    [bbox.south, bbox.west],
    [bbox.north, bbox.east],
  )
}

export function MapView({
  drawing,
  bbox,
  onBbox,
  onDrawEnd,
  sites,
  selectedRank,
  onSelect,
  overlayUrl,
  overlayBounds,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const rectRef = useRef<L.Rectangle | null>(null)
  const overlayRef = useRef<L.ImageOverlay | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const onBboxRef = useRef(onBbox)
  const onDrawEndRef = useRef(onDrawEnd)
  const onSelectRef = useRef(onSelect)
  onBboxRef.current = onBbox
  onDrawEndRef.current = onDrawEnd
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
    }).setView([53.4, -1.8], 7)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; OpenStreetMap &middot; Terrain AWS/Mapzen',
    }).addTo(map)

    markersRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    requestAnimationFrame(() => map.invalidateSize())

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    if (drawing) {
      map.dragging.disable()
      map.boxZoom.disable()
    } else {
      map.dragging.enable()
      map.boxZoom.enable()
    }

    let start: L.LatLng | null = null
    let temp: L.Rectangle | null = null

    const onDown = (e: L.LeafletMouseEvent) => {
      if (!drawing) return
      L.DomEvent.preventDefault(e.originalEvent)
      start = e.latlng
      temp?.remove()
      temp = L.rectangle(L.latLngBounds(start, start), {
        color: '#3ecf8e',
        weight: 2,
        fillOpacity: 0.08,
        dashArray: '6 4',
      }).addTo(map)
    }

    const onMove = (e: L.LeafletMouseEvent) => {
      if (!drawing || !start || !temp) return
      temp.setBounds(L.latLngBounds(start, e.latlng))
    }

    const onUp = (e: L.LeafletMouseEvent | MouseEvent) => {
      if (!drawing || !start) return
      const latlng =
        'latlng' in e ? e.latlng : map.mouseEventToLatLng(e as MouseEvent)
      const bounds = L.latLngBounds(start, latlng)
      start = null
      temp?.remove()
      temp = null
      if (bounds.getNorth() === bounds.getSouth() || bounds.getEast() === bounds.getWest()) {
        onDrawEndRef.current()
        return
      }
      onBboxRef.current({
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      })
      onDrawEndRef.current()
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    map.getContainer().style.cursor = drawing ? 'crosshair' : ''

    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      map.dragging.enable()
      map.boxZoom.enable()
      map.getContainer().style.cursor = ''
      temp?.remove()
    }
  }, [drawing])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    rectRef.current?.remove()
    rectRef.current = null
    if (!bbox) return
    const layer = L.rectangle(toLeafletBounds(bbox), {
      color: '#3ecf8e',
      weight: 2,
      fillOpacity: 0.02,
      dashArray: '8 5',
    }).addTo(map)
    rectRef.current = layer
    map.fitBounds(toLeafletBounds(bbox), { padding: [32, 32] })
  }, [bbox])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    overlayRef.current?.remove()
    overlayRef.current = null
    if (!overlayUrl || !overlayBounds) return
    overlayRef.current = L.imageOverlay(overlayUrl, toLeafletBounds(overlayBounds), {
      opacity: 0.85,
      interactive: false,
    }).addTo(map)
  }, [overlayUrl, overlayBounds])

  useEffect(() => {
    const group = markersRef.current
    if (!group) return
    group.clearLayers()
    for (const site of sites) {
      const selected = site.rank === selectedRank
      const icon = L.divIcon({
        className: 'site-marker',
        html: `<div class="site-marker-inner ${selected ? 'is-selected' : ''}">${site.rank}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      })
      const marker = L.marker([site.lat, site.lon], { icon, zIndexOffset: selected ? 1000 : 0 })
      marker.on('click', () => onSelectRef.current(site.rank))
      marker.bindTooltip(
        `#${site.rank} · ${site.coveredKm2.toFixed(1)} km² · ${Math.round(site.elevM)} m`,
      )
      group.addLayer(marker)
    }
  }, [sites, selectedRank])

  return <div ref={containerRef} className="map-canvas" />
}

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { BBox, ExistingNode, RankedSite } from '../types'

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
  placingExisting: boolean
  existingNodes: ExistingNode[]
  onAddExisting: (lat: number, lon: number) => void
  nodeMarkerStyle?: 'existing' | 'probe'
  fitOverlay?: boolean
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
  placingExisting,
  existingNodes,
  onAddExisting,
  nodeMarkerStyle = 'existing',
  fitOverlay = false,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const rectRef = useRef<L.Rectangle | null>(null)
  const overlayRef = useRef<L.ImageOverlay | null>(null)
  const markersRef = useRef<L.LayerGroup | null>(null)
  const existingRef = useRef<L.LayerGroup | null>(null)
  const lastProbeRef = useRef<string>('')
  const onBboxRef = useRef(onBbox)
  const onDrawEndRef = useRef(onDrawEnd)
  const onSelectRef = useRef(onSelect)
  const onAddExistingRef = useRef(onAddExisting)
  onBboxRef.current = onBbox
  onDrawEndRef.current = onDrawEnd
  onSelectRef.current = onSelect
  onAddExistingRef.current = onAddExisting

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = L.map(containerRef.current, {
      zoomControl: true,
      attributionControl: true,
      tapHold: false,
    }).setView([53.4, -1.8], 7)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; OpenStreetMap &middot; Terrain AWS/Mapzen',
    }).addTo(map)

    markersRef.current = L.layerGroup().addTo(map)
    existingRef.current = L.layerGroup().addTo(map)
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
      map.doubleClickZoom.disable()
    } else {
      map.dragging.enable()
      map.boxZoom.enable()
      map.doubleClickZoom.enable()
    }

    let corner: L.LatLng | null = null
    let temp: L.Rectangle | null = null
    let pin: L.CircleMarker | null = null

    const preview = (a: L.LatLng, b: L.LatLng) => {
      const bounds = L.latLngBounds(a, b)
      if (!temp) {
        temp = L.rectangle(bounds, {
          color: '#3ecf8e',
          weight: 2,
          fillOpacity: 0.08,
          dashArray: '6 4',
        }).addTo(map)
      } else {
        temp.setBounds(bounds)
      }
    }

    const finish = (a: L.LatLng, b: L.LatLng) => {
      const bounds = L.latLngBounds(a, b)
      corner = null
      temp?.remove()
      temp = null
      pin?.remove()
      pin = null
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

    const onClick = (e: L.LeafletMouseEvent) => {
      if (drawing) {
        L.DomEvent.preventDefault(e.originalEvent)
        L.DomEvent.stopPropagation(e.originalEvent)
        if (!corner) {
          corner = e.latlng
          pin?.remove()
          pin = L.circleMarker(e.latlng, {
            radius: 7,
            color: '#8ff0c0',
            weight: 2,
            fillColor: '#1f8a5b',
            fillOpacity: 1,
          }).addTo(map)
          return
        }
        finish(corner, e.latlng)
        return
      }
      if (placingExisting) {
        onAddExistingRef.current(e.latlng.lat, e.latlng.lng)
      }
    }

    const onMove = (e: L.LeafletMouseEvent) => {
      if (!drawing || !corner) return
      preview(corner, e.latlng)
    }

    map.on('click', onClick)
    map.on('mousemove', onMove)
    map.getContainer().style.cursor = drawing || placingExisting ? 'crosshair' : ''
    map.getContainer().classList.toggle('is-drawing', drawing || placingExisting)

    return () => {
      map.off('click', onClick)
      map.off('mousemove', onMove)
      map.dragging.enable()
      map.boxZoom.enable()
      map.doubleClickZoom.enable()
      map.getContainer().style.cursor = ''
      map.getContainer().classList.remove('is-drawing')
      temp?.remove()
      pin?.remove()
    }
  }, [drawing, placingExisting])

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
    if (fitOverlay) {
      map.fitBounds(toLeafletBounds(overlayBounds), { padding: [32, 32] })
    }
  }, [overlayUrl, overlayBounds, fitOverlay])

  useEffect(() => {
    const group = existingRef.current
    if (!group) return
    group.clearLayers()
    existingNodes.forEach((node, i) => {
      const probe = nodeMarkerStyle === 'probe'
      const label = probe ? 'TX' : `E${i + 1}`
      const icon = L.divIcon({
        className: 'site-marker',
        html: `<div class="site-marker-inner ${probe ? 'is-probe' : 'is-existing'}">${label}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      })
      const marker = L.marker([node.lat, node.lon], { icon, zIndexOffset: 800 })
      marker.bindTooltip(probe ? 'Your node' : `Existing E${i + 1}`)
      group.addLayer(marker)
    })
    const map = mapRef.current
    const last = existingNodes[existingNodes.length - 1]
    if (map && last && nodeMarkerStyle === 'probe') {
      const key = `${last.lat.toFixed(6)},${last.lon.toFixed(6)}`
      if (lastProbeRef.current !== key) {
        lastProbeRef.current = key
        map.panTo([last.lat, last.lon])
      }
    }
  }, [existingNodes, nodeMarkerStyle])

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

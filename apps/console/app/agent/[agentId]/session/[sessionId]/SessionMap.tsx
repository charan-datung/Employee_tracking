'use client';

import { useEffect, useRef } from 'react';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { BASEMAP_STYLE } from '../../../../../lib/tiles';
import { OUTCOME_COLORS, OUTCOME_LABELS } from '../../../../../lib/format';

export interface MapPing { lat: number; lng: number; at: string }
export interface MapVisit {
  lat: number;
  lng: number;
  outcome: string | null;
  clientName: string;
  clientLat: number | null;
  clientLng: number | null;
  geofenceRadiusM: number;
  withinGeofence: boolean | null;
  distanceM: number | null;
}

export interface SessionMapProps {
  open: { lat: number; lng: number } | null;
  close: { lat: number; lng: number } | null;
  pings: MapPing[];
  visits: MapVisit[];
}

// Circle approximation for a geofence radius. Drawn as a GeoJSON polygon
// because MapLibre's circle layer sizes in screen pixels, not metres — a
// pixel circle would lie about the geofence at every zoom level.
function circle(lat: number, lng: number, radiusM: number, steps = 64) {
  const coords: [number, number][] = [];
  const latR = radiusM / 111_320;
  const lngR = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i += 1) {
    const theta = (i / steps) * 2 * Math.PI;
    coords.push([lng + lngR * Math.cos(theta), lat + latR * Math.sin(theta)]);
  }
  return coords;
}

export function SessionMap(props: SessionMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);

  useEffect(() => {
    if (containerRef.current === null || mapRef.current !== null) return;
    let disposed = false;

    void (async () => {
      const { Map, Marker, Popup, NavigationControl, LngLatBounds } =
        await import('maplibre-gl');
      if (disposed || containerRef.current === null) return;

      const points: [number, number][] = [
        ...props.pings.map((p) => [p.lng, p.lat] as [number, number]),
        ...props.visits.map((v) => [v.lng, v.lat] as [number, number]),
      ];
      if (props.open !== null) points.push([props.open.lng, props.open.lat]);
      if (props.close !== null) points.push([props.close.lng, props.close.lat]);

      const map = new Map({
        container: containerRef.current,
        style: BASEMAP_STYLE as StyleSpecification,
        center: points[0] ?? [120.9822, 14.4512],
        zoom: 13,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl(), 'top-right');

      map.on('load', () => {
        // The trail.
        if (props.pings.length > 1) {
          map.addSource('trail', {
            type: 'geojson',
            data: {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: props.pings.map((p) => [p.lng, p.lat]),
              },
            },
          });
          map.addLayer({
            id: 'trail-line',
            type: 'line',
            source: 'trail',
            paint: { 'line-color': '#2563eb', 'line-width': 3, 'line-opacity': 0.75 },
          });
        }

        // Client geofences, so a miss is visible rather than asserted.
        const fences = props.visits.filter(
          (v) => v.clientLat !== null && v.clientLng !== null,
        );
        if (fences.length > 0) {
          map.addSource('fences', {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: fences.map((v) => ({
                type: 'Feature' as const,
                properties: { within: v.withinGeofence === true },
                geometry: {
                  type: 'Polygon' as const,
                  coordinates: [
                    circle(v.clientLat as number, v.clientLng as number, v.geofenceRadiusM),
                  ],
                },
              })),
            },
          });
          map.addLayer({
            id: 'fence-fill',
            type: 'fill',
            source: 'fences',
            paint: {
              'fill-color': ['case', ['get', 'within'], '#059669', '#dc2626'],
              'fill-opacity': 0.12,
            },
          });
          map.addLayer({
            id: 'fence-outline',
            type: 'line',
            source: 'fences',
            paint: {
              'line-color': ['case', ['get', 'within'], '#059669', '#dc2626'],
              'line-width': 1.5,
              'line-dasharray': [2, 2],
            },
          });
        }
      });

      const dot = (color: string, size: number, ring = '#fff'): HTMLDivElement => {
        const el = document.createElement('div');
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid ${ring};box-shadow:0 1px 3px rgba(0,0,0,.4)`;
        return el;
      };

      if (props.open !== null) {
        new Marker({ element: dot('#059669', 18) })
          .setLngLat([props.open.lng, props.open.lat])
          .setPopup(new Popup().setText('Check-in'))
          .addTo(map);
      }
      if (props.close !== null) {
        new Marker({ element: dot('#1f2937', 18) })
          .setLngLat([props.close.lng, props.close.lat])
          .setPopup(new Popup().setText('Check-out'))
          .addTo(map);
      }

      for (const visit of props.visits) {
        const color = OUTCOME_COLORS[visit.outcome ?? 'other'] ?? '#6b7280';
        new Marker({ element: dot(color, 13) })
          .setLngLat([visit.lng, visit.lat])
          .setPopup(
            new Popup().setHTML(
              `<strong>${visit.clientName}</strong><br/>${
                OUTCOME_LABELS[visit.outcome ?? ''] ?? 'Walang outcome'
              }${
                visit.distanceM !== null
                  ? `<br/>${Math.round(visit.distanceM)}m mula sa pin`
                  : ''
              }`,
            ),
          )
          .addTo(map);
      }

      if (points.length > 1) {
        const bounds = points.reduce(
          (acc, p) => acc.extend(p),
          new LngLatBounds(points[0], points[0]),
        );
        map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }
    })();

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [props.open, props.close, props.pings, props.visits]);

  return (
    <div>
      <div
        ref={containerRef}
        className="h-[480px] w-full rounded-2xl border border-gray-200"
      />
      <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-emerald-600" /> Check-in
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-gray-800" /> Check-out
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1 w-5 rounded bg-blue-600" /> GPS trail
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-dashed border-emerald-600 bg-emerald-100" />
          Geofence (loob)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full border border-dashed border-red-600 bg-red-100" />
          Geofence (labas)
        </span>
      </div>
    </div>
  );
}

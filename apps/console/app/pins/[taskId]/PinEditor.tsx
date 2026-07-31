'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { fixPinAction } from '../actions';

// Drag the marker, save. The saved position becomes the client's coordinates
// with geocode_confidence 'exact'.
//
// The map opens on the SUGGESTED position (the centroid of what the agents
// actually reported), showing the current pin and every agent report, so the
// reviewer can see why the task was raised before moving anything.

export interface PinEditorProps {
  clientId: string;
  currentLat: number | null;
  currentLng: number | null;
  suggestedLat: number;
  suggestedLng: number;
  reports: { lat: number; lng: number }[];
}

// OpenStreetMap raster via MapLibre — no API key, no vendor lock-in.
const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export function PinEditor(props: PinEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [position, setPosition] = useState({
    lat: props.suggestedLat,
    lng: props.suggestedLng,
  });
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (containerRef.current === null || mapRef.current !== null) return;
    let disposed = false;

    // maplibre-gl is browser-only and heavy; importing it here keeps it out
    // of the server bundle and off the first paint.
    void (async () => {
      const { Map, Marker, Popup, NavigationControl } = await import('maplibre-gl');
      if (disposed || containerRef.current === null) return;

      const map = new Map({
        container: containerRef.current,
        style: STYLE,
        center: [props.suggestedLng, props.suggestedLat],
        zoom: 17,
      });
      mapRef.current = map;
      map.addControl(new NavigationControl(), 'top-right');

      const dot = (color: string, size: number): HTMLDivElement => {
        const el = document.createElement('div');
        el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;`;
        return el;
      };

      // Where the pin sits today — the thing being corrected.
      if (props.currentLat !== null && props.currentLng !== null) {
        new Marker({ element: dot('#9ca3af', 14) })
          .setLngLat([props.currentLng, props.currentLat])
          .setPopup(new Popup().setText('Kasalukuyang pin'))
          .addTo(map);
      }

      // What the agents independently reported.
      for (const report of props.reports) {
        new Marker({ element: dot('#f59e0b', 10) })
          .setLngLat([report.lng, report.lat])
          .addTo(map);
      }

      // The draggable proposal.
      const draggable = new Marker({ draggable: true, color: '#059669' })
        .setLngLat([props.suggestedLng, props.suggestedLat])
        .addTo(map);
      draggable.on('dragend', () => {
        const { lat, lng } = draggable.getLngLat();
        setPosition({ lat, lng });
      });
    })();

    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [
    props.suggestedLat,
    props.suggestedLng,
    props.currentLat,
    props.currentLng,
    props.reports,
  ]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const result = await fixPinAction({
      clientId: props.clientId,
      lat: position.lat,
      lng: position.lng,
      note: note.trim().length > 0 ? note.trim() : null,
    });
    if (result.status === 'ok') {
      router.push('/pins');
      router.refresh();
      return;
    }
    setError(
      result.status === 'forbidden'
        ? 'Walang pahintulot. Field supervisor lang ang makakapag-ayos ng pin.'
        : 'Hindi na-save ang pin. Subukan ulit.',
    );
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      <div
        ref={containerRef}
        className="h-[420px] w-full rounded-2xl border border-gray-200"
      />

      <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-emerald-600" />
          Bagong pin (i-drag)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-gray-400" />
          Kasalukuyang pin
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-full bg-amber-500" />
          Ulat ng ahente ({props.reports.length})
        </span>
      </div>

      <p className="font-mono text-sm text-gray-500">
        {position.lat.toFixed(6)}, {position.lng.toFixed(6)}
      </p>

      <label className="block">
        <span className="text-sm font-medium text-gray-700">Tala (opsyonal)</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Hal. Kinumpirma sa 3 ulat ng ahente"
          className="mt-1 h-11 w-full rounded-xl border border-gray-300 px-3"
        />
      </label>

      {error !== null && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        className="h-12 w-full rounded-xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700 disabled:bg-gray-300"
      >
        {saving ? 'Sine-save…' : 'I-save ang pin (geocode: exact)'}
      </button>
    </div>
  );
}

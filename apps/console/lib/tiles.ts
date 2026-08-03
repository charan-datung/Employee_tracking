import type { StyleSpecification } from 'maplibre-gl';

// Basemap tiles. NEXT_PUBLIC_TILE_URL defaults to the public OpenStreetMap
// server, which is fine for development and NOT PERMITTED FOR PRODUCTION:
// the OSMF tile usage policy forbids apps with real traffic. Before Filemon's
// team uses this daily, point this at a provider whose terms allow it
// (MapTiler, Stadia) or a self-hosted Protomaps/PMTiles extract. Swapping it
// is one environment variable — no code change.
export const TILE_URL =
  process.env.NEXT_PUBLIC_TILE_URL ??
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_ATTRIBUTION =
  process.env.NEXT_PUBLIC_TILE_ATTRIBUTION ?? '© OpenStreetMap contributors';

export const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: [TILE_URL],
      tileSize: 256,
      attribution: TILE_ATTRIBUTION,
    },
  },
  layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
};

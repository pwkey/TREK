// [460-fork] Shared tile-layer presets — used by the in-map layer
// switcher AND the Settings → Map preset dropdown so the two stay
// in sync.
//
// `DEFAULT_TILE_URL` is what callers fall back to when the user
// hasn't picked one yet. Upstream defaulted to CartoDB Light, which
// renders roads almost invisibly on white — switched to standard
// OpenStreetMap so roads are immediately legible at any zoom.

export interface TilePreset {
  name: string
  url: string
}

export const MAP_PRESETS: TilePreset[] = [
  { name: 'OpenStreetMap', url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' },
  { name: 'OpenStreetMap DE', url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png' },
  { name: 'CartoDB Light', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png' },
  { name: 'CartoDB Dark', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png' },
  { name: 'Stadia Smooth', url: 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png' },
]

export const DEFAULT_TILE_URL = MAP_PRESETS[0].url

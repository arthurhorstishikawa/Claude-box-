import { Emitter } from '../core/events';
import type { FieldId } from '../climate/terrestrial';

export type DisplayMode = 'realistic' | 'enhanced';
export type Background = 'milkyway' | 'stars' | 'black';
export type LayerId = 'true' | FieldId | 'pop';

export interface ViewSettings {
  mode: DisplayMode;
  background: Background;
  orbits: boolean;
  trails: boolean;
  labels: boolean;
  /** Dots marking where planets and other bodies are when they are too small to see. */
  markers: boolean;
  hz: boolean;
  wind: boolean;
  clouds: boolean;
  layer: LayerId;
  bloom: boolean;
  quality: 'low' | 'medium' | 'high';
  /** Extra exposure (EV) applied on top of auto/fixed exposure. */
  ev: number;
  /**
   * How far the eye may adapt to darkness (maximum exposure, relative to daylight). Higher
   * values make night scenes brighter. Stars use the full dark-adapted sensitivity regardless.
   */
  adaptLimit: number;
}

export const view: ViewSettings = {
  mode: 'realistic',
  background: 'milkyway',
  orbits: true,
  trails: false,
  labels: true,
  markers: true,
  hz: false,
  wind: false,
  clouds: true,
  layer: 'true',
  bloom: true,
  quality: 'medium',
  ev: 0,
  adaptLimit: 5e4,
};

export const viewEvents = new Emitter<{ changed: keyof ViewSettings }>();

export function setView<K extends keyof ViewSettings>(k: K, v: ViewSettings[K]): void {
  view[k] = v;
  viewEvents.emit('changed', k);
}

export const LAYERS: { id: LayerId; label: string; unit: string; range: [number, number]; palette: 'turbo' | 'blueRed' | 'rain' | 'biome' }[] = [
  { id: 'true', label: 'True colour', unit: '', range: [0, 1], palette: 'turbo' },
  { id: 'Ts', label: 'Surface temperature', unit: 'K', range: [200, 330], palette: 'turbo' },
  { id: 'tAnnual', label: 'Annual mean temperature', unit: 'K', range: [200, 320], palette: 'turbo' },
  { id: 'precip', label: 'Precipitation', unit: 'mm/day', range: [0, 12], palette: 'rain' },
  { id: 'cloud', label: 'Cloud cover', unit: '%', range: [0, 1], palette: 'turbo' },
  { id: 'w', label: 'Water vapour', unit: 'kg/m²', range: [0, 60], palette: 'rain' },
  { id: 'wind', label: 'Wind speed', unit: 'm/s', range: [0, 30], palette: 'turbo' },
  { id: 'pAnom', label: 'Pressure anomaly', unit: 'hPa', range: [-2000, 2000], palette: 'blueRed' },
  { id: 'snow', label: 'Snow & land ice', unit: 'kg/m²', range: [0, 2000], palette: 'turbo' },
  { id: 'seaIce', label: 'Sea ice thickness', unit: 'm', range: [0, 5], palette: 'turbo' },
  { id: 'veg', label: 'Vegetation', unit: '%', range: [0, 1], palette: 'rain' },
  { id: 'biome', label: 'Biomes', unit: '', range: [0, 9], palette: 'biome' },
  { id: 'current', label: 'Ocean currents', unit: 'm/s', range: [0, 0.4], palette: 'turbo' },
  { id: 'albedo', label: 'Albedo', unit: '', range: [0, 0.8], palette: 'turbo' },
  { id: 'insol', label: 'Insolation', unit: 'W/m²', range: [0, 600], palette: 'turbo' },
  { id: 'habitable', label: 'Habitability', unit: '', range: [0, 1], palette: 'rain' },
  { id: 'elev', label: 'Elevation', unit: 'm', range: [-6000, 6000], palette: 'turbo' },
  { id: 'pop', label: 'Population', unit: '/km²', range: [0, 300], palette: 'turbo' },
];

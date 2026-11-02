import { YEAR } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import type { LatLonGrid } from './grid';

export type CivEra = 'agrarian' | 'industrial' | 'clean' | 'collapsed';

export const ERA_LABEL: Record<CivEra, string> = {
  agrarian: 'Agrarian',
  industrial: 'Industrial (fossil fuels)',
  clean: 'Post-carbon',
  collapsed: 'Collapsed',
};

/** What the civilization needs to know about its world each step. */
export interface CivWorld {
  grid: LatLonGrid;
  area: number;
  ocean: Float64Array;
  Ts: Float64Array;
  tAnnual: Float64Array;
  pAnnual: Float64Array;
  snow: Float64Array;
  veg: Float64Array;
  /** Breathable atmosphere (O2, CO2, pressure within human tolerances). */
  breathable: boolean;
  hasOcean: boolean;
  time: number;
}

export interface CivEffects {
  /** CO₂ added to the atmosphere this step (kg). */
  co2: number;
  /** Sulfate-aerosol optical depth to maintain. */
  aerosol: number;
}

/**
 * A planetary civilization living on the climate grid. Population per cell grows
 * logistically toward a carrying capacity set by local climate; industry emits CO₂ (with
 * partial ocean uptake) and sulfate aerosols, and clears forests. Climate catastrophes reduce
 * carrying capacity, so a civilization can be undone by the warming it causes.
 */
export class Civilization {
  pop: Float64Array;
  /**
   * Fraction of each cell's land that is lit urban area at night (≈0.01–0.02 for Earth-like
   * densities, up to ~0.3 for megacity regions). The renderer turns it into city clusters.
   */
  lights: Float64Array;
  era: CivEra;
  /** Technology level: 0..1 agrarian, 1..2 industrial, ≥2 post-carbon. */
  tech: number;
  totalPop = 0;
  peakPop = 0;
  /** Current CO₂ emissions, kg/s. */
  emissions = 0;
  cumulativeCO2 = 0;
  /** Anthropogenic CO₂ still in the atmosphere (kg), partially absorbed by oceans. */
  excessCO2 = 0;
  founded: number;
  name: string;
  version = 0;
  /** Policy: a carbon price cuts fossil emissions and speeds the clean-energy transition. */
  carbonTax = false;
  /** Policy: stratospheric sulfate injection maintained by the civilization (optical depth). */
  geoengineering = 0;
  /** Soot from a nuclear war, handed to the climate on the next step. */
  private soot = 0;
  private rng: Rng;
  private milestones = new Set<string>();
  onEvent: ((msg: string, kind: 'info' | 'warn' | 'danger') => void) | null = null;

  constructor(grid: LatLonGrid, mode: 'modern' | 'preindustrial' | 'emergent', time: number, seed = 7) {
    this.pop = new Float64Array(grid.N);
    this.lights = new Float64Array(grid.N);
    this.rng = new Rng(seed);
    this.era = mode === 'modern' ? 'industrial' : 'agrarian';
    this.tech = mode === 'modern' ? 1.55 : mode === 'preindustrial' ? 0.95 : 0.1;
    this.founded = time;
    this.name = mode === 'emergent' ? 'Emergent civilization' : 'Global civilization';
    if (mode === 'modern') this.excessCO2 = 0;
  }

  /** Resize per-cell arrays after a climate-grid change. */
  regrid(grid: LatLonGrid): void {
    if (this.pop.length === grid.N) return;
    const total = this.totalPop;
    this.pop = new Float64Array(grid.N);
    this.lights = new Float64Array(grid.N);
    this.totalPop = 0;
    this.seedPopulation = total;
  }

  /** Population to distribute on the next step (after creation or regrid). */
  seedPopulation = 0;
  /** Set on the step that placed the initial population (land use already exists). */
  justSeeded = false;

  private capacity(w: CivWorld, k: number): number {
    const j = Math.floor(k / w.grid.nLon);
    const land = 1 - w.ocean[k];
    if (land < 0.02) return 0;
    const T = w.tAnnual[k];
    const fT = Math.exp(-(((T - 289) / 13) ** 2));
    const pmm = w.pAnnual[k] * 86400;
    const fP = 0.15 + 0.85 * smoothstep(0.2, 2.0, pmm);
    const fIce = 1 - smoothstep(20, 400, w.snow[k]);
    const fVeg = 0.5 + 0.5 * w.veg[k];
    const fAtm = w.breathable ? 1 : this.tech >= 2 ? 0.05 : 0;
    // People per m² of good land; post-carbon societies stabilise (smaller families, ~10 bn on Earth).
    const density = this.tech < 1 ? 3e-5 : this.tech < 2 ? 1.6e-4 : 1.25e-4;
    const cellArea = w.grid.cellArea[j] * w.area * land;
    return cellArea * density * fT * fP * fIce * fVeg * fAtm;
  }

  step(dt: number, w: CivWorld): CivEffects {
    const N = w.grid.N;
    const yr = dt / YEAR;
    if (this.era === 'collapsed' && this.totalPop < 1) return { co2: 0, aerosol: 0 };
    // Seed population where conditions are best.
    if (this.seedPopulation > 0) {
      let kTot = 0;
      const ks = new Float64Array(N);
      for (let k = 0; k < N; k++) {
        ks[k] = this.capacity(w, k);
        kTot += ks[k];
      }
      if (kTot > 0) for (let k = 0; k < N; k++) this.pop[k] = (this.seedPopulation * ks[k]) / kTot;
      // Milestones already passed by the initial population are not news.
      for (const m of [1e8, 1e9, 1e10]) if (this.seedPopulation >= m) this.milestones.add(`pop${m}`);
      this.peakPop = Math.max(this.peakPop, this.seedPopulation);
      this.seedPopulation = 0;
      this.justSeeded = true;
    }
    // Logistic growth toward climate-limited capacity (exact solution, stable for any dt).
    const r = this.tech < 1 ? 0.004 : this.tech < 2 ? 0.02 : 0.008;
    let total = 0;
    let kSum = 0;
    for (let k = 0; k < N; k++) {
      const K = this.capacity(w, k);
      kSum += K;
      const n0 = this.pop[k];
      let n: number;
      if (K <= 1) n = n0 * Math.exp(-dt / (20 * YEAR));
      else if (n0 <= 0) n = 0;
      else n = K / (1 + ((K - n0) / n0) * Math.exp(-r * yr));
      this.pop[k] = n;
      total += n;
    }
    // Migration: people spread to neighbouring habitable cells.
    if (yr > 0.2) {
      const spread = Math.min(0.2, 0.01 * yr);
      const { nLat, nLon } = w.grid;
      const add = new Float64Array(N);
      for (let j = 0; j < nLat; j++)
        for (let i = 0; i < nLon; i++) {
          const k = j * nLon + i;
          const out = this.pop[k] * spread;
          if (out <= 0) continue;
          const nb = [j * nLon + ((i + 1) % nLon), j * nLon + ((i - 1 + nLon) % nLon), j > 0 ? k - nLon : k, j < nLat - 1 ? k + nLon : k];
          for (const q of nb) add[q] += out / 4;
          add[k] -= out;
        }
      for (let k = 0; k < N; k++) if (1 - w.ocean[k] > 0.02 || add[k] < 0) this.pop[k] = Math.max(0, this.pop[k] + add[k]);
    }
    this.totalPop = total;
    this.peakPop = Math.max(this.peakPop, total);
    // Technology advances with population; crises set it back.
    const stress = kSum > 0 ? clamp(total / kSum - 1, 0, 1) : 1;
    if (this.era !== 'collapsed') {
      const rate = this.tech < 1 ? 2e-4 * Math.log10(1 + total / 1e6) : this.tech < 2 ? 3e-3 * (this.carbonTax ? 2.5 : 1) : 4e-4;
      this.tech += rate * yr * (1 - stress);
    }
    const prevEra = this.era;
    if (total < 1e4 && this.peakPop > 1e6) this.era = 'collapsed';
    else if (this.tech >= 2) this.era = 'clean';
    else if (this.tech >= 1) this.era = 'industrial';
    else this.era = 'agrarian';
    if (prevEra !== this.era) {
      if (this.era === 'industrial') this.onEvent?.('Industrial revolution: fossil fuels are being burned.', 'warn');
      if (this.era === 'clean') this.onEvent?.('The civilization has transitioned to carbon-free energy.', 'info');
      if (this.era === 'collapsed') this.onEvent?.('Civilization has collapsed — its climate became uninhabitable.', 'danger');
    }
    for (const m of [1e8, 1e9, 1e10]) {
      const key = `pop${m}`;
      if (total >= m && !this.milestones.has(key)) {
        this.milestones.add(key);
        this.onEvent?.(`Population passed ${m >= 1e9 ? m / 1e9 + ' billion' : m / 1e6 + ' million'}.`, 'info');
      }
    }
    if (total < 0.5 * this.peakPop && this.peakPop > 1e9 && !this.milestones.has('halved')) {
      this.milestones.add('halved');
      this.onEvent?.('Population has halved from its peak as the climate deteriorates.', 'danger');
    }
    // Emissions: per-capita CO₂ (t/yr) by era.
    const perCapita = (this.era === 'industrial' ? 4.8 * smoothstep(1, 1.15, this.tech) * (1 - smoothstep(1.7, 2, this.tech)) : this.era === 'agrarian' ? 0.02 : 0) * (this.carbonTax && this.era === 'industrial' ? 0.35 : 1);
    this.emissions = (total * perCapita * 1000) / YEAR;
    const co2 = this.emissions * dt;
    this.cumulativeCO2 += co2;
    // Ocean uptake: about 78% of emitted CO₂ is eventually absorbed (centuries); the rest stays
    // airborne until rock weathering removes it over ~100 kyr. `excessCO2` is the absorbable
    // part still in the air.
    this.excessCO2 += 0.78 * co2;
    let absorbed = 0;
    if (w.hasOcean && this.excessCO2 > 0) {
      absorbed = this.excessCO2 * (1 - Math.exp(-dt / (150 * YEAR)));
      this.excessCO2 -= absorbed;
    }
    let aerosol = this.era === 'industrial' ? 0.012 * (this.emissions / ((4e13 / YEAR) || 1)) : 0;
    if (this.era !== 'collapsed') aerosol = Math.max(aerosol, this.geoengineering);
    if (this.soot > 0) {
      aerosol = Math.max(aerosol, this.soot);
      this.soot = 0;
    }
    // Night lights: urban dwellers × built-up area per dweller, as a fraction of the land.
    const urbanization = this.era === 'agrarian' ? 0.06 : this.era === 'collapsed' ? 0 : this.era === 'clean' ? 0.72 : 0.3 + 0.25 * smoothstep(1, 1.8, this.tech);
    const litPerPerson = this.era === 'agrarian' ? 60 : 380; // m² of lit built-up land per urban dweller
    for (let k = 0; k < N; k++) {
      const j = Math.floor(k / w.grid.nLon);
      const land = Math.max(1 - w.ocean[k], 0.05);
      const dens = this.pop[k] / Math.max(w.grid.cellArea[j] * w.area * land, 1);
      this.lights[k] = clamp(dens * urbanization * litPerPerson, 0, 0.35);
    }
    this.version++;
    return { co2: co2 - absorbed, aerosol };
  }

  /**
   * Nuclear war: cities burn, most of the population dies, technology is set back, and smoke
   * lofted into the stratosphere darkens the sky for years (nuclear winter).
   */
  nuclearWar(): void {
    for (let k = 0; k < this.pop.length; k++) this.pop[k] *= this.lights[k] > 0.02 ? 0.25 : 0.6;
    this.totalPop = this.pop.reduce((s, x) => s + x, 0);
    this.tech = Math.max(0.6, this.tech - 0.6);
    this.soot = 2.5;
    this.onEvent?.('Nuclear war! Burning cities fill the stratosphere with soot — a nuclear winter is coming.', 'danger');
    this.version++;
  }

  /** Fraction of forest cleared in a cell for farms and cities. */
  clearing(k: number, grid: LatLonGrid, area: number): number {
    const j = Math.floor(k / grid.nLon);
    const dens = this.pop[k] / Math.max(grid.cellArea[j] * area, 1);
    // Post-carbon societies farm more intensively and let forests return.
    return clamp(dens / 8e-5, 0, 0.7) * (this.era === 'clean' ? 0.6 : 1);
  }

  serialize(): unknown {
    return {
      pop: Array.from(this.pop, (x) => Math.round(x)),
      era: this.era,
      tech: this.tech,
      peakPop: this.peakPop,
      cumulativeCO2: this.cumulativeCO2,
      excessCO2: this.excessCO2,
      founded: this.founded,
      name: this.name,
      milestones: [...this.milestones],
      carbonTax: this.carbonTax,
      geoengineering: this.geoengineering,
    };
  }

  restore(o: any): void {
    if (!o) return;
    if (o.pop?.length === this.pop.length) this.pop.set(o.pop);
    else this.seedPopulation = (o.pop ?? []).reduce((s: number, x: number) => s + x, 0);
    this.era = o.era ?? this.era;
    this.tech = o.tech ?? this.tech;
    this.peakPop = o.peakPop ?? 0;
    this.cumulativeCO2 = o.cumulativeCO2 ?? 0;
    this.excessCO2 = o.excessCO2 ?? 0;
    this.founded = o.founded ?? 0;
    this.name = o.name ?? this.name;
    for (const m of o.milestones ?? []) this.milestones.add(m);
    this.carbonTax = !!o.carbonTax;
    this.geoengineering = o.geoengineering ?? 0;
  }

  void(): void {
    void this.rng;
  }
}

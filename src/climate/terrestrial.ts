import { DAY, G, G_EARTH, HOUR, R_GAS, SIGMA, YEAR } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { spectralFractions } from '../stars/blackbody';
import {
  bulkFromMasses,
  dryOpticalDepth,
  GAS_ORDER,
  gasFrostPoint,
  GASES,
  moistOLRLimit,
  rayleighDepth,
  vapourOpticalDepth,
  VOLATILES,
  type BulkAtmosphere,
  type GasId,
  type VolatileProps,
} from './atmosphere';
import { Circulation } from './circulation';
import { LatLonGrid, regrid } from './grid';
import { plantAlbedo } from './life';
import { Civilization } from './civilization';
import { History } from './history';
import { computeInsolation, dailyMean, type Illuminator } from './insolation';
import { StormSystem } from './storms';
import { applyCrater, cloneTerrain, generateTerrain, type CraterRecord, type TerrainMap, type TerrainStyle } from './terrain';

export type ClimateResolution = 'low' | 'medium' | 'high' | 'ultra';
/** Model tier: full weather, seasonal (daily-mean sunlight, no storms) or simple (latitude bands). */
export type ClimateMode = 'weather' | 'seasonal' | 'simple';
/** Steps longer than this use the simple latitude-band model. */
export const SIMPLE_DT = 45 * 86_400;
export const RES_NLAT: Record<ClimateResolution, number> = { low: 24, medium: 36, high: 48, ultra: 64 };

const BARREN_ALBEDO: Record<TerrainStyle, [number, number]> = {
  earthlike: [0.2, 0.36],
  oceanic: [0.2, 0.34],
  continental: [0.2, 0.38],
  marslike: [0.12, 0.26],
  venuslike: [0.12, 0.2],
  moonlike: [0.07, 0.16],
  mercurylike: [0.08, 0.15],
  europalike: [0.45, 0.7],
  ganymedelike: [0.25, 0.5],
  callistolike: [0.15, 0.35],
  iolike: [0.35, 0.75],
  titanlike: [0.08, 0.25],
  plutolike: [0.3, 0.9],
  tritonlike: [0.55, 0.85],
  asteroid: [0.05, 0.2],
  lavaworld: [0.08, 0.15],
};

export interface ClimateContext {
  illum: Illuminator[];
  g: number;
  R: number;
  mass: number;
  /** Signed sidereal rotation rate (rad/s). */
  omega: number;
  /** Solar day relative to the main star (s); Infinity when tidally locked. */
  synodicDay: number;
  orbitPeriod: number;
  /** Total internal heat flux (W/m²) = geothermal + tidal + impact heat. */
  internalHeat: number;
  /** Geothermal part only (drives volcanic outgassing). */
  geothermal: number;
  time: number;
  realDt: number;
  storms: boolean;
  geology: boolean;
  locked: boolean;
}

export interface WorldInit {
  atmosphere: Record<string, number>;
  waterGEL: number;
  volatile: 'H2O' | 'CH4';
  biosphere: boolean;
  terrain: TerrainStyle;
  terrainSeed: number;
  haze?: number;
  dust?: number;
  initialTemp?: number;
  iceCapLat?: number;
}

export interface ClimateStats {
  meanT: number;
  minT: number;
  maxT: number;
  meanTa: number;
  P: number;
  pp: Record<string, number>;
  oceanFrac: number;
  iceFrac: number;
  seaIceFrac: number;
  snowFrac: number;
  cloudFrac: number;
  albedo: number;
  asr: number;
  olr: number;
  insolation: number;
  precip: number;
  seaLevel: number;
  habitable: number;
  humanHabitable: number;
  vegetation: number;
  waterGEL: number;
  vapourGEL: number;
  oceanGEL: number;
  iceGEL: number;
  frostGEL: number;
  magmaFrac: number;
  greenhouse: number;
  tauIR: number;
  runaway: boolean;
  snowball: boolean;
  subsurfaceOcean: boolean;
  dustTau: number;
  aerosolTau: number;
  hadleyEdge: number;
  nCells: number;
  equatorPoleDT: number;
  boilingPoint: number;
}

/** Equirectangular layers the renderer and map can display. */
export const BIOMES = ['Ocean', 'Ice', 'Tundra', 'Boreal forest', 'Temperate forest', 'Grassland', 'Desert', 'Savanna', 'Rainforest', 'Barren'] as const;
export const LIFE_STAGES = ['Lifeless', 'Microbial', 'Oxygenic photosynthesis', 'Land plants', 'Complex animals'] as const;

export type FieldId =
  | 'Ts'
  | 'Ta'
  | 'precip'
  | 'cloud'
  | 'w'
  | 'snow'
  | 'seaIce'
  | 'ocean'
  | 'veg'
  | 'pAnom'
  | 'wind'
  | 'insol'
  | 'albedo'
  | 'habitable'
  | 'elev'
  | 'tAnnual'
  | 'frost'
  | 'current'
  | 'biome';

/**
 * Column vapour budget over dt:  dw/dt = kE·(ws − w)  +  S  −  kC·(w − wc)⁺
 * (kE: unlimited evaporation coefficient, S: supply-limited evaporation rate, kC: condensation).
 * Solved exactly (piecewise exponential). Returns [w(dt), total evaporation, total condensation].
 */
function relaxColumn(w0: number, ws: number, wc: number, kE: number, kC: number, S: number, dt: number): [number, number, number] {
  let w = w0;
  let t = 0;
  let E = 0;
  if (w < wc) {
    if (kE <= 0 && S <= 0) return [w, 0, 0];
    let tStar: number;
    if (kE > 0) {
      const Winf = ws + S / kE;
      tStar = Winf - wc > 1e-12 ? Math.log((Winf - w0) / (Winf - wc)) / kE : Infinity;
      if (!(tStar < dt)) {
        const wn = Winf - (Winf - w0) * Math.exp(-kE * dt);
        return [wn, wn - w0, 0];
      }
    } else {
      tStar = (wc - w0) / S;
      if (!(tStar < dt)) return [w0 + S * dt, S * dt, 0];
    }
    E += wc - w0;
    w = wc;
    t = tStar;
  }
  const rem = dt - t;
  const B = kE + kC;
  if (B <= 0) return [w + S * rem, E + S * rem, 0];
  const wStar = (kE * ws + kC * wc + S) / B;
  const e = Math.exp(-B * rem);
  const wn = wStar + (w - wStar) * e;
  const Iw = wStar * rem + ((w - wStar) * (1 - e)) / B;
  const C = Math.max(0, kC * (Iw - wc * rem));
  return [wn, E + (wn - w) + C, C];
}

/**
 * Gridded climate model for rocky/icy worlds (see docs/PLAN.md §4).
 * Two heat reservoirs per column (surface layer + atmosphere/deep), gray radiative transfer,
 * implicit transport, hydrology with sea level, frost caps, storms and long-term geochemistry.
 */
export class TerrestrialClimate {
  grid!: LatLonGrid;
  res: ClimateResolution = 'low';
  vol: VolatileProps;
  terrain!: TerrainMap;
  craters: CraterRecord[] = [];
  terrainVersion = 0;
  style: TerrainStyle;
  seed: number;
  biosphere: boolean;
  hazeBase: number;
  dustBase: number;

  // per-cell terrain
  elev!: Float64Array;
  material!: Float64Array;
  private samples!: Float32Array;
  private S = 24;
  private histW!: Float64Array;
  private histWE!: Float64Array;
  private histE0 = 0;
  private histDE = 1;
  private histTotW = 0;

  // prognostic
  Ts!: Float64Array;
  Ta!: Float64Array;
  snow!: Float64Array;
  seaIce!: Float64Array;
  w!: Float64Array;
  soil!: Float64Array;
  veg!: Float64Array;
  frost!: Float64Array;
  // diagnostic
  ocean!: Float64Array;
  insol!: Float64Array;
  albedo!: Float64Array;
  asr!: Float64Array;
  olr!: Float64Array;
  cloud!: Float64Array;
  precip!: Float64Array;
  evap!: Float64Array;
  habitable!: Float64Array;
  stormFactor!: Float64Array;
  tAnnual!: Float64Array;
  tMonth!: Float64Array;
  tWarm!: Float64Array;
  tCold!: Float64Array;
  pAnnual!: Float64Array;
  circ!: Circulation;
  /** Wind-driven ocean surface currents (m/s): Sverdrup gyres with western boundary currents. */
  uo!: Float64Array;
  vo!: Float64Array;
  /** Eruptions since the last time the simulation collected them (for effects and news). */
  eruptions: { lat: number; lon: number; vei: number }[] = [];
  /** Running clock for random eruptions. */
  private eruptClock = 0;
  storms: StormSystem;
  private C1!: Float64Array;
  private C2!: Float64Array;
  private oceanMask!: Float64Array;
  private kEocean!: Float64Array;
  private wsCache!: Float64Array;
  private kEland!: Float64Array;
  private A1!: Float64Array;
  private R1!: Float64Array;
  private A2!: Float64Array;
  private R2!: Float64Array;
  private Dcap!: Float64Array;
  Bc!: Float64Array;
  LEc!: Float64Array;
  dLEc!: Float64Array;
  LPc!: Float64Array;
  Gcc!: Float64Array;
  private snowfall!: Float64Array;
  private ecap!: Float64Array;
  private dLand!: Float64Array;
  private landMask!: Float64Array;

  gas: Record<GasId, number>;
  frostGas: GasId | null = null;
  waterTotal: number;
  seaLevel = 0;
  aerosol = 0;
  dust = 0;
  P = 0;
  bulk!: BulkAtmosphere;
  version = 0;
  history = new History();
  stats: ClimateStats;
  mode: ClimateMode = 'seasonal';
  civ: Civilization | null = null;
  /** True while settling the initial state: no biosphere carbon exchange. */
  spinningUp = false;
  /** Clock for biosphere emergence checks (s of habitable, living conditions). */
  lifeClock = 0;
  /** 0 lifeless, 1 microbes, 2 oxygenic photosynthesis, 3 land plants, 4 complex animals. */
  lifeStage = 0;
  /** Years of continuously hostile conditions (for extinctions). */
  private hostileYears = 0;
  /** Years spent (in good conditions) in the current stage of evolution. */
  lifeProgress = 0;
  /** Continental drift elapsed (Myr) and the amount the current terrain reflects. */
  driftMyr = 0;
  driftApplied = 0;
  private driftRealClock = 0;
  private anom!: Float64Array;
  private simpleT: Float64Array | null = null;
  private historyClock = 0;
  private R: number;
  private g: number;
  onEvent: ((msg: string, kind: 'info' | 'warn' | 'danger') => void) | null = null;
  private flags = { runaway: false, snowball: false, magma: false, ocean: true, frozen: false };

  constructor(init: WorldInit, R: number, g: number, res: ClimateResolution = 'low') {
    this.R = R;
    this.g = g;
    this.vol = VOLATILES[init.volatile];
    this.style = init.terrain;
    this.seed = init.terrainSeed;
    this.biosphere = init.biosphere;
    this.lifeStage = init.biosphere ? 4 : 0;
    this.hazeBase = init.haze ?? 0;
    this.dustBase = init.dust ?? 0;
    this.dust = this.dustBase;
    this.storms = new StormSystem(init.terrainSeed + 17);
    this.storms.onEvent = (m) => this.onEvent?.(m, 'info');
    // Gas inventory from partial pressures.
    this.gas = { N2: 0, O2: 0, Ar: 0, CO2: 0, CH4: 0, H2: 0, He: 0, SO2: 0, NH3: 0, CFC: 0 };
    this.setPartialPressures(init.atmosphere);
    const area = 4 * Math.PI * R * R;
    this.waterTotal = Math.max(0, init.waterGEL) * this.vol.rhoLiquid * area;
    this.loadTerrain(init.terrain, init.terrainSeed);
    this.allocate(RES_NLAT[res]);
    this.res = res;
    this.computeCellTerrain();
    const T0 = init.initialTemp ?? 250;
    for (let j = 0; j < this.grid.nLat; j++) {
      const c = this.grid.cosLat[j];
      for (let i = 0; i < this.grid.nLon; i++) {
        const k = j * this.grid.nLon + i;
        this.Ts[k] = T0 - 8 + 12 * c * c;
        this.Ta[k] = this.Ts[k];
        this.tAnnual[k] = this.tMonth[k] = this.tWarm[k] = this.tCold[k] = this.Ts[k];
      }
    }
    this.updateSeaLevel();
    // Moist start so the water-vapour greenhouse exists from the first step.
    const pDry0 = bulkFromMasses(this.gas, R, g).pDry;
    if (this.waterTotal > 0 && pDry0 > 30) {
      const area0 = 4 * Math.PI * R * R;
      let want = 0;
      for (let k = 0; k < this.grid.N; k++) want += 0.7 * this.wsat(this.Ts[k], pDry0) * this.grid.cellArea[Math.floor(k / this.grid.nLon)];
      const scale = Math.min(1, (0.3 * this.waterTotal) / Math.max(want * area0, 1e-30));
      for (let k = 0; k < this.grid.N; k++) {
        this.w[k] = 0.7 * this.wsat(this.Ts[k], pDry0) * scale;
        this.soil[k] = 60;
        this.pAnnual[k] = (2 * smoothstep(255, 295, this.Ts[k])) / 86400;
        this.cloud[k] = this.vol.id === 'H2O' ? 0.55 : 0.1;
        if (this.biosphere) this.veg[k] = 0.5 * smoothstep(255, 285, this.Ts[k]);
      }
    }
    // Initial ice caps / ice shells.
    if (init.iceCapLat !== undefined) {
      const capLat = (init.iceCapLat * Math.PI) / 180;
      for (let j = 0; j < this.grid.nLat; j++) {
        if (Math.abs(this.grid.lat[j]) < capLat) continue;
        const depth = smoothstep(capLat, capLat + 0.25, Math.abs(this.grid.lat[j]));
        for (let i = 0; i < this.grid.nLon; i++) {
          const k = j * this.grid.nLon + i;
          this.snow[k] = 2e6 * depth;
          this.seaIce[k] = 1 + 2 * depth;
        }
      }
    }
    if (T0 < 200 && this.waterTotal > 0 && this.vol.id === 'H2O' && pDry0 >= 611) for (let k = 0; k < this.grid.N; k++) this.seaIce[k] = Math.max(this.seaIce[k], 5000);
    if (this.waterTotal > 0 && this.vol.id === 'H2O' && pDry0 > 0 && pDry0 < 611) this.freezeDryOcean(1);
    this.stats = this.emptyStats();
    this.bulk = bulkFromMasses(this.gas, R, g);
    this.P = this.bulk.pDry;
  }

  // ------------------------------------------------------------------ setup

  private loadTerrain(style: TerrainStyle, seed: number) {
    const big = style === 'earthlike' || style === 'oceanic' || style === 'continental' || style === 'marslike' || style === 'venuslike' || style === 'titanlike';
    this.terrain = cloneTerrain(generateTerrain(style, seed, big ? 512 : 384, big ? 256 : 192, this.driftApplied));
    for (const c of this.craters) applyCrater(this.terrain, c, this.R);
    this.style = style;
    this.seed = seed;
    this.terrainVersion++;
  }

  /** Replace the terrain (new seed or style) keeping the climate state. */
  regenerateTerrain(style: TerrainStyle, seed: number): void {
    this.craters = [];
    this.loadTerrain(style, seed);
    this.computeCellTerrain();
    this.updateSeaLevel();
    this.version++;
  }

  private allocate(nLat: number) {
    const grid = new LatLonGrid(nLat, nLat * 2);
    const N = grid.N;
    const f = () => new Float64Array(N);
    const old = this.grid;
    if (old && this.Ts) {
      const rg = (a: Float64Array) => regrid(a, old, grid);
      this.Ts = rg(this.Ts);
      this.Ta = rg(this.Ta);
      this.snow = rg(this.snow);
      this.seaIce = rg(this.seaIce);
      this.w = rg(this.w);
      this.soil = rg(this.soil);
      this.veg = rg(this.veg);
      this.frost = rg(this.frost);
      this.cloud = rg(this.cloud);
      this.precip = rg(this.precip);
      this.tAnnual = rg(this.tAnnual);
      this.tMonth = rg(this.tMonth);
      this.tWarm = rg(this.tWarm);
      this.tCold = rg(this.tCold);
      this.pAnnual = rg(this.pAnnual);
    } else {
      this.Ts = f();
      this.Ta = f();
      this.snow = f();
      this.seaIce = f();
      this.w = f();
      this.soil = f();
      this.veg = f();
      this.frost = f();
      this.cloud = f();
      this.precip = f();
      this.tAnnual = f();
      this.tMonth = f();
      this.tWarm = f();
      this.tCold = f();
      this.pAnnual = f();
    }
    this.grid = grid;
    this.ocean = f();
    this.insol = f();
    this.albedo = f();
    this.asr = f();
    this.olr = f();
    this.evap = f();
    this.habitable = f();
    this.stormFactor = f();
    this.elev = f();
    this.material = f();
    this.C1 = f();
    this.C2 = f();
    this.oceanMask = f();
    this.anom = f();
    this.kEocean = f();
    this.wsCache = f();
    this.kEland = f();
    this.A1 = f();
    this.R1 = f();
    this.A2 = f();
    this.R2 = f();
    this.Dcap = f();
    this.Bc = f();
    this.LEc = f();
    this.dLEc = f();
    this.LPc = f();
    this.Gcc = f();
    this.snowfall = f();
    this.ecap = f();
    this.dLand = f();
    this.landMask = f();
    this.samples = new Float32Array(N * this.S);
    this.uo = f();
    this.vo = f();
    this.circ = new Circulation(grid);
  }

  /** Change grid resolution (focused worlds run finer). */
  setResolution(res: ClimateResolution): void {
    if (res === this.res) return;
    this.allocate(RES_NLAT[res]);
    this.res = res;
    this.computeCellTerrain();
    this.updateSeaLevel();
    this.version++;
  }

  private computeCellTerrain() {
    const { grid, terrain: t, S } = this;
    const { nLat, nLon } = grid;
    const buf: number[] = [];
    for (let j = 0; j < nLat; j++) {
      const p0 = Math.floor((j * t.h) / nLat);
      const p1 = Math.max(p0 + 1, Math.floor(((j + 1) * t.h) / nLat));
      for (let i = 0; i < nLon; i++) {
        const q0 = Math.floor((i * t.w) / nLon);
        const q1 = Math.max(q0 + 1, Math.floor(((i + 1) * t.w) / nLon));
        buf.length = 0;
        let se = 0,
          sm = 0;
        for (let p = p0; p < p1; p++)
          for (let q = q0; q < q1; q++) {
            const e = t.elev[p * t.w + q];
            buf.push(e);
            se += e;
            sm += t.material[p * t.w + q];
          }
        buf.sort((a, b) => a - b);
        const k = j * nLon + i;
        this.elev[k] = se / buf.length;
        this.material[k] = sm / buf.length;
        for (let s = 0; s < S; s++) this.samples[k * S + s] = buf[Math.min(buf.length - 1, Math.floor(((s + 0.5) / S) * buf.length))];
      }
    }
    // Global hypsometric histogram (area-weighted).
    const NB = 4096;
    this.histW = new Float64Array(NB + 1);
    this.histWE = new Float64Array(NB + 1);
    const e0 = t.min - 1;
    const de = (t.max - t.min + 2) / NB;
    const wBin = new Float64Array(NB);
    const weBin = new Float64Array(NB);
    let tot = 0;
    for (let p = 0; p < t.h; p++) {
      const wgt = Math.cos((0.5 - (p + 0.5) / t.h) * Math.PI);
      for (let q = 0; q < t.w; q++) {
        const e = t.elev[p * t.w + q];
        const b = Math.min(NB - 1, Math.max(0, Math.floor((e - e0) / de)));
        wBin[b] += wgt;
        weBin[b] += wgt * e;
        tot += wgt;
      }
    }
    for (let b = 0; b < NB; b++) {
      this.histW[b + 1] = this.histW[b] + wBin[b];
      this.histWE[b + 1] = this.histWE[b] + weBin[b];
    }
    this.histE0 = e0;
    this.histDE = de;
    this.histTotW = tot;
  }

  /** Volume (m³) of liquid needed to flood the terrain up to level s. */
  private volumeAt(s: number): number {
    const A = 4 * Math.PI * this.R * this.R;
    const NB = this.histW.length - 1;
    const b = clamp(Math.floor((s - this.histE0) / this.histDE), 0, NB);
    return (A / this.histTotW) * (s * this.histW[b] - this.histWE[b]);
  }

  private seaLevelFor(volume: number): number {
    if (volume <= 0) return -Infinity;
    const A = 4 * Math.PI * this.R * this.R;
    const top = this.histE0 + this.histDE * (this.histW.length - 1);
    const vTop = this.volumeAt(top);
    if (volume >= vTop) return top + (volume - vTop) / A;
    let lo = this.histE0;
    let hi = top;
    for (let it = 0; it < 40; it++) {
      const mid = 0.5 * (lo + hi);
      if (this.volumeAt(mid) < volume) lo = mid;
      else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  // ------------------------------------------------------------------ accounting

  private area(): number {
    return 4 * Math.PI * this.R * this.R;
  }

  /** Mass (kg) of the volatile stored outside the ocean (land ice, snow, vapour, soil). */
  private storedOutsideOcean(): number {
    const { grid } = this;
    const A = this.area();
    let m = 0;
    for (let j = 0; j < grid.nLat; j++) {
      const a = grid.cellArea[j] * A;
      for (let i = 0; i < grid.nLon; i++) {
        const k = j * grid.nLon + i;
        const fl = 1 - this.ocean[k];
        m += a * (this.w[k] + fl * (this.snow[k] + this.soil[k]));
      }
    }
    return m;
  }

  oceanMass(): number {
    return Math.max(0, this.waterTotal - this.storedOutsideOcean());
  }

  updateSeaLevel(): void {
    const vol = this.oceanMass() / this.vol.rhoLiquid;
    this.seaLevel = this.seaLevelFor(vol);
    const { S } = this;
    for (let k = 0; k < this.grid.N; k++) {
      if (!Number.isFinite(this.seaLevel)) {
        this.ocean[k] = 0;
        continue;
      }
      // Fraction of sub-grid samples below sea level (linear interpolation between samples).
      let lo = 0,
        hi = S;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (this.samples[k * S + m] < this.seaLevel) lo = m + 1;
        else hi = m;
      }
      let frac = lo / S;
      if (lo > 0 && lo < S) {
        const a = this.samples[k * S + lo - 1];
        const b = this.samples[k * S + lo];
        if (b > a) frac = (lo - 0.5 + (this.seaLevel - a) / (b - a) - 0.5) / S + 0.5 / S;
      }
      const fo = clamp(frac, 0, 1);
      // Keep absolute land-ice/soil mass when the coastline moves (values are per m² of land).
      const flOld = 1 - this.ocean[k];
      const flNew = 1 - fo;
      if (flNew < 1e-3) {
        this.snow[k] = 0;
        this.soil[k] = 0;
      } else if (Math.abs(flNew - flOld) > 1e-9 && flOld > 0) {
        const r = flOld / flNew;
        this.snow[k] *= r;
        this.soil[k] = Math.min(150, this.soil[k] * r);
      }
      this.ocean[k] = fo;
    }
  }

  setPartialPressures(pp: Record<string, number>): void {
    const g = this.g;
    const A = 4 * Math.PI * this.R * this.R;
    let P = 0;
    let molarMix = 0;
    for (const id of GAS_ORDER) {
      const p = Math.max(0, pp[id] ?? 0);
      P += p;
    }
    for (const id of GAS_ORDER) molarMix += (Math.max(0, pp[id] ?? 0) / Math.max(P, 1e-30)) * GASES[id].molar;
    for (const id of GAS_ORDER) {
      const p = Math.max(0, pp[id] ?? 0);
      this.gas[id] = P > 0 ? (p * A * GASES[id].molar) / (g * molarMix) : 0;
    }
  }

  /** Add (or remove, if negative) a gas expressed as a partial-pressure change in Pa. */
  addGasPressure(id: GasId, dp: number): void {
    const A = this.area();
    const dm = (dp * A) / this.g;
    this.gas[id] = Math.max(0, this.gas[id] + dm * (GASES[id].molar / (this.bulk?.molar || GASES[id].molar)));
    this.version++;
  }

  /** Add water/volatile as a global-equivalent layer (m). */
  addVolatile(gelMetres: number): void {
    this.waterTotal = Math.max(0, this.waterTotal + gelMetres * this.vol.rhoLiquid * this.area());
    if (this.waterTotal === 0) {
      this.w.fill(0);
      this.snow.fill(0);
      this.soil.fill(0);
      this.seaIce.fill(0);
    }
    this.updateSeaLevel();
    this.version++;
  }

  stripAtmosphere(fraction = 1): void {
    for (const id of GAS_ORDER) this.gas[id] *= 1 - fraction;
    for (let k = 0; k < this.grid.N; k++) this.w[k] *= 1 - fraction;
    this.version++;
  }

  // ------------------------------------------------------------------ physics helpers

  /** Saturation column of the volatile (kg/m²) at temperature T. */
  wsat(T: number, pDry: number): number {
    const v = this.vol;
    const es = v.esat(Math.max(20, T));
    const full = (v.Rv * T) / this.g;
    const Hw = v.id === 'H2O' ? Math.min(full, 2200 * (G_EARTH / this.g) * (T / 288) * (T / 288)) : 0.95 * full;
    const x = es / (es + Math.max(pDry, 1));
    const H = Hw + (full - Hw) * x;
    return (es / (v.Rv * T)) * H;
  }

  boilingPoint(P: number): number {
    if (P < 611) return this.vol.Tmelt;
    let lo = this.vol.Tmelt;
    let hi = this.vol.Tcrit;
    if (this.vol.esat(hi) < P) return hi;
    for (let it = 0; it < 40; it++) {
      const m = 0.5 * (lo + hi);
      if (this.vol.esat(m) < P) lo = m;
      else hi = m;
    }
    return 0.5 * (lo + hi);
  }

  // ------------------------------------------------------------------ main step

  step(dt: number, ctx: ClimateContext): void {
    if (!(dt > 0)) return;
    if (dt > SIMPLE_DT) {
      this.stepSimple(dt, ctx);
      this.evolveLife(dt);
      this.randomEruptions(dt, ctx);
      this.drift(dt, ctx);
      return;
    }
    this.mode = dt <= 86_400 ? 'weather' : 'seasonal';
    const { grid, vol } = this;
    const { nLat, nLon, N } = grid;
    const R = ctx.R;
    const g = ctx.g;
    this.R = R;
    this.g = g;
    const A = 4 * Math.PI * R * R;

    // 1. Bulk atmosphere.
    const bulk = bulkFromMasses(this.gas, R, g);
    this.bulk = bulk;
    let wMean = 0;
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) wMean += this.w[j * nLon + i] * grid.cellArea[j];
    const pVap = wMean * g;
    const P = bulk.pDry + pVap;
    this.P = P;
    const molar = bulk.molar;
    const cpAir = P > 0 ? (bulk.cp * bulk.pDry + 1860 * pVap) / P : 1004;
    const Catm = (cpAir * P) / g;
    const hasAtm = P > 30;

    // Star spectra (flux-weighted).
    let fluxTot = 0,
      visFrac = 0,
      rayFac = 0,
      xuv = 0;
    for (const s of ctx.illum) {
      const sf = spectralFractions(s.teff);
      const F = Math.max(s.flux, s.meanFlux);
      fluxTot += F;
      visFrac += F * sf.vis;
      rayFac += F * sf.rayleigh;
      xuv += F * s.xuvFrac;
    }
    if (fluxTot > 0) {
      visFrac /= fluxTot;
      rayFac /= fluxTot;
    } else {
      visFrac = 0.47;
      rayFac = 1;
    }
    const snowAlb = vol.id === 'H2O' ? 0.95 * visFrac + 0.65 * (1 - visFrac) : 0.35;
    const seaIceAlb = 0.75 * visFrac + 0.42 * (1 - visFrac);
    this.hostTeff = this.fluxWeightedTeff(ctx.illum);
    const vegAlbBase = plantAlbedo(this.hostTeff);
    const frostAlb = 0.6 * visFrac + 0.45 * (1 - visFrac);

    // 2. Insolation.
    computeInsolation(grid, ctx.illum, dt, this.insol);

    // 3. Column properties.
    const tauDry = dryOpticalDepth(bulk.pp, P, g);
    const tauR = hasAtm ? rayleighDepth(bulk, P, g, rayFac) : 0;
    // Rayleigh scattering only reflects the blue/visible part; near-IR is absorbed by thick CO₂.
    const rRay = 0.45 * ((0.5 * tauR) / (1 + 0.5 * tauR));
    const meanTprev = this.stats.meanT || 250;
    const deck = bulk.pp.SO2 > 1 && P > 5e5 && meanTprev > 300 ? 0.6 * smoothstep(5e5, 3e6, P) : 0;
    const ch4co2 = bulk.pp.CH4 / Math.max(bulk.pp.CO2, 1e-3);
    const hazeTau = this.hazeBase + (bulk.pp.CH4 > 100 && vol.id === 'H2O' ? 0.6 * smoothstep(0.1, 1, ch4co2) : 0);
    const hazeAbs = 1 - Math.exp(-hazeTau);
    const hazeAlb = 0.12 * hazeAbs;
    this.aerosol *= Math.exp(-dt / (1.5 * YEAR));
    this.dust = this.dustBase + (this.dust - this.dustBase) * Math.exp(-dt / (60 * DAY));
    const aerAlb = (0.3 * this.aerosol) / (1 + this.aerosol);
    const dustAbs = (0.25 * this.dust) / (1 + this.dust);
    const transmitFactor = (1 - 0.5 * hazeAbs) * (1 - dustAbs) * Math.exp(-0.15 * this.aerosol);
    const skyR = 1 - (1 - rRay * (1 - hazeAbs)) * (1 - deck) * (1 - hazeAlb) * (1 - aerAlb);

    const fBL = 0.15;
    const dayLen = Number.isFinite(ctx.synodicDay) ? Math.abs(ctx.synodicDay) : Math.max(ctx.orbitPeriod, DAY);
    const yearLen = Number.isFinite(ctx.orbitPeriod) ? ctx.orbitPeriod : 1e8;
    const inertia = hasAtm && this.waterTotal > 0 && P > 5e4 ? 1500 : P > 100 ? 350 : 80;
    const Cland1 = inertia * Math.sqrt(Math.min(dayLen, 3e7) / Math.PI) + fBL * Catm;
    const Cland2 = 0.5 * inertia * Math.sqrt(Math.min(yearLen, 3e9) / Math.PI) + (1 - fBL) * Catm;
    const Cocean1 = vol.rhoLiquid * vol.cpLiquid * 50 + fBL * Catm;
    const Cocean2 = (1 - fBL) * Catm + 1e5;
    const Cice1 = 3e5 + fBL * Catm;
    const gamma = hasAtm ? 2 + 20 * Math.sqrt(Math.min(1, P / 1e5)) : 0.6;
    const lapse = hasAtm ? 0.65 * (g / cpAir) * smoothstep(1e3, 2e4, P) : 0;
    const scaleH = (R_GAS * Math.max(meanTprev, 50)) / (molar * g);
    const Fint = ctx.internalHeat;
    const Om = Math.max(Math.abs(ctx.omega), Number.isFinite(ctx.orbitPeriod) ? (2 * Math.PI) / ctx.orbitPeriod : 1e-8, 1e-9);
    const Katm = clamp(2.0e6 * (g / G_EARTH) * Math.pow(0.029 / molar, 2) * Math.pow(7.29e-5 / Om, 2), 1e4, 3e9);
    const kappaAtm = Catm * Katm;
    const L = vol.Lvap;
    const Lf = vol.Lfus;
    const Tm = vol.Tmelt;
    const Tf = vol.TfreezeOcean;
    const olrLim = moistOLRLimit(g, vol.id);
    if (vol.id === 'H2O' && P < 611 && this.waterTotal > 0) this.freezeDryOcean(1 - Math.exp(-dt / (1000 * YEAR)));
    const ocMass = this.oceanMass();
    const hasLiquidReservoir = ocMass > 1e-6 * A;
    // Condensable bulk gas (frost caps): pick the one with the highest frost point.
    let frostGas: GasId | null = null;
    let Tfrost = 0;
    for (const id of ['CO2', 'N2'] as GasId[]) {
      if (bulk.pp[id] <= 0) continue;
      const tf = gasFrostPoint(GASES[id], bulk.pp[id]);
      if (tf > Tfrost) {
        Tfrost = tf;
        frostGas = id;
      }
    }
    if (this.frostGas && frostGas !== this.frostGas) {
      // Return frost of a previous species to the atmosphere.
      let m = 0;
      for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) m += this.frost[j * nLon + i] * grid.cellArea[j] * A;
      this.gas[this.frostGas] += m;
      this.frost.fill(0);
    }
    this.frostGas = frostGas;
    const Lgas = frostGas ? GASES[frostGas].condense!.Lmol / GASES[frostGas].molar : 1;

    // Vapour/condensation parameters.
    const tauC = vol.id === 'H2O' ? 6 * HOUR : 12 * HOUR;
    const rhC = vol.id === 'H2O' ? 0.72 : 0.5;
    const CE = 1.5e-3;
    const pDry = bulk.pDry;
    const hydro = hasAtm && this.waterTotal > 0;
    const oceanEvapScale = hasLiquidReservoir ? Math.min(1, ocMass / (0.002 * A * vol.rhoLiquid)) : 0;
    let oceanArea = 0;
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) oceanArea += this.ocean[j * nLon + i] * grid.cellArea[j];
    const oceanAvailPerArea = hasLiquidReservoir ? ocMass / Math.max(oceanArea * A, 1) : 0;

    // Global ocean heat flux beneath sea ice.
    let openOcean = 0;
    for (let k = 0; k < N; k++) openOcean += this.ocean[k] * (this.seaIce[k] < 0.05 ? 1 : 0);
    openOcean /= N;
    const Foc = Fint + 2 * Math.max(openOcean, hasLiquidReservoir ? 0.35 : 0) * (vol.id === 'H2O' ? 1 : 0.2);

    const C1 = this.C1;
    const C2 = this.C2;
    let tauSum = 0;
    const refLevel = Number.isFinite(this.seaLevel) ? this.seaLevel : this.meanElevation();

    for (let j = 0; j < nLat; j++) {
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const fo = this.ocean[k];
        const fl = 1 - fo;
        const h = this.seaIce[k];
        const iceC = fo > 0 ? smoothstep(0.02, 0.3, h) : 0;
        const snowCov = smoothstep(5, 100, this.snow[k]);
        const frostCov = smoothstep(1, 40, this.frost[k]);
        let T1 = this.Ts[k];
        let T2 = this.Ta[k];
        const molten = T1 > 1300;
        // --- surface albedo
        const [amin, amax] = BARREN_ALBEDO[this.style];
        const barren = amin + (amax - amin) * this.material[k];
        const wetness = clamp(this.soil[k] / 150, 0, 1);
        const vegAlb = vegAlbBase + 0.06 * (1 - wetness);
        const aridAlb = this.waterTotal > 0 && hasAtm ? Math.max(barren, 0.3 - 0.1 * wetness) : barren;
        let landAlb = aridAlb + (vegAlb - aridAlb) * this.veg[k];
        landAlb = landAlb + (snowAlb - landAlb) * snowCov;
        landAlb = landAlb + (frostAlb - landAlb) * frostCov;
        const oceanAlb = vol.id === 'H2O' ? 0.07 : 0.05;
        let aSurf = fo * (oceanAlb + (seaIceAlb - oceanAlb) * iceC) + fl * landAlb;
        if (molten) aSurf = 0.1;
        const CF = this.cloud[k];
        const aCloud = 0.345 * CF;
        const sky = 1 - (1 - skyR) * (1 - aCloud);
        const ap = sky + ((1 - sky) * (1 - sky) * aSurf) / (1 - sky * aSurf);
        this.albedo[k] = ap;
        const asr = this.insol[k] * (1 - ap) * transmitFactor;
        this.asr[k] = asr;
        // --- longwave
        const zAbove = Math.max(0, this.elev[k] + (fl > 0.5 ? this.snow[k] / 917 : 0) - refLevel);
        const pz = hasAtm ? Math.exp(-zAbove / Math.max(scaleH, 100)) : 1;
        const tauV = vapourOpticalDepth(vol.id, this.w[k], P, g);
        const tau = (tauDry + tauV + 0.25 * CF + 0.05 * this.aerosol) * pz;
        tauSum += tau * grid.cellArea[j];
        const wsK = hydro ? this.wsat(T1, pDry) : 1;
        this.wsCache[k] = wsK;
        const moist = hydro && vol.id === 'H2O' ? smoothstep(0.3, 0.7, this.w[k] / Math.max(wsK, 1e-9)) * smoothstep(275, 300, T1) * (hasLiquidReservoir ? 1 : 0.3) : 0;
        // OLR and its temperature derivative (analytic; gray atmosphere with a soft moist cap).
        const T1sq = T1 * T1;
        const gray = (SIGMA * T1sq * T1sq) / (1 + 0.75 * tau);
        let OLR0 = gray;
        let B = (4 * gray) / T1;
        if (moist > 0) {
          const capped = Math.pow(Math.pow(gray, -8) + Math.pow(olrLim, -8), -1 / 8);
          const dcap = Math.pow(capped / gray, 9) * B;
          OLR0 = gray + (capped - gray) * moist;
          B = B + (dcap - B) * moist;
        }
        B = Math.max(0.05, B);
        this.olr[k] = OLR0;
        // --- evaporation (linearised in T1)
        let LE0 = 0;
        let dLE = 0;
        let kE = 0;
        let landK = 0;
        this.kEocean[k] = 0;
        this.ecap[k] = 0;
        if (hydro) {
          const wind = Math.max(6, Math.hypot(this.circ.u[k], this.circ.v[k]));
          const Hcol = wsK / Math.max((vol.esat(T1) / (vol.Rv * T1)), 1e-12);
          const tauE = Math.max(Hcol, 100) / (CE * wind);
          const thin = 1 - smoothstep(611, 5000, P);
          const soilB = clamp(this.soil[k] / 100, 0, 1) * (0.4 + 0.6 * this.veg[k]) + (0.08 + 0.5 * thin) * snowCov;
          const betaO = fo * (1 - iceC) * oceanEvapScale + fo * iceC * 0.02;
          const betaL = fl * soilB;
          kE = (betaO + betaL) / tauE;
          this.kEocean[k] = betaO / tauE;
          landK = betaL / tauE;
          // Latent cooling uses the actual evaporation of the previous step (consistent with the
          // latent heating from precipitation), linearised in temperature for stability.
          LE0 = L * this.evap[k];
          dLE = this.w[k] < wsK ? L * kE * wsK * (vol.Lvap / (vol.Rv * T1sq)) : 0;
          // Evaporation potential is limited by the energy the surface receives (applied in hydrology).
          const energyCap = Math.max(0, 0.6 * (asr + Fint)) + 0.02 * SIGMA * T1 * T1 * T1 * T1;
          this.ecap[k] = energyCap / L;
          dLE = Math.min(dLE, energyCap / 2);
        }
        this.kEland[k] = landK;
        const LP = L * this.precip[k];
        // --- heat capacities
        let c1 = fo * (Cocean1 + (Cice1 - Cocean1) * iceC) + fl * Cland1;
        if (molten) c1 = Math.max(c1, 2e8);
        const c2 = fo * Cocean2 + fl * Cland2;
        C1[k] = c1;
        C2[k] = c2;
        const Gc = fo * iceC * (2.2 / Math.max(h, 0.1));
        const z = zAbove;
        this.Bc[k] = B;
        this.LEc[k] = LE0;
        this.dLEc[k] = dLE;
        this.LPc[k] = LP;
        this.Gcc[k] = Gc;
        // --- coefficients of the implicit two-layer column (solved together with transport below)
        this.A1[k] = c1 / dt + B + gamma + dLE + Gc;
        this.R1[k] = (c1 / dt) * T1 + asr + Fint - OLR0 + B * T1 - LE0 + dLE * T1 + Gc * Tf - gamma * lapse * z;
        this.A2[k] = c2 / dt + gamma;
        this.R2[k] = (c2 / dt) * T2 + LP + gamma * lapse * z;
        this.oceanMask[k] = fo * (1 - iceC);
        this.landMask[k] = fl;
      }
    }

    // 4. Atmosphere temperature with horizontal transport, surface layer eliminated:
    //    D·T2 − ∇·(κ∇T2) = R,   D = A2 − γ²/A1,   R = R2 + γ·R1/A1
    // Coupling radiation and transport in one implicit solve keeps long steps accurate.
    const kappa = hasAtm ? kappaAtm : 1e5;
    for (let k = 0; k < N; k++) {
      const D = this.A2[k] - (gamma * gamma) / this.A1[k];
      this.Dcap[k] = D * dt;
      this.Ta[k] = (this.R2[k] + (gamma * this.R1[k]) / this.A1[k]) / D;
    }
    grid.diffuse(this.Ta, this.Dcap, kappa, R, dt);

    // 5. Surface temperature and phase changes (frost caps, snowmelt, sea ice).
    let frostChange = 0;
    for (let j = 0; j < nLat; j++) {
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const fo = this.ocean[k];
        const fl = 1 - fo;
        const h = this.seaIce[k];
        const iceC = fo > 0 ? smoothstep(0.02, 0.3, h) : 0;
        const a1 = this.A1[k];
        const r1 = this.R1[k];
        const c1 = C1[k];
        const T1old = this.Ts[k];
        const nT2 = this.Ta[k];
        let nT1 = (r1 + gamma * nT2) / a1;
        // Net flux (W/m²) into the surface layer if its temperature were held at Tfix.
        const residualAt = (Tfix: number) => r1 - a1 * Tfix + gamma * nT2;
        if (frostGas && Tfrost > 0) {
          if (nT1 < Tfrost && hasAtm) {
            const res = residualAt(Tfrost);
            if (res < 0) {
              const want = (-res * dt) / Lgas;
              const dm = Math.min(want, (0.9 * this.gas[frostGas]) / A);
              this.frost[k] += dm;
              frostChange += dm * grid.cellArea[j] * A;
              nT1 = dm >= want ? Tfrost : Tfrost + (res + (dm * Lgas) / dt) / a1;
            }
          } else if (this.frost[k] > 0 && nT1 > Tfrost) {
            const res = residualAt(Tfrost);
            if (res > 0) {
              const dm = Math.min(this.frost[k], (res * dt) / Lgas);
              this.frost[k] -= dm;
              frostChange -= dm * grid.cellArea[j] * A;
              nT1 = this.frost[k] > 1e-9 ? Tfrost : Tfrost + (res - (dm * Lgas) / dt) / a1;
            }
          }
        }
        if (fl > 0.01 && this.snow[k] > 0 && nT1 > Tm) {
          const res = residualAt(Tm);
          if (res > 0) {
            const melt = Math.min(this.snow[k], (res * dt) / (Lf * fl));
            this.snow[k] -= melt;
            this.soil[k] += melt;
            const left = res - (melt * Lf * fl) / dt;
            nT1 = Tm + Math.max(0, left) / a1;
          }
        }
        if (fo > 0.01 && this.waterTotal > 0 && hasLiquidReservoir) {
          if (iceC < 0.5) {
            if (nT1 < Tf) {
              const res = residualAt(Tf);
              if (res < 0) {
                this.seaIce[k] += (-res * dt) / (vol.rhoIce * Lf * fo);
                nT1 = Tf;
              }
            } else if (h > 0) {
              const melt = Math.min(h, ((nT1 - Tf) * c1) / (vol.rhoIce * Lf));
              this.seaIce[k] = h - melt;
              nT1 -= (melt * vol.rhoIce * Lf) / c1;
            }
          } else {
            const dTc = Math.max(0, Tf - nT1);
            let hn = Math.sqrt(h * h + (2 * 2.2 * dTc * dt) / (vol.rhoIce * Lf));
            hn -= (Foc * dt) / (vol.rhoIce * Lf);
            if (nT1 > Tm) {
              const res = residualAt(Tm);
              if (res > 0) {
                hn -= (res * dt) / (vol.rhoIce * Lf * fo);
                nT1 = Tm;
              }
            }
            this.seaIce[k] = Math.max(0, Math.min(hn, 1e5));
          }
        }
        // Clamped surface temperatures change the surface→air heat exchange; hand that to the air.
        const nT1u = (r1 + gamma * nT2) / a1;
        if (nT1 !== nT1u) this.Ta[k] += (gamma * (nT1 - nT1u)) / (this.A2[k]);
        if (!Number.isFinite(nT1) || !Number.isFinite(nT2)) {
          nT1 = T1old;
          this.Ta[k] = T1old;
        }
        this.Ts[k] = clamp(nT1, 2.7, 6000);
        this.Ta[k] = clamp(this.Ta[k], 2.7, 6000);
      }
    }
    if (frostGas) this.gas[frostGas] = Math.max(0, this.gas[frostGas] - frostChange);

    // Ocean heat transport (slab ocean, split step) and weather-scale advection.
    if (hasLiquidReservoir) grid.diffuse(this.Ts, C1, Cocean1 * 2.5e4, R, dt, this.oceanMask);
    if (hasLiquidReservoir) this.advectOcean(ctx.omega, R, dt);
    if (hasAtm && dt < 2 * DAY) grid.advect(this.Ta, this.circ.u, this.circ.v, R, dt * 0.7);

    // 6. Hydrology.
    if (hydro) this.hydrology(dt, ctx, { pDry, rhC, tauC, Katm, hasLiquidReservoir, Tm, A });
    else {
      this.precip.fill(0);
      this.evap.fill(0);
    }

    // 7. Biosphere.
    if (this.biosphere) this.updateVegetation(dt, P);

    // 7. Long-term geochemistry and escape.
    this.longTerm(dt, ctx, bulk, xuv);
    this.randomEruptions(dt, ctx);

    // 8. Clouds, circulation & storms.
    this.updateClouds(P);
    let tMean = 0;
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) tMean += this.Ts[j * nLon + i] * grid.cellArea[j];
    let subLat = 0;
    if (ctx.illum.length) subLat = Math.asin(clamp(ctx.illum[0].dir[2], -1, 1));
    this.circ.update({ Ts: this.Ts, R, g, omega: ctx.omega, P, molar, Tmean: tMean, locked: ctx.locked, subLat });
    const stormDt = Math.min(dt, Math.max(ctx.realDt, 0) * 2 * DAY);
    if (ctx.storms && hasAtm) {
      const rho = (P * molar) / (8.314 * Math.max(tMean, 50));
      this.storms.update(stormDt, {
        grid,
        Ts: this.Ts,
        oceanFrac: this.ocean,
        seaIce: this.seaIce,
        u: this.circ.u,
        v: this.circ.v,
        uCloud: this.circ.uCloud,
        zonalT: this.circ.zonalT,
        R,
        omega: ctx.omega,
        P,
        rho,
        volatileFreezeK: Tf,
        hasLiquid: hasLiquidReservoir && vol.id === 'H2O',
        dusty: this.dustBase > 0 || (this.waterTotal === 0 && P < 2e4),
        insol: this.insol,
      });
      this.storms.imprint(grid, R, this.circ.u, this.circ.v, this.circ.pAnom, this.stormFactor);
      for (const s of this.storms.storms) if (s.kind === 'dust') this.dust = Math.max(this.dust, this.dustBase + Math.min(5, (s.radius / R) * 2));
    } else {
      this.storms.storms = [];
      this.stormFactor.fill(0);
    }

    // 9. Climatology, sea level, statistics.
    this.updateClimatology(dt);
    this.updateSeaLevel();
    this.computeStats(ctx, bulk, tauSum, dt);
    this.evolveLife(dt);
    this.drift(dt, ctx);
    this.version++;
  }

  /** Plate tectonics on plate-style worlds: continents move ~5 cm/yr; the map is rebuilt in steps. */
  private drift(dt: number, ctx: ClimateContext): void {
    if (!ctx.geology || this.spinningUp || !(this.style === 'earthlike' || this.style === 'oceanic' || this.style === 'continental')) return;
    this.driftMyr += dt / (1e6 * YEAR);
    this.driftRealClock += Math.max(ctx.realDt, 0);
    if (this.driftMyr - this.driftApplied >= 10 && this.driftRealClock > 2.5) {
      this.driftApplied = Math.round(this.driftMyr / 10) * 10;
      this.driftRealClock = 0;
      this.loadTerrain(this.style, this.seed);
      this.computeCellTerrain();
      this.updateSeaLevel();
      this.onEvent?.(`Continental drift: ${this.driftApplied.toFixed(0)} million years of plate motion have reshaped the continents.`, 'info');
    }
  }


  // ------------------------------------------------------------------ simple (fast) mode

  /** Band index of each cell: latitude rows, or rings around the substellar point if locked. */
  private bandMap(ctx: ClimateContext): Int32Array {
    const { grid } = this;
    const { nLat, nLon, N } = grid;
    const out = new Int32Array(N);
    const sd = ctx.locked && ctx.illum.length ? ctx.illum[0].dir : null;
    for (let j = 0; j < nLat; j++)
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        if (!sd) out[k] = j;
        else {
          const cl = grid.cosLat[j];
          const d = cl * Math.cos(grid.lon[i]) * sd[0] + cl * Math.sin(grid.lon[i]) * sd[1] + grid.sinLat[j] * sd[2];
          const theta = Math.acos(clamp(d, -1, 1));
          out[k] = Math.min(nLat - 1, Math.floor((theta / Math.PI) * nLat));
        }
      }
    return out;
  }

  /**
   * Fast latitude-band energy-balance model for high time warp: annual-mean sunlight,
   * implicit meridional transport, diagnostic ice and water vapour, long-term geochemistry.
   * Cell fields are rebuilt from band temperatures plus frozen regional anomalies.
   */
  private stepSimple(dt: number, ctx: ClimateContext): void {
    const { grid, vol } = this;
    const { nLat, nLon, N } = grid;
    const R = ctx.R;
    const g = ctx.g;
    this.R = R;
    this.g = g;
    const A = 4 * Math.PI * R * R;
    const band = this.bandMap(ctx);
    const nB = nLat;
    const bArea = new Float64Array(nB);
    const bT = new Float64Array(nB);
    const bOcean = new Float64Array(nB);
    const bCloud = new Float64Array(nB);
    const bLandAlb = new Float64Array(nB);
    const bIns = new Float64Array(nB);
    const bZ = new Float64Array(nB);
    // Entering simple mode: remember each cell's offset from its band mean (land/sea, altitude).
    for (let k = 0; k < N; k++) {
      const a = grid.cellArea[Math.floor(k / nLon)];
      const b = band[k];
      bArea[b] += a;
      bT[b] += this.Ts[k] * a;
    }
    for (let b = 0; b < nB; b++) bT[b] = bArea[b] > 0 ? bT[b] / bArea[b] : 250;
    if (this.mode !== 'simple' || !this.simpleT || this.simpleT.length !== nB) {
      // Entering simple mode: remember each cell's offset from its band mean (land/sea, altitude),
      // with zero band-mean so the anomalies carry no energy.
      const mA = new Float64Array(nB);
      for (let k = 0; k < N; k++) {
        this.anom[k] = clamp(this.Ts[k] - bT[band[k]], -25, 25);
        mA[band[k]] += this.anom[k] * grid.cellArea[Math.floor(k / nLon)];
      }
      for (let k = 0; k < N; k++) this.anom[k] -= mA[band[k]] / (bArea[band[k]] || 1);
      this.simpleT = bT.slice();
    } else bT.set(this.simpleT);
    this.mode = 'simple';
    // Band properties.
    const bulk = bulkFromMasses(this.gas, R, g);
    this.bulk = bulk;
    let fluxTot = 0,
      visFrac = 0,
      rayFac = 0,
      xuv = 0;
    for (const s of ctx.illum) {
      const sf = spectralFractions(s.teff);
      const F = Math.max(s.flux, s.meanFlux);
      fluxTot += F;
      visFrac += F * sf.vis;
      rayFac += F * sf.rayleigh;
      xuv += F * s.xuvFrac;
    }
    visFrac = fluxTot > 0 ? visFrac / fluxTot : 0.47;
    rayFac = fluxTot > 0 ? rayFac / fluxTot : 1;
    // Insolation: annual mean by latitude, or fixed day side for locked worlds.
    if (ctx.locked && ctx.illum.length) {
      this.insol.fill(0);
      for (const s of ctx.illum) {
        for (let j = 0; j < nLat; j++)
          for (let i = 0; i < nLon; i++) {
            const k = j * nLon + i;
            const cl = grid.cosLat[j];
            const mu = cl * Math.cos(grid.lon[i]) * s.dir[0] + cl * Math.sin(grid.lon[i]) * s.dir[1] + grid.sinLat[j] * s.dir[2];
            this.insol[k] += Math.max(0, mu) * s.meanFlux;
          }
      }
    } else computeInsolation(grid, ctx.illum.map((s) => ({ ...s, orbitPeriod: Math.min(s.orbitPeriod, dt) })), dt, this.insol);
    const [amin, amax] = BARREN_ALBEDO[this.style];
    const refLevel = Number.isFinite(this.seaLevel) ? this.seaLevel : this.meanElevation();
    for (let k = 0; k < N; k++) {
      const a = grid.cellArea[Math.floor(k / nLon)];
      const b = band[k];
      bOcean[b] += this.ocean[k] * a;
      bCloud[b] += this.cloud[k] * a;
      const barren = amin + (amax - amin) * this.material[k];
      bLandAlb[b] += (barren + (0.15 - barren) * this.veg[k]) * a;
      bIns[b] += this.insol[k] * a;
      bZ[b] += Math.max(0, this.elev[k] - refLevel) * a;
    }
    const bSnow = new Float64Array(nB);
    for (let k = 0; k < N; k++) bSnow[band[k]] += (1 - this.ocean[k]) * smoothstep(5, 100, this.snow[k]) * grid.cellArea[Math.floor(k / nLon)];
    for (let b = 0; b < nB; b++) {
      const w = bArea[b] || 1;
      bSnow[b] /= w;
      bOcean[b] /= w;
      bCloud[b] /= w;
      bLandAlb[b] /= w;
      bIns[b] /= w;
      bZ[b] /= w;
    }
    const water = this.waterTotal > 0 && vol.id === 'H2O';
    const pDry = bulk.pDry;
    const hasAtm = pDry > 30;
    const wetWorld = water && hasAtm && pDry > 611 && this.oceanMass() > 1e-4 * this.waterTotal;
    const snowAlb = vol.id === 'H2O' ? 0.95 * visFrac + 0.65 * (1 - visFrac) : 0.35;
    const seaIceAlb = 0.75 * visFrac + 0.42 * (1 - visFrac);
    const Tf = vol.TfreezeOcean;
    const tauR = hasAtm ? rayleighDepth(bulk, pDry, g, rayFac) : 0;
    const hazeAbs = 1 - Math.exp(-this.hazeBase);
    const rRay = 0.45 * ((0.5 * tauR) / (1 + 0.5 * tauR)) * (1 - hazeAbs);
    const deck = bulk.pp.SO2 > 1 && pDry > 5e5 && (this.stats.meanT || 300) > 300 ? 0.6 * smoothstep(5e5, 3e6, pDry) : 0;
    this.aerosol *= Math.exp(-dt / (1.5 * YEAR));
    const aerAlb = (0.3 * this.aerosol) / (1 + this.aerosol);
    const skyR = 1 - (1 - rRay) * (1 - deck) * (1 - 0.12 * hazeAbs) * (1 - aerAlb);
    const transmit = (1 - 0.5 * hazeAbs) * (1 - (0.25 * this.dustBase) / (1 + this.dustBase));
    const olrLim = moistOLRLimit(g, vol.id);
    const molar = bulk.molar;
    const Om = Math.max(Math.abs(ctx.omega), Number.isFinite(ctx.orbitPeriod) ? (2 * Math.PI) / ctx.orbitPeriod : 1e-8, 1e-9);
    const Katm = clamp(2.0e6 * (g / G_EARTH) * Math.pow(0.029 / molar, 2) * Math.pow(7.29e-5 / Om, 2), 1e4, 3e9);
    // Vapour column at fixed relative humidity, limited by the planet's inventory.
    const vapour = (T: number) => (water && hasAtm ? 0.66 * this.wsat(T, pDry) : 0);
    let vapTot = 0;
    for (let b = 0; b < nB; b++) vapTot += vapour(bT[b]) * bArea[b];
    const vapScale = water ? Math.min(1, this.waterTotal / Math.max(vapTot * A, 1e-30)) : 0;
    const P = pDry + vapTot * vapScale * g;
    this.P = P;
    const cpAir = 1004;
    const Catm = (cpAir * P) / g;
    const kappa = Catm * Katm;
    const tauDry = dryOpticalDepth(bulk.pp, P, g);
    const scaleH = (R_GAS * 250) / (molar * g);
    // Solve the band EBM implicitly (two Picard passes for albedo/greenhouse nonlinearity).
    const Tn = bT.slice();
    const a = new Float64Array(nB),
      bb = new Float64Array(nB),
      c = new Float64Array(nB),
      r = new Float64Array(nB);
    const asrB = new Float64Array(nB);
    const olrB = new Float64Array(nB);
    const alb = new Float64Array(nB);
    const kapB = new Float64Array(nB);
    const oceanLeft = this.oceanMass() > 0;
    let globalRunaway = false;
    {
      let asrG = 0;
      for (let b = 0; b < nB; b++) asrG += bIns[b] * (1 - 0.3) * transmit * bArea[b];
      globalRunaway = asrG + ctx.internalHeat > olrLim * 0.98 || (this.stats.runaway && asrG > olrLim * 0.85);
    }
    for (let pass = 0; pass < 3; pass++) {
      for (let b = 0; b < nB; b++) {
        const moistBoost = 1 + 0.3 * Math.min(2, (vapour(Tn[b]) * vapScale) / 25);
        kapB[b] = (kappa + bOcean[b] * 2.1e8 * 1.5e4) * moistBoost;
      }
      for (let b = 0; b < nB; b++) {
        const T = Tn[b];
        const fo = bOcean[b];
        // Annual-mean temperatures: albedo-relevant (sunlit-season) snow and sea ice need colder means.
        const iceO = water ? smoothstep(Tf - 2, Tf - 16, T) : 0;
        // Seasonal snow needs a hydrological cycle; otherwise only existing ice caps count.
        const snowL = Math.max(Math.min(1, bSnow[b] / Math.max(1 - fo, 1e-3)), wetWorld ? smoothstep(271, 254, T) : 0);
        const aSurf = fo * (0.07 + (seaIceAlb - 0.07) * iceO) + (1 - fo) * (bLandAlb[b] + (snowAlb - bLandAlb[b]) * snowL);
        const CF = bCloud[b];
        const sky = 1 - (1 - skyR) * (1 - 0.345 * CF);
        const ap = T > 1300 ? 0.1 : sky + ((1 - sky) * (1 - sky) * aSurf) / (1 - sky * aSurf);
        alb[b] = ap;
        asrB[b] = bIns[b] * (1 - ap) * transmit;
        const pz = hasAtm ? Math.exp(-bZ[b] / Math.max(scaleH, 100)) : 1;
        const olrAt = (TT: number) => {
          const tau = (tauDry + vapourOpticalDepth(vol.id, vapour(TT) * vapScale, P, g) + 0.25 * CF) * pz;
          const gray = (SIGMA * TT * TT * TT * TT) / (1 + 0.75 * tau);
          // The moist radiation limit is a planet-wide threshold: only bite when the whole
          // planet absorbs more than it (otherwise tropics just export heat poleward).
          if (!water || !oceanLeft || !globalRunaway) return gray;
          return Math.pow(Math.pow(gray, -8) + Math.pow(olrLim, -8), -1 / 8);
        };
        const O = olrAt(T);
        olrB[b] = O;
        const B = Math.max(0.05, olrAt(T + 0.5) - olrAt(T - 0.5));
        const C = (fo * 2.1e8 + (1 - fo) * 1.5e7 + Catm) / dt;
        const cl = Math.max(grid.cosLat[b], 1e-4);
        // Face conductances are shared by both neighbours so transport conserves energy.
        const kn = b > 0 ? 0.5 * (kapB[b] + kapB[b - 1]) : 0;
        const ks = b < nB - 1 ? 0.5 * (kapB[b] + kapB[b + 1]) : 0;
        const gn = b > 0 ? (kn * grid.cosFace[b - 1]) / (R * R * cl * grid.dLat * grid.dLat) : 0;
        const gs = b < nB - 1 ? (ks * grid.cosFace[b]) / (R * R * cl * grid.dLat * grid.dLat) : 0;
        a[b] = -gn;
        c[b] = -gs;
        bb[b] = C + B + gn + gs;
        r[b] = C * bT[b] + asrB[b] + ctx.internalHeat - O + B * T;
      }
      // Tridiagonal solve.
      const gam = new Float64Array(nB);
      let bet = bb[0];
      Tn[0] = r[0] / bet;
      for (let b = 1; b < nB; b++) {
        gam[b] = c[b - 1] / bet;
        bet = bb[b] - a[b] * gam[b];
        Tn[b] = (r[b] - a[b] * Tn[b - 1]) / bet;
      }
      for (let b = nB - 2; b >= 0; b--) Tn[b] -= gam[b + 1] * Tn[b + 1];
      for (let b = 0; b < nB; b++) Tn[b] = clamp(Tn[b], 2.7, 6000);
    }
    // Deep-cold atmospheric collapse (frost) only when well below the frost point.
    let frostGas: GasId | null = null;
    let Tfrost = 0;
    for (const id of ['CO2', 'N2'] as GasId[]) {
      if (bulk.pp[id] <= 0) continue;
      const tf = gasFrostPoint(GASES[id], bulk.pp[id]);
      if (tf > Tfrost) {
        Tfrost = tf;
        frostGas = id;
      }
    }
    const fCond = 1 - Math.exp(-dt / (20 * YEAR));
    let frostDelta = 0;
    // Permanent frost needs the *summer* to stay below the frost point (annual means are too cold).
    const tSummer = new Float64Array(nB);
    for (let b = 0; b < nB; b++) {
      let q = 0;
      for (const s of ctx.illum) {
        if (ctx.locked) q += Math.max(0, Math.cos(((b + 0.5) / nB) * Math.PI)) * s.meanFlux;
        else q += dailyMean(grid.lat[b], Math.sign(grid.lat[b] || 1) * s.obliquity) * s.meanFlux;
      }
      const eps = olrB[b] / Math.max(SIGMA * Math.pow(Tn[b], 4), 1e-9);
      tSummer[b] = Math.pow((q * (1 - alb[b]) * transmit + ctx.internalHeat) / (SIGMA * Math.max(eps, 0.05)), 0.25);
    }
    this.simpleT = Tn.slice();
    // Ice-sheet growth draws on the ocean; at most a third of it per step.
    const oceanNow = this.oceanMass();
    let iceBudget = water ? 0.33 * oceanNow : 0;
    // Rebuild cell fields.
    for (let k = 0; k < N; k++) {
      const j = Math.floor(k / nLon);
      const b = band[k];
      const T = Tn[b] + this.anom[k];
      this.Ts[k] = clamp(T, 2.7, 6000);
      this.Ta[k] = this.Ts[k];
      this.tAnnual[k] = this.Ts[k];
      this.tMonth[k] = this.Ts[k];
      this.tWarm[k] = this.Ts[k] + 8;
      this.tCold[k] = this.Ts[k] - 8;
      this.asr[k] = asrB[b];
      this.olr[k] = olrB[b];
      this.albedo[k] = alb[b];
      this.w[k] = vapour(this.Ts[k]) * vapScale;
      // Precipitation climatology proxy (kg/m²/s) so vegetation and people have rain.
      if (wetWorld) this.pAnnual[k] = ((0.4 + 3 * smoothstep(255, 300, this.Ts[k])) * (0.55 + 0.45 * bOcean[b])) / 86400;
      else this.pAnnual[k] *= 0.5;
      const fl = 1 - this.ocean[k];
      if (water) {
        // Ice sheets grow below −10 °C and melt above freezing (millennial timescales).
        if (fl > 0.01) {
          const cellLand = grid.cellArea[j] * A * fl;
          if (this.Ts[k] < 263 && iceBudget > 0 && hasAtm) {
            const want = (2e6 - this.snow[k]) * (1 - Math.exp(-dt / (2e4 * YEAR))) + Math.min(dt / YEAR, 50) * 0.2;
            const add = Math.max(0, Math.min(want, iceBudget / cellLand));
            this.snow[k] += add;
            iceBudget -= add * cellLand;
          } else if (this.Ts[k] > Tf + 2) this.snow[k] *= Math.exp(-dt / (3e3 * YEAR));
        }
        this.seaIce[k] = this.ocean[k] > 0 ? (this.Ts[k] < Tf ? Math.max(this.seaIce[k], 2 + (Tf - this.Ts[k]) * 0.3) : 0) : 0;
      }
      if (frostGas && Tfrost > 0) {
        const cellA = grid.cellArea[j] * A;
        const summer = tSummer[b] + this.anom[k];
        if (summer < Tfrost) {
          const dm = (this.gas[frostGas] / A) * fCond * 0.5;
          this.frost[k] += dm;
          frostDelta += dm * cellA;
          this.Ts[k] = Math.max(this.Ts[k], Math.min(Tfrost, this.Ts[k] + 10));
        } else if (this.frost[k] > 0) {
          const dm = this.frost[k] * fCond;
          this.frost[k] -= dm;
          frostDelta -= dm * cellA;
        }
      }
    }
    if (frostGas) this.gas[frostGas] = Math.max(0, this.gas[frostGas] - frostDelta);
    this.storms.storms = [];
    this.stormFactor.fill(0);
    if (this.biosphere) this.updateVegetation(dt, P);
    this.longTerm(dt, ctx, bulk, xuv);
    let tMean = 0;
    for (let k = 0; k < N; k++) tMean += this.Ts[k] * grid.cellArea[Math.floor(k / nLon)];
    this.circ.update({ Ts: this.Ts, R, g, omega: ctx.omega, P, molar, Tmean: tMean, locked: ctx.locked, subLat: ctx.illum.length ? Math.asin(clamp(ctx.illum[0].dir[2], -1, 1)) : 0 });
    this.updateSeaLevel();
    this.computeStats(ctx, bulk, tauDry, dt);
    this.version++;
  }

  private hydrology(
    dt: number,
    ctx: ClimateContext,
    p: { pDry: number; rhC: number; tauC: number; Katm: number; hasLiquidReservoir: boolean; Tm: number; A: number },
  ) {
    const { grid, vol } = this;
    const { nLat, nLon, N } = grid;
    const R = ctx.R;
    const kC = 1 / p.tauC;
    let evapTot = 0;
    const oceanBefore = this.oceanMass();
    let precipLand = 0;
    for (let j = 0; j < nLat; j++) {
      const cellA = grid.cellArea[j] * p.A;
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const T = this.Ts[k];
        const ws = this.wsat(T, p.pDry);
        this.wsCache[k] = ws;
        // Orographic lifting from upslope winds.
        const kl = j * nLon + ((i - 1 + nLon) % nLon);
        const kr = j * nLon + ((i + 1) % nLon);
        const kn = j > 0 ? k - nLon : k;
        const ks = j < nLat - 1 ? k + nLon : k;
        const surf = (q: number) => (Number.isFinite(this.seaLevel) ? Math.max(this.elev[q], this.seaLevel) : this.elev[q]);
        const dhdx = (surf(kr) - surf(kl)) / (2 * R * Math.max(grid.cosLat[j], 0.05) * grid.dLon);
        const dhdy = (surf(kn) - surf(ks)) / (2 * R * grid.dLat);
        const wUp = this.circ.u[k] * dhdx + this.circ.v[k] * dhdy;
        const rh = clamp(p.rhC - 0.45 * clamp(wUp / 0.08, -0.35, 1), 0.2, 0.98);
        const wc = rh * ws;
        const kStorm = this.stormFactor[k] > 0.05 ? (this.stormFactor[k] * 3) / p.tauC : 0;
        const fo = this.ocean[k];
        const fl = 1 - fo;
        let kEo = this.kEocean[k];
        let kEl = this.kEland[k];
        const pot = (kEo + kEl) * Math.max(0, ws - this.w[k]);
        if (pot > this.ecap[k] && pot > 0) {
          const f = this.ecap[k] / pot;
          kEo *= f;
          kEl *= f;
        }
        // Land evaporation is limited by what the soil and snowpack hold.
        const supply = fl * (this.soil[k] + this.snow[k]);
        const potLand = kEl * Math.max(0, ws - this.w[k]) * dt;
        const limited = potLand > supply;
        const Sland = limited ? supply / dt : 0;
        const [wn, E, Cn] = relaxColumn(this.w[k], ws, Math.min(wc, ws), kEo + (limited ? 0 : kEl), kC + kStorm, Sland, dt);
        this.w[k] = Math.max(0, wn);
        this.evap[k] = E / dt;
        this.precip[k] = Cn / dt;
        evapTot += E * cellA;
        const kEtot = kEo + (limited ? 0 : kEl);
        const Eland = limited ? Sland * dt : kEtot > 0 ? (E * kEl) / kEtot : 0;
        this.dLand[k] = 0;
        this.snowfall[k] = T < p.Tm + 1 ? Cn / dt : 0;
        if (fl > 0.01) {
          const perLand = Math.max(0, Eland) / fl;
          const fromSoil = Math.min(this.soil[k], perLand);
          this.soil[k] -= fromSoil;
          this.snow[k] = Math.max(0, this.snow[k] - (perLand - fromSoil));
          if (T < p.Tm + 1) this.snow[k] += Cn;
          else {
            const room = Math.max(0, 150 - this.soil[k]);
            this.soil[k] += Math.min(Cn, room);
          }
          this.dLand[k] = (T < p.Tm + 1 ? Cn : 0) - perLand;
          precipLand += Cn * fl * cellA;
        }
        if (fo > 0.01 && this.seaIce[k] > 0.3 && T < p.Tm) this.seaIce[k] += (0.3 * Cn) / vol.rhoIce;
      }
    }
    // A single step cannot move more water onto land than the ocean held.
    let landGain = 0;
    for (let j = 0; j < nLat; j++) {
      const cellA = grid.cellArea[j] * p.A;
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        if (this.dLand[k] > 0) landGain += this.dLand[k] * (1 - this.ocean[k]) * cellA;
      }
    }
    if (landGain > 0 && landGain > 0.5 * oceanBefore) {
      const f = (0.5 * oceanBefore) / landGain;
      for (let k = 0; k < N; k++) if (this.dLand[k] > 0) this.snow[k] = Math.max(0, this.snow[k] - this.dLand[k] * (1 - f));
    }
    // Vapour transport.
    grid.diffuse(this.w, 1, p.Katm, R, dt);
    if (dt < 3 * DAY) grid.advect(this.w, this.circ.u, this.circ.v, R, dt);
    // Glacier flow: thick land ice spreads slowly; ice pushed onto ocean cells calves.
    if (dt > 30 * DAY) {
      grid.diffuse(this.snow, this.landMask, 3 * smoothstep(1e4, 1e6, this.maxOf(this.snow)), R, dt, this.landMask);
      for (let k = 0; k < N; k++) if (this.ocean[k] > 0.9 && this.snow[k] > 0) this.snow[k] *= Math.exp(-dt / (50 * YEAR));
    }
    // Global ocean cannot go negative: scale back excess evaporation.
    const ocean = this.oceanMass();
    if (ocean <= 0 && evapTot > 0) {
      const deficit = this.storedOutsideOcean() - this.waterTotal;
      if (deficit > 0) {
        let wTot = 0;
        for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) wTot += this.w[j * nLon + i] * grid.cellArea[j] * p.A;
        const s = wTot > 0 ? Math.max(0, 1 - deficit / wTot) : 0;
        for (let k = 0; k < N; k++) this.w[k] *= s;
      }
    }
    void precipLand;
  }

  /**
   * Below water's triple point (611 Pa) liquid cannot persist: move a fraction of the ocean into
   * polar ice caps (what sublimation and cold-trapping do over millennia).
   */
  freezeDryOcean(fraction: number): void {
    const ocean = this.oceanMass();
    if (ocean <= 0) return;
    const move = ocean * clamp(fraction, 0, 1);
    const { grid } = this;
    const A = this.area();
    let capArea = 0;
    for (let j = 0; j < grid.nLat; j++) if (Math.abs(grid.lat[j]) > 1.2) for (let i = 0; i < grid.nLon; i++) capArea += (1 - this.ocean[j * grid.nLon + i]) * grid.cellArea[j];
    if (capArea <= 0) return;
    const perArea = move / (capArea * A);
    for (let j = 0; j < grid.nLat; j++) if (Math.abs(grid.lat[j]) > 1.2) for (let i = 0; i < grid.nLon; i++) this.snow[j * grid.nLon + i] += perArea;
    this.updateSeaLevel();
  }

  /** Effective host-star temperature (flux-weighted) — sets plant pigment colour. */
  hostTeff = 5772;
  fluxWeightedTeff(illum: Illuminator[]): number {
    let f = 0,
      ft = 0;
    for (const s of illum) {
      const F = Math.max(s.flux, s.meanFlux);
      f += F;
      ft += F * s.teff;
    }
    return f > 0 ? ft / f : this.hostTeff;
  }

  /** Area-weighted mean surface elevation (datum for worlds without oceans). */
  meanElevation(): number {
    return this.grid.mean(this.elev);
  }

  private maxOf(a: Float64Array): number {
    let m = 0;
    for (let k = 0; k < a.length; k++) if (a[k] > m) m = a[k];
    return m;
  }

  private updateVegetation(dt: number, P: number) {
    const a = 1 - Math.exp(-dt / (25 * YEAR));
    const o2ok = P > 3e4;
    const c0 = this.vegetationCarbon();
    for (let k = 0; k < this.grid.N; k++) {
      const fl = 1 - this.ocean[k];
      if (fl < 0.01 || !o2ok) {
        this.veg[k] *= 1 - a;
        continue;
      }
      const Tc = this.tAnnual[k] - 273.15;
      const pmm = this.pAnnual[k] * DAY;
      const target =
        smoothstep(-8, 4, Tc) *
        (1 - smoothstep(34, 48, Tc)) *
        smoothstep(0.25, 2.5, pmm) *
        (1 - smoothstep(20, 300, this.snow[k])) *
        smoothstep(-25, -5, this.tWarm[k] - 273.15 - 15);
      this.veg[k] += (target - this.veg[k]) * a;
    }
    if (this.spinningUp) return;
    // Plants store carbon: spreading forests draw down CO₂, dying ones release it.
    const dC = this.vegetationCarbon() - c0;
    // Plants cannot draw CO₂ below their compensation point (~10 Pa).
    const floor = Math.min(this.gas.CO2, this.partialToMass('CO2', 10));
    this.gas.CO2 = Math.max(floor, this.gas.CO2 - dC * (44 / 12));
    // Photosynthetic oxygen (slow net burial, only while the air is still oxygen-poor) and methane.
    const vegFrac = this.stats.vegetation || 0;
    if (vegFrac > 0.01) {
      const o2Frac = (this.bulk?.pp.O2 ?? 0) / Math.max(this.P, 1);
      const prod = o2Frac < 0.15 ? 2e10 * (vegFrac / 0.2) * (dt / YEAR) * (this.area() / 5.1e14) : 0;
      const take = Math.min(prod * (44 / 32), this.gas.CO2 * 0.5);
      this.gas.CO2 -= take;
      this.gas.O2 += take * (32 / 44);
      // Wetland methane: short-lived in oxygen-rich air, accumulates in anoxic atmospheres.
      const ch4Target = ((0.19 * vegFrac) / 0.2) * ((this.bulk?.pp.O2 ?? 0) > 1e3 ? 1 : 300);
      const targetMass = this.partialToMass('CH4', ch4Target);
      this.gas.CH4 = Math.max(0, this.gas.CH4 + (targetMass - this.gas.CH4) * (1 - Math.exp(-dt / (12 * YEAR))));
    }
  }

  private longTerm(dt: number, ctx: ClimateContext, bulk: BulkAtmosphere, xuvFlux: number) {
    const R = ctx.R;
    const A = 4 * Math.PI * R * R;
    const yr = dt / YEAR;
    // Carbonate–silicate cycle.
    if (ctx.geology && this.gas.CO2 + this.gas.N2 > 0) {
      const { grid } = this;
      let landFree = 0,
        tLand = 0,
        wl = 0,
        pLand = 0;
      for (let j = 0; j < grid.nLat; j++)
        for (let i = 0; i < grid.nLon; i++) {
          const k = j * grid.nLon + i;
          const fl = (1 - this.ocean[k]) * grid.cellArea[j];
          landFree += fl * (1 - smoothstep(5, 100, this.snow[k]));
          tLand += this.Ts[k] * fl;
          pLand += this.precip[k] * fl;
          wl += fl;
        }
      const landArea = landFree * A;
      tLand = wl > 0 ? tLand / wl : 0;
      const pmm = wl > 0 ? (pLand / wl) * DAY : 0;
      const liquid = tLand > this.vol.Tmelt && this.oceanMass() > 0 && this.vol.id === 'H2O';
      const W0 = (3e11 / YEAR) * (landArea / 1.33e14);
      const runoff = clamp(pmm / 2.2, 0, 3);
      const wFactor = liquid ? Math.exp((tLand - 288) / 17.7) * Math.pow(runoff, 0.65) : 0;
      const V = (3e11 / YEAR) * (A / 5.1e14) * clamp(ctx.geothermal / 0.087, 0, 50) * (ctx.mass > 6e23 ? 1 : 0.1);
      const pRef = 42;
      let M = this.gas.CO2;
      // Mass of CO₂ at the reference partial pressure (independent of the current amount, so
      // the weathering law stays well-behaved when CO₂ is nearly exhausted).
      const Mref = this.partialToMass('CO2', pRef);
      // Implicit update: M' = M + dt (V − W0 f (M'/Mref)^0.3)
      if (Mref > 0 && Number.isFinite(Mref)) {
        let x = M;
        for (let it = 0; it < 8; it++) {
          const wr = W0 * wFactor * Math.pow(Math.max(x, 1) / Mref, 0.3);
          const fx = x - M - dt * (V - wr);
          const dfx = 1 + dt * W0 * wFactor * 0.3 * Math.pow(Math.max(x, 1) / Mref, -0.7) / Mref;
          x = Math.max(0, x - fx / dfx);
        }
        this.gas.CO2 = x;
      } else this.gas.CO2 += V * dt;
    }
    // Atmospheric escape.
    const vesc2 = (2 * G * ctx.mass) / R;
    const Texo = clamp(1000 * Math.pow(Math.max(xuvFlux, 1e-9) / 0.0046, 0.35), 150, 2e4);
    const mdotEL = (0.15 * Math.PI * R * R * R * xuvFlux) / (G * ctx.mass);
    for (const id of GAS_ORDER) {
      const m0 = this.gas[id];
      if (m0 <= 0) continue;
      const lambda = (0.5 * vesc2 * GASES[id].molar) / (R_GAS * Texo);
      let rate = 0;
      if (lambda < 60) rate = ((1 + lambda) * Math.exp(-lambda)) / (1e3 * YEAR);
      if (lambda < 3) rate = 1 / (300 * YEAR);
      let m = m0 * Math.exp(-rate * dt);
      if (id === 'H2' || id === 'He') m = Math.max(0, m - mdotEL * dt * (id === 'H2' ? 0.8 : 0.2));
      this.gas[id] = m;
    }
    // Water loss from a moist upper atmosphere (H escape after photolysis).
    if (this.vol.id === 'H2O' && this.waterTotal > 0) {
      const moist = smoothstep(320, 360, this.stats.meanT || 0) + smoothstep(0.05, 0.3, this.P > 0 ? (this.stats.vapourGEL * 1000 * this.g) / this.P : 0);
      if (moist > 0) {
        const loss = Math.min(this.waterTotal, mdotEL * 9 * clamp(moist, 0, 1) * dt);
        this.waterTotal -= loss;
        this.gas.O2 += loss * (8 / 9) * 0.25;
      }
      const lambdaW = (0.5 * vesc2 * 0.018) / (R_GAS * Texo);
      if (lambdaW < 25) this.waterTotal *= Math.exp((-dt * (1 + lambdaW) * Math.exp(-lambdaW)) / (1e4 * YEAR));
    }
    void yr;
  }

  /**
   * Wind-driven ocean circulation. Zonal wind stress curl drives a Sverdrup interior flow
   * (β·V = curl τ / ρ₀) in every basin; mass returns poleward/equatorward in a narrow western
   * boundary current — the Gulf Stream / Kuroshio pattern. Rows with no coast (a Southern Ocean)
   * get a circumpolar wind drift instead. The mixed layer is then advected, so western sides of
   * basins run warm and eastern sides cool, as on Earth.
   */
  private advectOcean(omega: number, R: number, dt: number): void {
    const { grid } = this;
    const { nLat, nLon } = grid;
    const uo = this.uo,
      vo = this.vo;
    uo.fill(0);
    vo.fill(0);
    const rhoA = Math.max(1e-3, (this.P * (this.bulk?.molar || 0.029)) / (8.314 * 280));
    const H = 500; // depth of the wind-driven layer (m)
    const taux = new Float64Array(nLat);
    for (let j = 0; j < nLat; j++) {
      let s = 0;
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const u = this.circ.u[k];
        s += rhoA * 1.3e-3 * Math.abs(u) * u;
      }
      taux[j] = s / nLon;
    }
    const isOcean = (k: number) => this.ocean[k] > 0.5 && this.seaIce[k] < 1;
    for (let j = 1; j < nLat - 1; j++) {
      const lat = grid.lat[j];
      const dx = R * Math.max(grid.cosLat[j], 0.05) * grid.dLon;
      // Ekman-like surface drift with the wind everywhere at sea.
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        if (isOcean(k)) uo[k] = 0.02 * this.circ.u[k];
      }
      if (Math.abs(lat) < 0.06 || Math.abs(lat) > 1.25) continue;
      const curl = -(taux[j - 1] - taux[j + 1]) / (2 * R * grid.dLat);
      const beta = (2 * omega * Math.cos(lat)) / R;
      if (Math.abs(beta) < 1e-14) continue;
      const vInt = clamp(curl / (1025 * beta) / H, -0.08, 0.08);
      // Find a land cell to start from (rows with no land: circumpolar, no gyre).
      let start = -1;
      for (let i = 0; i < nLon; i++) if (!isOcean(j * nLon + i)) start = i;
      if (start < 0) continue;
      // Walk eastward through basins; each basin's first (westernmost) cells carry the return flow.
      let i = (start + 1) % nLon;
      for (let n = 0; n < nLon; ) {
        while (n < nLon && !isOcean(j * nLon + i)) {
          i = (i + 1) % nLon;
          n++;
        }
        const cells: number[] = [];
        while (n < nLon && isOcean(j * nLon + i)) {
          cells.push(j * nLon + i);
          i = (i + 1) % nLon;
          n++;
        }
        if (cells.length < 3) continue;
        const wbc = Math.max(1, Math.round(cells.length / 12));
        for (let c = wbc; c < cells.length; c++) vo[cells[c]] = vInt;
        const back = (-vInt * (cells.length - wbc)) / wbc;
        for (let c = 0; c < wbc; c++) vo[cells[c]] = clamp(back, -1.5, 1.5);
      }
      void dx;
    }
    // Heat moves with the whole wind-driven layer, so the 50 m mixed layer is carried ~H/50 faster.
    const f = H / 50;
    const tmpU = new Float64Array(grid.N),
      tmpV = new Float64Array(grid.N);
    for (let k = 0; k < grid.N; k++) {
      tmpU[k] = clamp(uo[k] * f, -1.2, 1.2);
      tmpV[k] = clamp(vo[k] * f, -1.2, 1.2);
    }
    // Advect *water* temperature: never below freezing, and land/ice cells stand in with their
    // latitude's mean open-water temperature (so frozen or continental surfaces don't leak in).
    const Tf = this.vol.TfreezeOcean;
    const rowMean = new Float64Array(nLat).fill(NaN);
    for (let j = 0; j < nLat; j++) {
      let s = 0,
        w = 0;
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        if (this.oceanMask[k] > 0.5) {
          s += Math.max(this.Ts[k], Tf);
          w++;
        }
      }
      if (w > 0) rowMean[j] = s / w;
    }
    for (let j = 0; j < nLat; j++)
      if (Number.isNaN(rowMean[j])) {
        let v = Tf;
        for (let d = 1; d < nLat; d++) {
          if (j - d >= 0 && !Number.isNaN(rowMean[j - d])) {
            v = Math.min(rowMean[j - d], Tf + 4);
            break;
          }
          if (j + d < nLat && !Number.isNaN(rowMean[j + d])) {
            v = Math.min(rowMean[j + d], Tf + 4);
            break;
          }
        }
        rowMean[j] = v;
      }
    const X = new Float64Array(grid.N);
    for (let k = 0; k < grid.N; k++) X[k] = this.oceanMask[k] > 0.5 ? Math.max(this.Ts[k], Tf) : rowMean[Math.floor(k / nLon)];
    const X0 = Float64Array.from(X);
    grid.advect(X, tmpU, tmpV, R, dt, 0.12);
    for (let k = 0; k < grid.N; k++) {
      const m = this.oceanMask[k];
      if (m > 0) this.Ts[k] += m * (X[k] - X0[k]);
    }
  }

  /**
   * A volcanic eruption at (lat, lon) with explosivity index `vei` (5 = Mt St Helens,
   * 6 = Pinatubo, 7 = Tambora, 8 = a supervolcano). Sulfate aerosols cool the planet for a few
   * years; the CO₂ (large only for huge eruptions) warms it slowly.
   */
  eruption(lat: number, lon: number, vei: number): void {
    const A = this.area();
    this.aerosol += 0.025 * Math.pow(4, vei - 6) * (5.1e14 / A);
    this.gas.CO2 += 5e10 * Math.pow(10, vei - 6) * (vei >= 8 ? 20 : 1);
    this.eruptions.push({ lat, lon, vei });
    if (this.eruptions.length > 8) this.eruptions.shift();
    const name = vei >= 8 ? 'A supervolcano' : vei >= 7 ? 'A colossal eruption' : vei >= 6 ? 'A major eruption' : 'An eruption';
    this.onEvent?.(`${name} (VEI ${vei}) at ${(lat * 57.3).toFixed(0)}°, ${(lon * 57.3).toFixed(0)}°: sulfate haze will cool the climate for years.`, vei >= 7 ? 'warn' : 'info');
    this.version++;
  }

  /**
   * Evolution of life, paced like Earth's: microbes appear within a few hundred million years
   * of stable liquid water (and make methane in oxygen-free air); oxygenic photosynthesis
   * slowly oxygenates the air (a Great Oxidation Event); with enough oxygen for an ozone layer,
   * plants colonize land (changing albedo and weathering); then complex animals — the
   * precondition for intelligence. Long hostile spells cause extinctions.
   */
  private evolveLife(dt: number): void {
    if (this.spinningUp || dt <= 0) return;
    const yr = dt / YEAR;
    const T = this.stats.meanT;
    const pp = this.bulk?.pp ?? ({} as Record<string, number>);
    const O2 = pp.O2 ?? 0;
    const wet = this.vol.id === 'H2O' && this.oceanMass() > 0 && this.P > 1e3;
    const ok = wet && T > 250 && T < 345;
    const prev = this.lifeStage;
    if (!ok) {
      this.hostileYears += yr;
      if (this.lifeStage > 0 && this.hostileYears > 2e5) {
        // Extremophiles may hang on in a cold ocean under ice; heat and dryness sterilize.
        this.lifeStage = wet && T <= 250 ? Math.min(this.lifeStage, 1) : 0;
      }
    } else {
      this.hostileYears = 0;
      const mean = [3e8, 6e8, 4e8, 3e8][this.lifeStage];
      const ready = this.lifeStage === 2 ? O2 > 2e3 : this.lifeStage === 3 ? O2 > 1e4 && T > 265 && T < 320 : this.lifeStage < 4;
      if (mean && ready) {
        // Each world needs its own (seeded) time for each step of evolution: 0.5–1.5× the mean.
        this.lifeProgress += yr;
        const u = (((this.seed * 9301 + this.lifeStage * 49297 + 233) % 233280) + 233280) % 233280;
        if (this.lifeProgress > mean * (0.5 + u / 233280)) {
          this.lifeStage++;
          this.lifeProgress = 0;
        }
      }
      const A = this.area();
      // Methanogens warm an anoxic world.
      if (this.lifeStage >= 1 && O2 < 1e3) {
        const target = this.partialToMass('CH4', 60 * Math.min(1, this.P / 1e5));
        if (this.gas.CH4 < target) this.gas.CH4 += (target - this.gas.CH4) * (1 - Math.exp(-yr / 1e5));
      }
      // Net oxygen from photosynthesis and organic burial (~0.6 Gyr to fill an Earth-like sky).
      if (this.lifeStage >= 2 && O2 < 0.28 * Math.max(this.P, 1)) {
        const prod = 2e9 * yr * (A / 5.1e14);
        this.gas.O2 += prod;
        this.gas.CO2 = Math.max(0, this.gas.CO2 - Math.min(prod * (44 / 32), this.gas.CO2 * 0.3));
      }
    }
    const want = this.lifeStage >= 3;
    if (want !== this.biosphere) this.biosphere = want;
    if (this.lifeStage !== prev) {
      const msg = [
        'All life has been extinguished.',
        'Microbial life has appeared in the oceans!',
        'Microbes have learned oxygenic photosynthesis — oxygen is starting to build up.',
        'Plants have colonized the land, changing its colour and albedo.',
        'Complex animals have evolved.',
      ][this.lifeStage];
      this.onEvent?.(this.lifeStage < prev ? (this.lifeStage === 0 ? msg : 'A mass extinction: only microbes survive.') : msg, this.lifeStage < prev ? 'danger' : 'info');
    }
  }

  /** Whittaker-style biome of a cell (index into BIOMES). */
  biomeAt(k: number): number {
    if (this.ocean[k] > 0.5) return this.seaIce[k] > 0.5 ? 1 : 0;
    const T = this.tAnnual[k] - 273.15;
    const P = this.pAnnual[k] * DAY * 365.25;
    if (this.snow[k] > 200 || T < -15) return 1;
    if (this.lifeStage < 3) return 9;
    if (T < -5) return 2;
    if (T < 3) return 3;
    if (P < 250) return 6;
    if (T < 20) return P > 750 ? 4 : 5;
    return P > 1500 ? 8 : P > 500 ? 7 : 6;
  }

  /** Random eruptions on geologically active worlds (only at time speeds where they matter). */
  private randomEruptions(dt: number, ctx: ClimateContext): void {
    if (!ctx.geology || this.spinningUp || dt > 50 * YEAR || ctx.geothermal < 0.03) return;
    this.eruptClock += dt;
    const activity = clamp(ctx.geothermal / 0.087, 0.3, 30);
    // VEI ≥ 6 roughly every 80 years on Earth.
    const rate = activity / (80 * YEAR);
    if (Math.random() > 1 - Math.exp(-dt * rate)) return;
    const r = Math.random();
    const vei = r < 0.85 ? 6 : r < 0.985 ? 7 : 8;
    // Prefer high, land cells (volcanic arcs and hotspots).
    let best = 0,
      bestK = 0;
    for (let t = 0; t < 12; t++) {
      const k = Math.floor(Math.random() * this.grid.N);
      const s = this.elev[k] + (this.ocean[k] < 0.5 ? 2000 : 0) + Math.random() * 1500;
      if (s > best) {
        best = s;
        bestK = k;
      }
    }
    const j = Math.floor(bestK / this.grid.nLon);
    this.eruption(this.grid.lat[j], this.grid.lon[bestK % this.grid.nLon], vei);
  }

  private updateClouds(P: number) {
    const { grid } = this;
    const N = grid.N;
    const itcz = this.circ.itcz;
    const edge = this.circ.hadleyEdge;
    for (let k = 0; k < N; k++) {
      if (P < 50 || this.waterTotal <= 0) {
        this.cloud[k] = 0;
        continue;
      }
      const lat = grid.lat[Math.floor(k / grid.nLon)];
      const s = Math.abs(lat - itcz);
      // Subsiding branch of the Hadley cell is dry and clear; the ITCZ is cloudy.
      const subsid = this.circ.nCells > 1 ? 0.45 * Math.exp(-((s - edge) * (s - edge)) / 0.03) : 0;
      const itczBoost = 0.2 * Math.exp(-(s * s) / 0.01);
      const ws = this.wsCache[k] || this.wsat(this.Ts[k], this.bulk.pDry);
      const rh = ws > 0 ? this.w[k] / ws : 0;
      const ls = Math.pow(clamp((rh - 0.55) / 0.4, 0, 1), 1.3) * 0.75;
      const conv = clamp((this.precip[k] * DAY) / 12, 0, 0.6) + itczBoost;
      const st = this.stormFactor[k];
      this.cloud[k] = clamp((1 - (1 - ls) * (1 - conv) * (1 - st)) * (1 - subsid), 0, 1) * smoothstep(50, 2000, P);
    }
  }

  private updateClimatology(dt: number) {
    const aY = 1 - Math.exp(-dt / YEAR);
    const aM = 1 - Math.exp(-dt / (30 * DAY));
    for (let k = 0; k < this.grid.N; k++) {
      const T = this.Ts[k];
      this.tAnnual[k] += (T - this.tAnnual[k]) * aY;
      this.tMonth[k] += (T - this.tMonth[k]) * aM;
      this.pAnnual[k] += (this.precip[k] - this.pAnnual[k]) * aY;
      this.tWarm[k] = Math.max(this.tMonth[k], this.tWarm[k] - (this.tWarm[k] - this.tAnnual[k]) * aY * 0.5);
      this.tCold[k] = Math.min(this.tMonth[k], this.tCold[k] - (this.tCold[k] - this.tAnnual[k]) * aY * 0.5);
    }
  }

  private computeStats(ctx: ClimateContext, bulk: BulkAtmosphere, tauMean: number, dt: number) {
    const { grid } = this;
    const { nLat, nLon } = grid;
    const A = 4 * Math.PI * this.R * this.R;
    let mT = 0,
      mTa = 0,
      mn = Infinity,
      mx = -Infinity,
      oc = 0,
      ice = 0,
      sice = 0,
      sn = 0,
      cl = 0,
      ins = 0,
      refl = 0,
      asr = 0,
      olr = 0,
      pr = 0,
      hab = 0,
      hum = 0,
      veg = 0,
      vap = 0,
      landIce = 0,
      frost = 0,
      magma = 0;
    const Tb = this.boilingPoint(this.P);
    const o2 = bulk.pp.O2;
    const co2 = bulk.pp.CO2;
    const humanAtm = o2 > 1.6e4 && o2 < 5e4 && co2 < 1500 && this.P > 5e4 && this.P < 3e5;
    for (let j = 0; j < nLat; j++) {
      const a = grid.cellArea[j];
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const T = this.Ts[k];
        mT += T * a;
        mTa += this.Ta[k] * a;
        if (T < mn) mn = T;
        if (T > mx) mx = T;
        const fo = this.ocean[k];
        oc += fo * a;
        const si = fo * smoothstep(0.02, 0.3, this.seaIce[k]);
        const snw = (1 - fo) * smoothstep(5, 100, this.snow[k]);
        sice += si * a;
        sn += snw * a;
        ice += (si + snw) * a;
        cl += this.cloud[k] * a;
        ins += this.insol[k] * a;
        refl += this.insol[k] * this.albedo[k] * a;
        asr += this.asr[k] * a;
        olr += this.olr[k] * a;
        pr += this.precip[k] * a;
        veg += this.veg[k] * (1 - fo) * a;
        vap += this.w[k] * a;
        landIce += (1 - fo) * this.snow[k] * a;
        frost += this.frost[k] * a;
        if (T > 1300) magma += a;
        const liquidOK = this.vol.id === 'H2O' && this.P > 611 && T > 273.15 && T < Tb && si + snw < 0.5;
        const hv = liquidOK ? 1 : 0;
        this.habitable[k] = hv;
        hab += hv * a;
        if (hv && humanAtm && T > 263 && T < 313) hum += a;
      }
    }
    const rho = this.vol.rhoLiquid;
    const oceanMass = this.oceanMass();
    const Te = Math.pow(asr / SIGMA, 0.25);
    const runaway = this.vol.id === 'H2O' && this.waterTotal > 0 && (vap * A > 0.3 * this.waterTotal || mT > 450);
    const snowball = ice > 0.93 && oc > 0.3;
    const pp: Record<string, number> = { ...bulk.pp };
    pp[this.vol.id === 'H2O' ? 'H2O' : 'CH4v'] = vap * this.g;
    this.stats = {
      meanT: mT,
      minT: mn,
      maxT: mx,
      meanTa: mTa,
      P: this.P,
      pp,
      oceanFrac: oc,
      iceFrac: ice,
      seaIceFrac: sice,
      snowFrac: sn,
      cloudFrac: cl,
      albedo: ins > 0 ? refl / ins : 0,
      asr,
      olr,
      insolation: ins,
      precip: pr * DAY,
      seaLevel: this.seaLevel,
      habitable: hab,
      humanHabitable: hum,
      vegetation: veg,
      waterGEL: this.waterTotal / (rho * A),
      vapourGEL: vap / rho,
      oceanGEL: oceanMass / (rho * A),
      iceGEL: landIce / rho,
      frostGEL: frost / 1500,
      magmaFrac: magma,
      greenhouse: mT - Te,
      tauIR: tauMean,
      runaway,
      snowball,
      subsurfaceOcean: sice > 0.97 * oc && oc > 0.5 && oceanMass > 0 && mT < this.vol.Tmelt,
      dustTau: this.dust,
      aerosolTau: this.aerosol,
      hadleyEdge: this.circ.hadleyEdge,
      nCells: this.circ.nCells,
      equatorPoleDT: this.circ.equatorPoleDT,
      boilingPoint: Tb,
    };
    // Notable transitions.
    const f = this.flags;
    if (runaway && !f.runaway) this.onEvent?.('Runaway greenhouse! Oceans are boiling into a steam atmosphere.', 'danger');
    if (snowball && !f.snowball) this.onEvent?.('Snowball state: ice has covered almost the entire surface.', 'warn');
    if (!snowball && f.snowball) this.onEvent?.('The snowball is thawing — open water has returned.', 'info');
    if (magma > 0.5 && !f.magma) this.onEvent?.('Surface has melted into a magma ocean.', 'danger');
    const hasOcean = oceanMass > 0.001 * this.waterTotal && this.waterTotal > 0;
    if (!hasOcean && f.ocean && this.waterTotal > 0 && mT > 300) this.onEvent?.('The last of the oceans has evaporated.', 'danger');
    f.runaway = runaway;
    f.snowball = snowball;
    f.magma = magma > 0.5;
    f.ocean = hasOcean;
    // History (sampled on the real-time clock).
    this.historyClock += ctx.realDt;
    if (this.historyClock >= 0.3 || this.history.t.length === 0 || dt > 50 * YEAR) {
      this.historyClock = 0;
      this.history.push(ctx.time, {
        T: mT,
        Tmin: mn,
        Tmax: mx,
        P: this.P,
        CO2: bulk.pp.CO2,
        ice: ice,
        ocean: oc,
        cloud: cl,
        albedo: ins > 0 ? refl / ins : 0,
        precip: pr * DAY,
        seaLevel: Number.isFinite(this.seaLevel) ? this.seaLevel : NaN,
        habitable: hab,
        water: this.waterTotal / (rho * A),
        veg,
      });
    }
  }

  private emptyStats(): ClimateStats {
    return {
      meanT: 0,
      minT: 0,
      maxT: 0,
      meanTa: 0,
      P: 0,
      pp: {},
      oceanFrac: 0,
      iceFrac: 0,
      seaIceFrac: 0,
      snowFrac: 0,
      cloudFrac: 0,
      albedo: 0,
      asr: 0,
      olr: 0,
      insolation: 0,
      precip: 0,
      seaLevel: 0,
      habitable: 0,
      humanHabitable: 0,
      vegetation: 0,
      waterGEL: 0,
      vapourGEL: 0,
      oceanGEL: 0,
      iceGEL: 0,
      frostGEL: 0,
      magmaFrac: 0,
      greenhouse: 0,
      tauIR: 0,
      runaway: false,
      snowball: false,
      subsurfaceOcean: false,
      dustTau: 0,
      aerosolTau: 0,
      hadleyEdge: 0,
      nCells: 0,
      equatorPoleDT: 0,
      boilingPoint: 373,
    };
  }

  // ------------------------------------------------------------------ events

  /**
   * An impact at body-fixed (lat, lon). Carves a crater, heats the site, lofts dust,
   * vaporises water and delivers the impactor's volatiles.
   */
  impact(o: { lat: number; lon: number; energy: number; crater: { diameter: number; depth: number } | null; water: number; time: number; targetMass: number; vesc: number }): void {
    const { grid } = this;
    const A = this.area();
    if (o.crater && o.crater.diameter > 2e3) {
      const rec: CraterRecord = { lat: o.lat, lon: o.lon, diameter: o.crater.diameter, depth: o.crater.depth, time: o.time };
      this.craters.push(rec);
      applyCrater(this.terrain, rec, this.R);
      this.terrainVersion++;
      this.computeCellTerrain();
    }
    const specific = o.energy / o.targetMass;
    if (specific > 2e5) {
      // Global resurfacing: magma ocean, volatiles to the atmosphere.
      for (let k = 0; k < grid.N; k++) {
        this.Ts[k] = Math.max(this.Ts[k], 2200);
        this.Ta[k] = Math.max(this.Ta[k], 1800);
        this.snow[k] = 0;
        this.seaIce[k] = 0;
        this.frost[k] = 0;
        this.veg[k] = 0;
      }
      this.stripAtmosphere(clamp(specific / 5e6, 0.1, 0.9));
      this.onEvent?.('Giant impact: the crust has been melted into a global magma ocean.', 'danger');
    } else {
      // Local melt sheet and regional heating.
      const rc = o.crater ? (o.crater.diameter / 2) * 2.2 : 0;
      const ang = rc / this.R;
      for (let k = 0; k < grid.N; k++) {
        const j = Math.floor(k / grid.nLon);
        const i = k % grid.nLon;
        const cosd = Math.sin(o.lat) * grid.sinLat[j] + Math.cos(o.lat) * grid.cosLat[j] * Math.cos(grid.lon[i] - o.lon);
        const d = Math.acos(clamp(cosd, -1, 1));
        const cellR = Math.max(grid.dLat, ang);
        if (d < cellR * 1.2) {
          const f = 1 - d / (cellR * 1.2);
          const hot = Math.min(2000, 300 + 1700 * clamp(Math.log10(Math.max(o.energy, 1)) - 18, 0, 6) / 6);
          this.Ts[k] = Math.max(this.Ts[k], this.Ts[k] + (hot - this.Ts[k]) * f);
          this.snow[k] *= 1 - f;
          this.seaIce[k] *= 1 - f;
          this.veg[k] *= 1 - f;
        }
      }
      // Global thermal pulse and impact winter.
      const pulse = (0.05 * o.energy) / (A * 1.2e7);
      for (let k = 0; k < grid.N; k++) {
        this.Ts[k] += pulse;
        this.Ta[k] += pulse;
      }
      if (this.P > 100) this.aerosol = Math.min(80, this.aerosol + o.energy / 1e22);
      // Ocean strikes throw water vapour into the air.
      const ocean = this.oceanMass();
      if (ocean > 0) {
        const vap = Math.min(ocean * 0.5, (0.03 * o.energy) / this.vol.Lvap);
        for (let k = 0; k < grid.N; k++) this.w[k] += vap / A;
      }
      // Atmospheric blow-off for energetic impacts.
      const atmMass = (this.P * A) / this.g;
      if (atmMass > 0) this.stripAtmosphere(clamp((0.02 * o.energy) / (atmMass * o.vesc * o.vesc), 0, 0.5));
    }
    if (o.water > 0) this.waterTotal += o.water;
    this.updateSeaLevel();
    this.version++;
  }

  /** Global heating by an external energy pulse (supernova fluence etc.), J/m². */
  heatPulse(jPerM2: number): void {
    for (let k = 0; k < this.grid.N; k++) {
      const c = this.C1[k] + this.C2[k] || 1e7;
      const dT = jPerM2 / c;
      this.Ts[k] += dT;
      this.Ta[k] += dT;
    }
    this.version++;
  }

  // ------------------------------------------------------------------ fields for rendering

  field(id: FieldId): Float64Array {
    switch (id) {
      case 'Ts':
        return this.Ts;
      case 'Ta':
        return this.Ta;
      case 'precip':
        return this.precip;
      case 'cloud':
        return this.cloud;
      case 'w':
        return this.w;
      case 'snow':
        return this.snow;
      case 'seaIce':
        return this.seaIce;
      case 'ocean':
        return this.ocean;
      case 'veg':
        return this.veg;
      case 'pAnom':
        return this.circ.pAnom;
      case 'insol':
        return this.insol;
      case 'albedo':
        return this.albedo;
      case 'habitable':
        return this.habitable;
      case 'elev':
        return this.elev;
      case 'tAnnual':
        return this.tAnnual;
      case 'frost':
        return this.frost;
      case 'current': {
        const out = new Float64Array(this.grid.N);
        for (let k = 0; k < out.length; k++) out[k] = Math.hypot(this.uo[k], this.vo[k]);
        return out;
      }
      case 'biome': {
        const out = new Float64Array(this.grid.N);
        for (let k = 0; k < out.length; k++) out[k] = this.biomeAt(k);
        return out;
      }
      case 'wind': {
        const out = new Float64Array(this.grid.N);
        for (let k = 0; k < out.length; k++) out[k] = Math.hypot(this.circ.u[k], this.circ.v[k]);
        return out;
      }
    }
  }

  // ------------------------------------------------------------------ civilization & biosphere

  seedCivilization(mode: 'modern' | 'preindustrial' | 'emergent'): void {
    this.civ = new Civilization(this.grid, mode, 0, this.seed);
    this.civ.onEvent = (m, k) => this.onEvent?.(m, k);
    this.civ.seedPopulation = mode === 'modern' ? 8.2e9 : mode === 'preindustrial' ? 1e9 : 1e5;
    if (mode === 'modern') {
      // Present-day Earth: ~140 ppm of today's CO₂ is anthropogenic and still airborne.
      this.civ.excessCO2 = (17 * 4 * Math.PI * this.R * this.R) / this.g;
    }
    this.version++;
  }

  removeCivilization(): void {
    this.civ = null;
    this.version++;
  }

  /** Breathable for humans: oxygen partial pressure, CO₂ and total pressure within tolerance. */
  breathable(): boolean {
    const pp = this.bulk?.pp;
    if (!pp) return false;
    return pp.O2 > 1.4e4 && pp.O2 < 6e4 && pp.CO2 < 3000 && this.P > 4e4 && this.P < 4e5;
  }

  /** Advance civilization (if any) and check for the emergence of intelligent life. */
  civStep(dt: number, ctx: ClimateContext): void {
    if (dt <= 0) return;
    const A = 4 * Math.PI * ctx.R * ctx.R;
    if (!this.civ && this.lifeStage >= 4 && this.stats.humanHabitable > 0.08) {
      this.lifeClock += dt;
      // Intelligence emerges on long-habitable living worlds (rare per step, likely over ~100 Myr).
      const p = 1 - Math.exp(-dt / (1.5e8 * YEAR));
      if (this.lifeClock > 5e7 * YEAR && Math.random() < p) {
        this.seedCivilization('emergent');
        this.onEvent?.('Intelligent life has emerged and begun to build a civilization!', 'info');
      }
    }
    const civ = this.civ;
    if (!civ) return;
    if (civ.pop.length !== this.grid.N) civ.regrid(this.grid);
    const fx = civ.step(dt, {
      grid: this.grid,
      area: A,
      ocean: this.ocean,
      Ts: this.Ts,
      tAnnual: this.tAnnual,
      pAnnual: this.pAnnual,
      snow: this.snow,
      veg: this.veg,
      breathable: this.breathable(),
      hasOcean: this.oceanMass() > 0,
      time: ctx.time,
    });
    this.gas.CO2 = Math.max(0, this.gas.CO2 + fx.co2);
    this.aerosol = Math.max(this.aerosol, fx.aerosol);
    // Farms and cities replace forest: higher albedo, carbon released.
    if (this.biosphere && civ.justSeeded) {
      // Existing farmland at the start: apply land use without a carbon pulse.
      for (let k = 0; k < this.grid.N; k++) this.veg[k] *= 1 - civ.clearing(k, this.grid, A);
      civ.justSeeded = false;
    } else if (this.biosphere) {
      let lost = 0;
      for (let k = 0; k < this.grid.N; k++) {
        const c = civ.clearing(k, this.grid, A);
        if (c <= 0) continue;
        const target = this.veg[k] * (1 - c);
        if (target < this.veg[k]) {
          const d = (this.veg[k] - target) * (1 - Math.exp(-dt / (30 * YEAR)));
          this.veg[k] -= d;
          lost += d * (1 - this.ocean[k]) * this.grid.cellArea[Math.floor(k / this.grid.nLon)];
        }
      }
      // ~12 kg C per m² of forest → CO₂.
      this.gas.CO2 += lost * A * 12 * (44 / 12);
    }
  }

  /** Mass (kg) of gas `id` corresponding to partial pressure p (Pa) in the current mixture. */
  partialToMass(id: GasId, p: number): number {
    const molar = this.bulk?.molar || 0.029;
    return (p * this.area() * GASES[id].molar) / (this.g * molar);
  }

  /** Biomass carbon (kg C) held by vegetation. */
  vegetationCarbon(): number {
    const A = this.area();
    let c = 0;
    for (let k = 0; k < this.grid.N; k++) c += this.veg[k] * (1 - this.ocean[k]) * this.grid.cellArea[Math.floor(k / this.grid.nLon)];
    return c * A * 12;
  }

  // ------------------------------------------------------------------ persistence

  serialize(): unknown {
    const f = (a: Float64Array) => Array.from(a, (x) => Math.round(x * 1000) / 1000);
    return {
      res: this.res,
      style: this.style,
      seed: this.seed,
      craters: this.craters,
      gas: this.gas,
      waterTotal: this.waterTotal,
      aerosol: this.aerosol,
      dust: this.dust,
      biosphere: this.biosphere,
      Ts: f(this.Ts),
      Ta: f(this.Ta),
      snow: f(this.snow),
      seaIce: f(this.seaIce),
      w: f(this.w),
      soil: f(this.soil),
      veg: f(this.veg),
      frost: f(this.frost),
      tAnnual: f(this.tAnnual),
      pAnnual: Array.from(this.pAnnual),
      history: this.history.toJSON(),
      civ: this.civ ? this.civ.serialize() : null,
      lifeClock: this.lifeClock,
      lifeStage: this.lifeStage,
      lifeProgress: this.lifeProgress,
      driftMyr: this.driftMyr,
      driftApplied: this.driftApplied,
    };
  }

  restore(o: any): void {
    if (!o) return;
    if (o.res && o.res !== this.res) this.setResolution(o.res);
    this.driftMyr = o.driftMyr ?? 0;
    this.driftApplied = o.driftApplied ?? 0;
    if (o.craters?.length || this.driftApplied > 0) {
      this.craters = o.craters ?? [];
      this.loadTerrain(this.style, this.seed);
      this.computeCellTerrain();
    }
    Object.assign(this.gas, o.gas ?? {});
    this.waterTotal = o.waterTotal ?? this.waterTotal;
    this.aerosol = o.aerosol ?? 0;
    this.dust = o.dust ?? this.dust;
    this.biosphere = o.biosphere ?? this.biosphere;
    const put = (dst: Float64Array, src?: number[]) => {
      if (src && src.length === dst.length) dst.set(src);
    };
    put(this.Ts, o.Ts);
    put(this.Ta, o.Ta);
    put(this.snow, o.snow);
    put(this.seaIce, o.seaIce);
    put(this.w, o.w);
    put(this.soil, o.soil);
    put(this.veg, o.veg);
    put(this.frost, o.frost);
    put(this.tAnnual, o.tAnnual);
    put(this.pAnnual, o.pAnnual);
    this.tMonth.set(this.Ts);
    this.tWarm.set(this.tAnnual);
    this.tCold.set(this.tAnnual);
    this.history = History.from(o.history);
    this.lifeClock = o.lifeClock ?? 0;
    this.lifeStage = o.lifeStage ?? (this.biosphere ? 4 : 0);
    this.lifeProgress = o.lifeProgress ?? 0;
    if (o.civ) {
      this.civ = new Civilization(this.grid, 'preindustrial', 0, this.seed);
      this.civ.onEvent = (m, k) => this.onEvent?.(m, k);
      this.civ.restore(o.civ);
    }
    this.updateSeaLevel();
    this.version++;
  }
}

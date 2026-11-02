import { DAY, M_EARTH, M_JUP, SIGMA, YEAR } from '../core/constants';
import { clamp, smoothstep, wrapPi } from '../core/math';
import { Rng } from '../core/rng';
import { LatLonGrid } from './grid';
import { History } from './history';
import { computeInsolation, type Illuminator } from './insolation';

export type GiantPalette = 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'auto';

export interface Vortex {
  id: number;
  lat: number;
  lon: number;
  /** Semi-axes (m). */
  a: number;
  b: number;
  color: [number, number, number];
  age: number;
  life: number;
  /** +1 anticyclone (most long-lived giant-planet storms), −1 cyclone. */
  sense: number;
  name: string;
}

export interface GiantContext {
  illum: Illuminator[];
  R: number;
  g: number;
  mass: number;
  omega: number;
  tInt: number;
  time: number;
  realDt: number;
  locked: boolean;
}

export interface GiantStats {
  Teff: number;
  T1bar: number;
  Teq: number;
  Tday: number;
  Tnight: number;
  sudarsky: number;
  sudarskyLabel: string;
  albedo: number;
  nJets: number;
  maxWind: number;
  equatorialJet: number;
  tauRad: number;
  hotspotOffset: number;
}

const CLASS_LABEL = ['', 'I — ammonia clouds', 'II — water clouds', 'III — cloudless', 'IV — alkali metals', 'V — silicate clouds'];

export class GasGiantClimate {
  grid = new LatLonGrid(24, 48);
  T: Float64Array;
  insol: Float64Array;
  u: Float64Array;
  palette: GiantPalette;
  iceGiant: boolean;
  seed: number;
  vortices: Vortex[] = [];
  /** Band edges (latitudes, rad) between alternating zones and belts. */
  bandEdges: number[] = [];
  nJets = 6;
  equatorialJet = 100;
  stats: GiantStats;
  version = 0;
  history = new History();
  private rng: Rng;
  private nextId = 1;
  private historyClock = 0;
  private tmp: Float64Array;
  onEvent: ((msg: string, kind: 'info' | 'warn' | 'danger') => void) | null = null;
  private lastClass = 0;

  constructor(palette: GiantPalette, seed: number, iceGiant: boolean, vortices?: { lat: number; lon: number; size: number; color: [number, number, number] }[]) {
    this.palette = palette;
    this.seed = seed;
    this.iceGiant = iceGiant;
    this.rng = new Rng(seed);
    this.T = new Float64Array(this.grid.N).fill(150);
    this.insol = new Float64Array(this.grid.N);
    this.u = new Float64Array(this.grid.nLat);
    this.tmp = new Float64Array(this.grid.N);
    if (vortices)
      for (const v of vortices)
        this.vortices.push({
          id: this.nextId++,
          lat: (v.lat * Math.PI) / 180,
          lon: (v.lon * Math.PI) / 180,
          a: v.size,
          b: v.size * 0.65,
          color: v.color,
          age: 0,
          life: Infinity,
          sense: 1,
          name: 'Great Spot',
        });
    this.stats = {
      Teff: 0,
      T1bar: 0,
      Teq: 0,
      Tday: 0,
      Tnight: 0,
      sudarsky: 1,
      sudarskyLabel: CLASS_LABEL[1],
      albedo: 0.34,
      nJets: 0,
      maxWind: 0,
      equatorialJet: 0,
      tauRad: 0,
      hotspotOffset: 0,
    };
  }

  /** Bond albedo by temperature class (smoothly blended). */
  private albedoFor(T1bar: number): number {
    const a1 = this.iceGiant ? 0.3 : 0.34;
    const t = T1bar;
    if (t < 200) return a1;
    if (t < 350) return a1 + (0.8 - a1) * smoothstep(200, 260, t);
    if (t < 900) return 0.8 + (0.12 - 0.8) * smoothstep(350, 450, t);
    if (t < 1500) return 0.12 + (0.04 - 0.12) * smoothstep(900, 1000, t);
    return 0.04 + (0.5 - 0.04) * smoothstep(1500, 1700, t);
  }

  private classFor(T1bar: number): number {
    if (T1bar < 200) return 1;
    if (T1bar < 350) return 2;
    if (T1bar < 900) return 3;
    if (T1bar < 1500) return 4;
    return 5;
  }

  step(dt: number, ctx: GiantContext): void {
    if (!(dt > 0)) return;
    const { grid } = this;
    const { nLat, nLon, N } = grid;
    const R = ctx.R;
    computeInsolation(grid, ctx.illum, dt, this.insol);
    let meanIns = 0;
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) meanIns += this.insol[j * nLon + i] * grid.cellArea[j];
    // Global energetics.
    const T1prev = this.stats.T1bar || 150;
    const A = this.albedoFor(T1prev);
    const Teq = Math.pow(Math.max(0, (meanIns * (1 - A)) / SIGMA), 0.25);
    const Teff = Math.pow(Math.pow(Teq, 4) + Math.pow(ctx.tInt, 4), 0.25);
    const T1bar = 1.3 * Teff;
    const cls = this.classFor(T1bar);
    if (this.lastClass && cls !== this.lastClass) this.onEvent?.(`Atmosphere changed to Sudarsky class ${CLASS_LABEL[cls]}.`, 'info');
    this.lastClass = cls;
    // Jets from the Rhines scale.
    const absOm = Math.max(Math.abs(ctx.omega), 1e-8);
    const beta = (2 * absOm) / R;
    const Urms = clamp(40 * Math.pow(Teff / 125, 1.2), 20, 400);
    const Lb = Math.PI * Math.sqrt((2 * Urms) / beta);
    this.nJets = clamp(Math.round((Math.PI * R) / 2 / Lb), 1, 10);
    const hot = Teq > 900 && ctx.locked;
    if (hot) this.equatorialJet = Math.min(5000, 2.5 * Teq);
    else if (this.iceGiant) this.equatorialJet = -clamp(400 * Math.pow(Teff / 59, 0.5), 50, 500);
    else this.equatorialJet = clamp(100 * Math.pow(absOm / 1.76e-4, -1) * (this.palette === 'saturn' ? 4 : 1), 30, 500);
    const rot = Math.sign(ctx.omega) || 1;
    let maxWind = 0;
    for (let j = 0; j < nLat; j++) {
      const phi = grid.lat[j];
      let u: number;
      if (hot) u = this.equatorialJet * Math.exp(-(phi * phi) / 0.25);
      else if (this.iceGiant) u = this.equatorialJet * Math.cos(2.2 * phi) * Math.exp(-Math.pow(phi / 1.2, 6));
      else {
        const eq = this.equatorialJet * Math.exp(-(phi * phi) / 0.03);
        const jets = Urms * 0.9 * Math.cos(2 * this.nJets * phi) * Math.cos(phi) * (1 - smoothstep(1.2, 1.5, Math.abs(phi)));
        u = eq + jets;
      }
      this.u[j] = u * rot;
      maxWind = Math.max(maxWind, Math.abs(u));
    }
    // Band edges (deterministic per seed, jittered).
    const edges: number[] = [];
    const rr = new Rng(this.seed + 99);
    const nb = Math.max(2, this.nJets * 2 - 1);
    for (let b = 1; b <= nb; b++) {
      const base = (b / (nb + 1)) * (Math.PI / 2) * 0.95;
      edges.push(base + rr.range(-0.04, 0.04));
    }
    this.bandEdges = edges;
    // Radiative timescale at the photosphere (P ~ 0.25 bar).
    const cp = 1.3e4;
    const tauRad = (cp * 2.5e4) / (ctx.g * 4 * SIGMA * Math.pow(Math.max(T1bar, 30), 3));
    // Temperature field: relax toward local radiative equilibrium, advect zonally, mix meridionally.
    const a = 1 - Math.exp(-dt / tauRad);
    const tInt4 = Math.pow(ctx.tInt, 4);
    for (let k = 0; k < N; k++) {
      const Tloc = 1.3 * Math.pow((this.insol[k] * (1 - A)) / SIGMA + tInt4, 0.25);
      this.T[k] += (Tloc - this.T[k]) * a;
    }
    const advDt = Math.min(dt, 5 * tauRad + 10 * DAY);
    for (let j = 0; j < nLat; j++) {
      const cl = Math.max(grid.cosLat[j], 0.05);
      const shift = (this.u[j] * advDt) / (R * cl) / grid.dLon;
      const s = ((shift % nLon) + nLon) % nLon;
      const i0 = Math.floor(s);
      const f = s - i0;
      for (let i = 0; i < nLon; i++) {
        const src0 = (i - i0 + nLon * 2) % nLon;
        const src1 = (src0 - 1 + nLon) % nLon;
        this.tmp[j * nLon + i] = this.T[j * nLon + src0] * (1 - f) + this.T[j * nLon + src1] * f;
      }
    }
    this.T.set(this.tmp);
    grid.diffuse(this.T, 1, 5e5, R, dt);
    // Vortices drift with the jets and age on a visual clock.
    const vdt = Math.min(dt, Math.max(ctx.realDt, 0) * 20 * DAY);
    for (const v of this.vortices) {
      v.age += vdt;
      const uj = this.uAt(v.lat);
      v.lon = wrapPi(v.lon + (uj * 0.3 * vdt) / (R * Math.max(Math.cos(v.lat), 0.1)));
    }
    this.vortices = this.vortices.filter((v) => v.age < v.life);
    if (this.vortices.length < 8 && T1bar < 1500 && this.rng.chance(Math.min(1, vdt / (60 * DAY)))) this.spawnVortex(R);
    // Stats.
    let tMean = 0,
      tDay = 0,
      tNight = 0,
      wd = 0,
      wn = 0;
    let hot0 = -Infinity;
    let hotLon = 0;
    const subLon = ctx.illum.length ? Math.atan2(ctx.illum[0].dir[1], ctx.illum[0].dir[0]) : 0;
    const jEq = Math.floor(nLat / 2);
    for (let j = 0; j < nLat; j++)
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const w = grid.cellArea[j];
        tMean += this.T[k] * w;
        if (this.insol[k] > 0) {
          tDay += this.T[k] * w;
          wd += w;
        } else {
          tNight += this.T[k] * w;
          wn += w;
        }
        if (j === jEq && this.T[k] > hot0) {
          hot0 = this.T[k];
          hotLon = grid.lon[i];
        }
      }
    this.stats = {
      Teff,
      T1bar,
      Teq,
      Tday: wd > 0 ? tDay / wd : tMean,
      Tnight: wn > 0 ? tNight / wn : tMean,
      sudarsky: cls,
      sudarskyLabel: CLASS_LABEL[cls],
      albedo: A,
      nJets: this.nJets,
      maxWind,
      equatorialJet: this.equatorialJet,
      tauRad,
      hotspotOffset: ctx.locked ? (wrapPi(hotLon - subLon) * 180) / Math.PI : 0,
    };
    this.historyClock += ctx.realDt;
    if (this.historyClock > 0.3 || this.history.t.length === 0 || dt > 50 * YEAR) {
      this.historyClock = 0;
      this.history.push(ctx.time, { T: T1bar, Teff, albedo: A, wind: maxWind });
    }
    this.version++;
  }

  /** Zonal wind (m/s) at latitude (rad), interpolated between rows. */
  uAt(lat: number): number {
    const { nLat } = this.grid;
    const y = clamp((0.5 - lat / Math.PI) * nLat - 0.5, 0, nLat - 1);
    const j0 = Math.floor(y);
    const j1 = Math.min(nLat - 1, j0 + 1);
    return this.u[j0] + (this.u[j1] - this.u[j0]) * (y - j0);
  }

  private rowCache: Float64Array | null = null;
  /** Zonal wind expanded to a full grid field (for sampling). */
  rowField(): Float64Array {
    const { nLat, nLon } = this.grid;
    if (!this.rowCache) this.rowCache = new Float64Array(this.grid.N);
    for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) this.rowCache[j * nLon + i] = this.u[j];
    return this.rowCache;
  }

  private spawnVortex(R: number) {
    const rng = this.rng;
    const lat = rng.range(-1.1, 1.1);
    const size = rng.range(1500e3, 6000e3) * (R / 7e7);
    const dark = this.palette === 'neptune' || (this.iceGiant && rng.chance(0.5));
    const color: [number, number, number] = dark ? [0.12, 0.18, 0.45] : rng.chance(0.3) ? [0.8, 0.5, 0.35] : [0.97, 0.96, 0.92];
    this.vortices.push({
      id: this.nextId++,
      lat,
      lon: rng.range(-Math.PI, Math.PI),
      a: size,
      b: size * rng.range(0.5, 0.75),
      color,
      age: 0,
      life: rng.range(0.5, 20) * YEAR,
      sense: rng.chance(0.8) ? 1 : -1,
      name: dark ? 'Dark spot' : 'White oval',
    });
  }

  serialize(): unknown {
    return { T: Array.from(this.T, (x) => Math.round(x * 10) / 10), vortices: this.vortices.map((v) => ({ ...v, life: Number.isFinite(v.life) ? v.life : -1 })), history: this.history.toJSON() };
  }

  restore(o: any): void {
    if (!o) return;
    if (o.T?.length === this.T.length) this.T.set(o.T);
    if (Array.isArray(o.vortices)) this.vortices = o.vortices.map((v: Vortex) => ({ ...v, life: v.life < 0 ? Infinity : v.life }));
    this.history = History.from(o.history);
  }
}

/** Intrinsic temperature of a giant planet from mass and age (Kelvin-Helmholtz cooling fit). */
export function giantIntrinsicTemp(mass: number, ageYr: number, iceGiant: boolean): number {
  const age = Math.max(1e7, ageYr) / 4.5e9;
  if (iceGiant) return 45 * Math.pow(mass / (17 * M_EARTH), 0.5) * Math.pow(age, -0.3);
  return 100 * Math.pow(mass / M_JUP, 0.55) * Math.pow(age, -0.32);
}

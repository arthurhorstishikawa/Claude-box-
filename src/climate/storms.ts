import { DAY } from '../core/constants';
import { clamp, wrapPi } from '../core/math';
import { Rng } from '../core/rng';
import type { LatLonGrid } from './grid';

export type StormKind = 'tropical' | 'extratropical' | 'dust';

export interface Storm {
  id: number;
  kind: StormKind;
  name: string;
  lat: number;
  lon: number;
  /** Maximum sustained wind (m/s). */
  vmax: number;
  peak: number;
  /** Outer radius of the circulation (m). */
  radius: number;
  age: number;
  life: number;
  /** +1 counter-clockwise seen from above the north pole. */
  spin: number;
  /** Central pressure deficit (Pa). */
  deficit: number;
}

const NAMES = [
  'Ada', 'Boreas', 'Calla', 'Dorian', 'Eos', 'Fenris', 'Gaia', 'Helios', 'Iris', 'Juno', 'Kai', 'Lyra', 'Mistral',
  'Nimbus', 'Orion', 'Pele', 'Quill', 'Rhea', 'Sirocco', 'Typhon', 'Ulla', 'Vega', 'Wren', 'Xanthe', 'Yuki', 'Zephyr',
];

export function stormCategory(s: Storm): string {
  if (s.kind === 'dust') return s.radius > 3e6 ? 'Global dust storm' : 'Dust storm';
  if (s.kind === 'extratropical') return 'Extratropical cyclone';
  const v = s.vmax;
  if (v >= 100) return 'Hypercane';
  if (v >= 70) return 'Category 5 cyclone';
  if (v >= 58) return 'Category 4 cyclone';
  if (v >= 50) return 'Category 3 cyclone';
  if (v >= 43) return 'Category 2 cyclone';
  if (v >= 33) return 'Category 1 cyclone';
  if (v >= 18) return 'Tropical storm';
  return 'Tropical depression';
}

export interface StormEnv {
  grid: LatLonGrid;
  Ts: Float64Array;
  oceanFrac: Float64Array;
  seaIce: Float64Array;
  u: Float64Array;
  v: Float64Array;
  uCloud: Float64Array;
  zonalT: Float64Array;
  R: number;
  omega: number;
  P: number;
  rho: number;
  volatileFreezeK: number;
  hasLiquid: boolean;
  dusty: boolean;
  /** Insolation per cell (dust-storm genesis on dry worlds). */
  insol: Float64Array;
}

export class StormSystem {
  storms: Storm[] = [];
  private nextId = 1;
  private nameIdx = 0;
  private rng: Rng;
  onEvent: ((msg: string, s: Storm) => void) | null = null;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  update(dt: number, env: StormEnv): void {
    if (dt <= 0) return;
    const { grid, R } = env;
    const { nLat, nLon } = grid;
    const rng = this.rng;
    const absOm = Math.abs(env.omega);
    const rot = Math.sign(env.omega) || 1;
    const area = 4 * Math.PI * R * R;
    // --- Genesis
    if (env.P > 3e4 && env.hasLiquid && absOm > 2e-6 && this.storms.length < 14) {
      let expTrop = 0;
      let expExtra = 0;
      for (let j = 0; j < nLat; j++) {
        const la = Math.abs(grid.lat[j]);
        const cellA = grid.cellArea[j] * area;
        if (la > 0.087 && la < 0.52) {
          for (let i = 0; i < nLon; i++) {
            const k = j * nLon + i;
            const sstEx = env.Ts[k] - (env.volatileFreezeK + 28.3);
            if (env.oceanFrac[k] > 0.6 && env.seaIce[k] < 0.05 && sstEx > 0) expTrop += 1.27e-20 * cellA * sstEx * dt;
          }
        }
        if (la > 0.5 && la < 1.25 && j > 0 && j < nLat - 1) {
          const grad = Math.abs(env.zonalT[j - 1] - env.zonalT[j + 1]) / (2 * grid.dLat);
          if (grad > 20) expExtra += 1.6e-21 * cellA * nLon * (grad - 20) * dt;
        }
      }
      expTrop *= Math.min(1, (absOm / 7.29e-5) * 2);
      this.spawn(env, 'tropical', Math.min(expTrop, 3));
      this.spawn(env, 'extratropical', Math.min(expExtra, 3));
    }
    if (env.dusty && env.P > 50 && env.P < 2e4 && this.storms.length < 10) {
      let expDust = 0;
      for (let j = 0; j < nLat; j++) {
        const cellA = grid.cellArea[j] * area;
        for (let i = 0; i < nLon; i++) {
          const k = j * nLon + i;
          if (env.insol[k] > 250 && env.oceanFrac[k] < 0.1) expDust += 4e-21 * cellA * (env.insol[k] - 250) * 0.01 * dt;
        }
      }
      this.spawn(env, 'dust', Math.min(expDust, 2));
    }
    // --- Evolution
    for (const s of this.storms) {
      s.age += dt;
      const k = grid.cellOf(s.lat, s.lon);
      let su = grid.sample(env.u, s.lat, s.lon);
      let sv = grid.sample(env.v, s.lat, s.lon);
      if (s.kind === 'tropical') {
        su += -1.0 * rot;
        sv += 1.5 * Math.sign(s.lat || 1);
        const sstEx = env.Ts[k] - (env.volatileFreezeK + 28.3);
        const overWarmOcean = env.oceanFrac[k] > 0.5 && sstEx > 0 && env.seaIce[k] < 0.05;
        const vpot = overWarmOcean ? (20 + 30 * Math.sqrt(sstEx)) * Math.pow(env.P / 1e5, 0.1) : 0;
        const tau = overWarmOcean ? 1.5 * DAY : env.oceanFrac[k] < 0.5 ? 0.8 * DAY : 2 * DAY;
        s.vmax += (vpot - s.vmax) * (1 - Math.exp(-dt / tau));
        s.radius = 2.5e5 + 4e3 * s.vmax;
      } else if (s.kind === 'extratropical') {
        su = grid.sample(env.uCloud, s.lat, s.lon) * 0.7 + 4 * rot;
        sv += 1.0 * Math.sign(s.lat || 1);
        const life = s.age / s.life;
        s.vmax = 28 * Math.sin(Math.PI * clamp(life, 0, 1));
        s.radius = 9e5 + 6e5 * Math.sin(Math.PI * clamp(life, 0, 1));
      } else {
        const life = s.age / s.life;
        s.vmax = 25 * Math.sin(Math.PI * clamp(life, 0, 1));
        s.radius = Math.min(R * 1.2, s.radius * (1 + 0.6 * (dt / DAY) * (life < 0.5 ? 1 : -0.5)));
      }
      s.peak = Math.max(s.peak, s.vmax);
      s.deficit = 1.6 * env.rho * s.vmax * s.vmax;
      const cl = Math.max(0.05, Math.cos(s.lat));
      s.lat = clamp(s.lat + (sv * dt) / R, -1.5, 1.5);
      s.lon = wrapPi(s.lon + (su * dt) / (R * cl));
      if (s.kind === 'tropical' && Math.abs(s.lat) > 0.65 && s.vmax > 20) {
        // Extratropical transition.
        s.kind = 'extratropical';
        s.age = 0.3 * s.life;
      }
    }
    const before = this.storms.length;
    this.storms = this.storms.filter((s) => s.age < s.life && !(s.kind === 'tropical' && s.age > DAY && s.vmax < 12));
    void before;
  }

  private spawn(env: StormEnv, kind: StormKind, expected: number) {
    const rng = this.rng;
    let n = 0;
    let e = expected;
    while (e > 0) {
      if (rng.next() < Math.min(1, e)) n++;
      e -= 1;
    }
    const { grid } = env;
    for (let c = 0; c < n; c++) {
      // Pick a qualifying cell by rejection sampling.
      for (let tries = 0; tries < 60; tries++) {
        const j = Math.floor(rng.next() * grid.nLat);
        const i = Math.floor(rng.next() * grid.nLon);
        const k = j * grid.nLon + i;
        const la = Math.abs(grid.lat[j]);
        let ok = false;
        if (kind === 'tropical') ok = la > 0.087 && la < 0.45 && env.oceanFrac[k] > 0.6 && env.Ts[k] > env.volatileFreezeK + 28.3;
        else if (kind === 'extratropical') ok = la > 0.6 && la < 1.15;
        else ok = env.insol[k] > 250 && env.oceanFrac[k] < 0.1;
        if (!ok) continue;
        const rot = Math.sign(env.omega) || 1;
        const s: Storm = {
          id: this.nextId++,
          kind,
          name: NAMES[this.nameIdx++ % NAMES.length],
          lat: grid.lat[j] + (rng.next() - 0.5) * grid.dLat,
          lon: grid.lon[i] + (rng.next() - 0.5) * grid.dLon,
          vmax: kind === 'tropical' ? 14 : 8,
          peak: 0,
          radius: kind === 'dust' ? 4e5 : kind === 'tropical' ? 3e5 : 9e5,
          age: 0,
          life: kind === 'tropical' ? rng.range(6, 16) * DAY : kind === 'extratropical' ? rng.range(4, 7) * DAY : rng.range(5, 40) * DAY,
          spin: (grid.lat[j] >= 0 ? 1 : -1) * rot,
          deficit: 0,
        };
        this.storms.push(s);
        break;
      }
    }
  }

  /** Add vortex winds and pressure deficits to the diagnostic fields; returns per-cell storm cloud/rain factor. */
  imprint(grid: LatLonGrid, R: number, u: Float64Array, v: Float64Array, pAnom: Float64Array, factor: Float64Array): void {
    factor.fill(0);
    const { nLat, nLon } = grid;
    for (const s of this.storms) {
      if (s.vmax < 5) continue;
      const reach = (2.5 * s.radius) / R;
      const rmax = 0.15 * s.radius;
      const sl = Math.sin(s.lat),
        cs = Math.cos(s.lat);
      for (let j = 0; j < nLat; j++) {
        if (Math.abs(grid.lat[j] - s.lat) > reach) continue;
        const cl = grid.cosLat[j];
        for (let i = 0; i < nLon; i++) {
          const dlon = wrapPi(grid.lon[i] - s.lon);
          if (Math.abs(dlon) * Math.max(cl, 0.05) > reach * 1.2) continue;
          const k = j * nLon + i;
          const cosd = sl * grid.sinLat[j] + cs * cl * Math.cos(dlon);
          const d = Math.acos(clamp(cosd, -1, 1)) * R;
          if (d > 2.5 * s.radius) continue;
          const e = R * cl * dlon;
          const n = R * (grid.lat[j] - s.lat);
          const dd = Math.max(1, Math.hypot(e, n));
          const vt = d < rmax ? s.vmax * (d / rmax) : s.vmax * Math.pow(rmax / d, 0.6) * (1 - smooth(d / (2.5 * s.radius)));
          u[k] += s.spin * vt * (-n / dd) - 0.2 * vt * (e / dd);
          v[k] += s.spin * vt * (e / dd) - 0.2 * vt * (n / dd);
          const g = Math.exp(-(d * d) / (s.radius * s.radius));
          pAnom[k] -= s.deficit * g;
          factor[k] = Math.max(factor[k], g * clamp(s.vmax / 30, 0.3, 1.5));
        }
      }
    }
  }
}

function smooth(x: number) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

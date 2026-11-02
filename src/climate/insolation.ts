import type { LatLonGrid } from './grid';

/** One light source as seen from a planet, expressed in the planet's body-fixed frame. */
export interface Illuminator {
  /** Unit vector from planet to star, body-fixed (x = prime meridian, z = north pole). */
  dir: [number, number, number];
  /** Flux at the planet now (W/m²), including eclipses and sunshades. */
  flux: number;
  /** Flux averaged over the orbit (W/m²) for annual-mean mode. */
  meanFlux: number;
  teff: number;
  /** Synodic day length relative to this star (s, signed; ±Infinity when tidally locked). */
  synodic: number;
  /** Orbital period around this star (s). */
  orbitPeriod: number;
  /** Obliquity relative to the orbit around this star (rad). */
  obliquity: number;
  /** Fraction of bolometric luminosity in X-ray/EUV (atmospheric escape). */
  xuvFrac: number;
}

/** Daily-mean normalised insolation (× flux) at latitude phi and declination delta. */
export function dailyMean(phi: number, delta: number): number {
  const tt = -Math.tan(phi) * Math.tan(delta);
  let h0: number;
  if (tt >= 1) return 0;
  if (tt <= -1) h0 = Math.PI;
  else h0 = Math.acos(tt);
  return (h0 * Math.sin(phi) * Math.sin(delta) + Math.cos(phi) * Math.cos(delta) * Math.sin(h0)) / Math.PI;
}

/** Mean of max(0, A + B cos h) over [h0, h1]. */
export function meanPositiveCos(A: number, B: number, h0: number, h1: number): number {
  const len = h1 - h0;
  if (len < 1e-9) return Math.max(0, A + B * Math.cos(h0));
  if (B <= 1e-12) return Math.max(0, A);
  if (A >= B) return A + (B * (Math.sin(h1) - Math.sin(h0))) / len;
  if (A <= -B) return 0;
  const hc = Math.acos(-A / B);
  let sum = 0;
  const kMin = Math.floor((h0 - hc) / (2 * Math.PI)) - 1;
  const kMax = Math.ceil((h1 + hc) / (2 * Math.PI)) + 1;
  for (let k = kMin; k <= kMax; k++) {
    const s = Math.max(h0, 2 * Math.PI * k - hc);
    const e = Math.min(h1, 2 * Math.PI * k + hc);
    if (e > s) sum += A * (e - s) + B * (Math.sin(e) - Math.sin(s));
  }
  return sum / len;
}

const annualCache = new Map<string, Float64Array>();

/** Annual-mean normalised insolation per latitude row for a given obliquity. */
export function annualMeanProfile(grid: LatLonGrid, obliquity: number): Float64Array {
  const key = `${grid.nLat}:${Math.round(obliquity * 1000)}`;
  const hit = annualCache.get(key);
  if (hit) return hit;
  const out = new Float64Array(grid.nLat);
  const n = 72;
  for (let s = 0; s < n; s++) {
    const ls = ((s + 0.5) / n) * 2 * Math.PI;
    const delta = Math.asin(Math.sin(obliquity) * Math.sin(ls));
    for (let j = 0; j < grid.nLat; j++) out[j] += dailyMean(grid.lat[j], delta) / n;
  }
  if (annualCache.size > 200) annualCache.clear();
  annualCache.set(key, out);
  return out;
}

/**
 * Insolation (W/m²) per cell averaged over a step of length dt. Chooses instantaneous,
 * partial-day, daily-mean or annual-mean geometry depending on dt.
 */
export function computeInsolation(grid: LatLonGrid, stars: Illuminator[], dt: number, out: Float64Array): void {
  out.fill(0);
  const { nLat, nLon } = grid;
  for (const s of stars) {
    if (s.flux <= 0 && s.meanFlux <= 0) continue;
    const annual = Number.isFinite(s.orbitPeriod) && dt >= 0.4 * s.orbitPeriod;
    if (annual) {
      const prof = annualMeanProfile(grid, s.obliquity);
      for (let j = 0; j < nLat; j++) {
        const q = prof[j] * s.meanFlux;
        for (let i = 0; i < nLon; i++) out[j * nLon + i] += q;
      }
      continue;
    }
    const [dx, dy, dz] = s.dir;
    const delta = Math.asin(Math.max(-1, Math.min(1, dz)));
    const subLon = Math.atan2(dy, dx);
    const locked = !Number.isFinite(s.synodic);
    const daily = !locked && dt >= 0.75 * Math.abs(s.synodic);
    if (daily) {
      for (let j = 0; j < nLat; j++) {
        const q = dailyMean(grid.lat[j], delta) * s.flux;
        for (let i = 0; i < nLon; i++) out[j * nLon + i] += q;
      }
      continue;
    }
    const sweep = locked ? 0 : (2 * Math.PI * dt) / Math.abs(s.synodic);
    const prograde = s.synodic > 0;
    const sd = Math.sin(delta);
    const cd = Math.cos(delta);
    for (let j = 0; j < nLat; j++) {
      const A = grid.sinLat[j] * sd;
      const B = grid.cosLat[j] * cd;
      for (let i = 0; i < nLon; i++) {
        const H = grid.lon[i] - subLon;
        const q = prograde ? meanPositiveCos(A, B, H - sweep, H) : meanPositiveCos(A, B, H, H + sweep);
        out[j * nLon + i] += q * s.flux;
      }
    }
  }
}

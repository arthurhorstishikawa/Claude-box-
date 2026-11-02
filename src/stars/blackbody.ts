import { C_LIGHT, H_PLANCK, KB, T_SUN } from '../core/constants';

/** Planck spectral radiance B_λ(T) [W sr⁻¹ m⁻³]. */
export function planck(lambda: number, T: number): number {
  const a = (2 * H_PLANCK * C_LIGHT * C_LIGHT) / Math.pow(lambda, 5);
  const x = (H_PLANCK * C_LIGHT) / (lambda * KB * T);
  if (x > 700) return 0;
  return a / Math.expm1(x);
}

// CIE 1931 2° observer, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013).
function g(x: number, mu: number, s1: number, s2: number) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieX(nm: number) {
  return 1.056 * g(nm, 599.8, 37.9, 31.0) + 0.362 * g(nm, 442.0, 16.0, 26.7) - 0.065 * g(nm, 501.1, 20.4, 26.2);
}
function cieY(nm: number) {
  return 0.821 * g(nm, 568.8, 46.9, 40.5) + 0.286 * g(nm, 530.9, 16.3, 31.1);
}
function cieZ(nm: number) {
  return 1.217 * g(nm, 437.0, 11.8, 36.0) + 0.681 * g(nm, 459.0, 26.0, 13.8);
}

const colorCache = new Map<number, [number, number, number]>();

/**
 * Chromaticity of a blackbody as linear sRGB, normalised so the largest channel is 1.
 */
export function blackbodyRGB(T: number): [number, number, number] {
  const key = Math.round(Math.max(500, Math.min(60000, T)) / 25);
  const hit = colorCache.get(key);
  if (hit) return hit;
  const Tk = key * 25;
  let X = 0,
    Y = 0,
    Z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const b = planck(nm * 1e-9, Tk);
    X += b * cieX(nm);
    Y += b * cieY(nm);
    Z += b * cieZ(nm);
  }
  let r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  let gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
  r = Math.max(r, 0);
  gg = Math.max(gg, 0);
  b = Math.max(b, 0);
  const m = Math.max(r, gg, b, 1e-30);
  const out: [number, number, number] = [r / m, gg / m, b / m];
  colorCache.set(key, out);
  return out;
}

export interface SpectralFractions {
  /** Fraction of bolometric flux below 0.7 µm (visible/UV) — governs snow/ice albedo. */
  vis: number;
  /** Fraction below 0.4 µm. */
  uv: number;
  /** Rayleigh-scattering efficiency relative to the Sun's spectrum. */
  rayleigh: number;
}

const specCache = new Map<number, SpectralFractions>();
let sunRayleigh = 0;

function integrate(T: number) {
  // Log-spaced integration 0.08 µm .. 200 µm.
  const n = 400;
  const l0 = Math.log(0.08e-6);
  const l1 = Math.log(200e-6);
  let tot = 0,
    vis = 0,
    uv = 0,
    ray = 0;
  for (let i = 0; i < n; i++) {
    const ll = l0 + ((i + 0.5) / n) * (l1 - l0);
    const lam = Math.exp(ll);
    const w = planck(lam, T) * lam; // dλ = λ d(lnλ)
    tot += w;
    if (lam < 0.7e-6) vis += w;
    if (lam < 0.4e-6) uv += w;
    const lu = lam / 0.55e-6;
    ray += w / (lu * lu * lu * lu);
  }
  return { tot, vis, uv, ray };
}

export function spectralFractions(T: number): SpectralFractions {
  const key = Math.round(Math.max(300, Math.min(200000, T)) / 50);
  const hit = specCache.get(key);
  if (hit) return hit;
  if (!sunRayleigh) {
    const s = integrate(T_SUN);
    sunRayleigh = s.ray / s.tot;
  }
  const r = integrate(key * 50);
  const out: SpectralFractions = {
    vis: r.vis / r.tot,
    uv: r.uv / r.tot,
    rayleigh: Math.min(8, r.ray / r.tot / sunRayleigh),
  };
  specCache.set(key, out);
  return out;
}

/** sRGB (gamma-encoded) hex colour for a blackbody, for UI swatches. */
export function blackbodyHex(T: number): string {
  const [r, g2, b] = blackbodyRGB(T);
  const enc = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${enc(r)}${enc(g2)}${enc(b)}`;
}

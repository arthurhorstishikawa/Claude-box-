import * as THREE from 'three';
import { clamp, smoothstep } from '../core/math';
import { Rng } from '../core/rng';
import type { GasGiantClimate } from '../climate/gasGiant';
import type { TerrainMap } from '../climate/terrain';
import type { TerrestrialClimate } from '../climate/terrestrial';
import type { RingSystem } from '../physics/body';

const toHalf = THREE.DataUtils.toHalfFloat;

function halfTex(w: number, h: number, channels: 1 | 2 | 4, data: Uint16Array): THREE.DataTexture {
  const fmt = channels === 1 ? THREE.RedFormat : channels === 2 ? THREE.RGFormat : THREE.RGBAFormat;
  const t = new THREE.DataTexture(data, w, h, fmt, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export function elevationTexture(t: TerrainMap): THREE.DataTexture {
  const n = t.w * t.h;
  const d = new Uint16Array(n * 2);
  for (let k = 0; k < n; k++) {
    d[2 * k] = toHalf(clamp(t.elev[k], -60000, 60000));
    d[2 * k + 1] = toHalf(t.material[k]);
  }
  return halfTex(t.w, t.h, 2, d);
}

export function updateElevationTexture(tex: THREE.DataTexture, t: TerrainMap): void {
  const d = tex.image.data as Uint16Array;
  if (d.length !== t.w * t.h * 2) return;
  for (let k = 0; k < t.w * t.h; k++) {
    d[2 * k] = toHalf(clamp(t.elev[k], -60000, 60000));
    d[2 * k + 1] = toHalf(t.material[k]);
  }
  tex.needsUpdate = true;
}

/** Climate fields packed for the surface/cloud shaders. */
export class ClimateTextures {
  climA: THREE.DataTexture;
  climB: THREE.DataTexture;
  wind: THREE.DataTexture;
  layer: THREE.DataTexture;
  private w: number;
  private h: number;
  version = -1;

  constructor(nLon: number, nLat: number) {
    this.w = nLon;
    this.h = nLat;
    const n = nLon * nLat;
    this.climA = halfTex(nLon, nLat, 4, new Uint16Array(n * 4));
    this.climB = halfTex(nLon, nLat, 4, new Uint16Array(n * 4));
    this.wind = halfTex(nLon, nLat, 2, new Uint16Array(n * 2));
    this.layer = halfTex(nLon, nLat, 1, new Uint16Array(n));
  }

  fits(c: TerrestrialClimate): boolean {
    return c.grid.nLon === this.w && c.grid.nLat === this.h;
  }

  update(c: TerrestrialClimate, layer: string, deck: number): void {
    const n = c.grid.N;
    const A = this.climA.image.data as Uint16Array;
    const B = this.climB.image.data as Uint16Array;
    const W = this.wind.image.data as Uint16Array;
    const L = this.layer.image.data as Uint16Array;
    const lights = c.civ?.lights;
    for (let k = 0; k < n; k++) {
      const fl = 1 - c.ocean[k];
      A[4 * k] = toHalf(c.tMonth[k]);
      A[4 * k + 1] = toHalf(Math.min(6e4, c.snow[k] * (fl > 0.02 ? 1 : 0)));
      A[4 * k + 2] = toHalf(Math.min(6e4, c.seaIce[k]));
      A[4 * k + 3] = toHalf(c.veg[k]);
      B[4 * k] = toHalf(Math.max(c.cloud[k], deck));
      B[4 * k + 1] = toHalf(c.pAnnual[k] * 86400);
      B[4 * k + 2] = toHalf(lights ? lights[k] : 0);
      B[4 * k + 3] = toHalf(Math.min(6e4, c.frost[k]));
      W[2 * k] = toHalf(c.circ.uCloud[k]);
      W[2 * k + 1] = toHalf(c.circ.v[k]);
    }
    if (layer !== 'true') {
      let src: ArrayLike<number> | null = null;
      if (layer === 'pop') {
        if (c.civ) {
          const out = new Float64Array(n);
          const A0 = 4 * Math.PI * (c as any).R * (c as any).R;
          for (let k = 0; k < n; k++) out[k] = (c.civ.pop[k] / (c.grid.cellArea[Math.floor(k / c.grid.nLon)] * A0)) * 1e6;
          src = out;
        }
      } else src = c.field(layer as any);
      const scale = layer === 'precip' ? 86400 : layer === 'pAnom' ? 1 : 1;
      for (let k = 0; k < n; k++) L[k] = toHalf(src ? clamp(src[k] * scale, -6e4, 6e4) : 0);
      // Categories (biomes) must not be blended between cells.
      const f = layer === 'biome' ? THREE.NearestFilter : THREE.LinearFilter;
      this.layer.magFilter = this.layer.minFilter = f;
      this.layer.needsUpdate = true;
    }
    this.climA.needsUpdate = true;
    this.climB.needsUpdate = true;
    this.wind.needsUpdate = true;
    this.version = c.version;
  }

  dispose(): void {
    this.climA.dispose();
    this.climB.dispose();
    this.wind.dispose();
    this.layer.dispose();
  }
}

type RGB = [number, number, number];
const mix3 = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Palette (zone, belt, polar) for a gas giant from its preset or temperature class. */
export function giantPalette(g: GasGiantClimate, seed: number): { zone: RGB; belt: RGB; polar: RGB; contrast: number; glow: number } {
  const T = g.stats.T1bar;
  switch (g.palette) {
    case 'jupiter':
      return { zone: [0.86, 0.79, 0.66], belt: [0.58, 0.38, 0.24], polar: [0.5, 0.5, 0.55], contrast: 1, glow: 0 };
    case 'saturn':
      return { zone: [0.86, 0.77, 0.56], belt: [0.74, 0.6, 0.4], polar: [0.62, 0.62, 0.6], contrast: 0.55, glow: 0 };
    case 'uranus':
      return { zone: [0.58, 0.8, 0.84], belt: [0.52, 0.75, 0.81], polar: [0.62, 0.82, 0.86], contrast: 0.2, glow: 0 };
    case 'neptune':
      return { zone: [0.24, 0.38, 0.82], belt: [0.18, 0.3, 0.7], polar: [0.22, 0.34, 0.74], contrast: 0.45, glow: 0 };
  }
  const rng = new Rng(seed);
  const cls = g.stats.sudarsky;
  const hot = smoothstep(800, 1600, T);
  if (g.iceGiant && T < 150) {
    const z: RGB = mix3([0.55, 0.8, 0.85], [0.25, 0.4, 0.85], rng.next());
    return { zone: z, belt: mix3(z, [0.1, 0.2, 0.5], 0.2), polar: z, contrast: 0.35, glow: 0 };
  }
  if (cls === 1) {
    const hue = rng.range(-0.08, 0.08);
    return { zone: [0.85 + hue, 0.78, 0.64 - hue], belt: [0.6 + hue, 0.42, 0.28 - hue], polar: [0.5, 0.5, 0.55], contrast: rng.range(0.6, 1), glow: 0 };
  }
  if (cls === 2) return { zone: [0.95, 0.94, 0.9], belt: [0.84, 0.83, 0.8], polar: [0.88, 0.88, 0.88], contrast: 0.35, glow: 0 };
  if (cls === 3) return { zone: [0.3, 0.5, 0.9], belt: [0.22, 0.4, 0.8], polar: [0.25, 0.42, 0.82], contrast: 0.4, glow: 0 };
  if (cls === 4) return { zone: [0.1, 0.09, 0.14], belt: [0.06, 0.05, 0.09], polar: [0.08, 0.07, 0.12], contrast: 0.5, glow: 1 + hot };
  return { zone: [0.72, 0.7, 0.66], belt: [0.55, 0.53, 0.5], polar: [0.6, 0.58, 0.55], contrast: 0.5, glow: 1 + hot };
}

/** 1×256 latitude texture: rgb = albedo, a = "zone-ness" (used for cloud-deck coverage). */
export function bandTexture(g: GasGiantClimate, seed: number, tex?: THREE.DataTexture): THREE.DataTexture {
  const H = 256;
  const data = tex ? (tex.image.data as Uint8Array) : new Uint8Array(H * 4);
  const pal = giantPalette(g, seed);
  const edges = g.bandEdges.length ? g.bandEdges : [0.3, 0.6, 0.9];
  const rng = new Rng(seed + 5);
  const jitter = edges.map(() => rng.range(-0.15, 0.15));
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI;
    const a = Math.abs(lat);
    let idx = 0;
    while (idx < edges.length && a > edges[idx]) idx++;
    const zone = idx % 2 === 0;
    const prev = idx === 0 ? 0 : edges[idx - 1];
    const next = idx < edges.length ? edges[idx] : Math.PI / 2;
    const tIn = clamp((a - prev) / Math.max(next - prev, 1e-3), 0, 1);
    const edgeSoft = smoothstep(0, 0.18, tIn) * smoothstep(1, 0.82, tIn);
    const z = zone ? 1 : 0;
    let col = mix3(pal.belt, pal.zone, 0.5 + (z - 0.5) * pal.contrast * (0.6 + 0.4 * edgeSoft));
    col = mix3(col, mix3(col, [1, 1, 1], 0.2), jitter[Math.min(idx, jitter.length - 1)] + 0.15);
    const polar = smoothstep(1.05, 1.35, a);
    col = mix3(col, pal.polar, polar);
    data[4 * y] = Math.round(clamp(col[0], 0, 1) * 255);
    data[4 * y + 1] = Math.round(clamp(col[1], 0, 1) * 255);
    data[4 * y + 2] = Math.round(clamp(col[2], 0, 1) * 255);
    data[4 * y + 3] = Math.round((zone ? 0.8 : 0.3) * 255);
  }
  if (tex) {
    tex.needsUpdate = true;
    return tex;
  }
  const t = new THREE.DataTexture(data, 1, H, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

export function thermalTexture(g: GasGiantClimate, tex?: THREE.DataTexture): THREE.DataTexture {
  const { nLat, nLon } = g.grid;
  const d = tex ? (tex.image.data as Uint16Array) : new Uint16Array(nLat * nLon);
  for (let k = 0; k < nLat * nLon; k++) d[k] = toHalf(g.T[k]);
  if (tex) {
    tex.needsUpdate = true;
    return tex;
  }
  return halfTex(nLon, nLat, 1, d);
}

/** Radial density/colour profile of a ring system (Saturn-like gaps for the Saturn preset). */
export function ringTexture(r: RingSystem, saturn: boolean): THREE.DataTexture {
  const W = 1024;
  const data = new Uint8Array(W * 4);
  const rng = new Rng(r.seed);
  const waves = Array.from({ length: 14 }, () => [rng.range(20, 400), rng.range(0, 6), rng.range(0.05, 0.25)]);
  for (let i = 0; i < W; i++) {
    const x = (i + 0.5) / W;
    const R = r.inner + (r.outer - r.inner) * x;
    let a: number;
    if (saturn) {
      // Radii in km: C 74.5–92, B 92–117.6, Cassini 117.6–122.2, A 122.2–136.8 (Encke 133.6), F 140.2
      const km = R / 1e3;
      if (km < 92000) a = 0.12 + 0.1 * smoothstep(74500, 92000, km);
      else if (km < 117580) a = 0.75 + 0.2 * Math.sin(km / 900);
      else if (km < 122170) a = 0.06;
      else if (km < 136775) a = Math.abs(km - 133590) < 160 ? 0.03 : 0.55 + 0.1 * Math.sin(km / 500);
      else if (Math.abs(km - 140220) < 250) a = 0.5;
      else a = 0.0;
    } else {
      a = 0.5 * smoothstep(0, 0.08, x) * smoothstep(1, 0.92, x);
      for (const [f, p, amp] of waves) a *= 1 - amp + amp * (0.5 + 0.5 * Math.sin(x * f + p));
    }
    for (const [f, p, amp] of waves) a *= 1 - amp * 0.3 + amp * 0.3 * Math.sin(x * f * 3 + p);
    a = clamp(a * r.opacity, 0, 1);
    const shade = 0.85 + 0.15 * Math.sin(x * 37 + 1);
    data[4 * i] = Math.round(clamp(r.color[0] * shade, 0, 1) * 255);
    data[4 * i + 1] = Math.round(clamp(r.color[1] * shade, 0, 1) * 255);
    data[4 * i + 2] = Math.round(clamp(r.color[2] * shade, 0, 1) * 255);
    data[4 * i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Tileable 3D fBm value noise for volumetric clouds. */
export function makeNoise3D(size = 64): THREE.Data3DTexture {
  const rng = new Rng(77);
  const lattice = (n: number) => {
    const a = new Float32Array(n * n * n);
    for (let i = 0; i < a.length; i++) a[i] = rng.next();
    return a;
  };
  const octs = [4, 8, 16, 32].map((n) => ({ n, v: lattice(n) }));
  const data = new Uint8Array(size * size * size);
  const fade = (t: number) => t * t * (3 - 2 * t);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0,
          amp = 0.55,
          norm = 0;
        for (const { n, v } of octs) {
          const fx = (x / size) * n,
            fy = (y / size) * n,
            fz = (z / size) * n;
          const x0 = Math.floor(fx),
            y0 = Math.floor(fy),
            z0 = Math.floor(fz);
          const tx = fade(fx - x0),
            ty = fade(fy - y0),
            tz = fade(fz - z0);
          const at = (i: number, j: number, k: number) => v[((k % n) * n + (j % n)) * n + (i % n)];
          const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
          const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
          const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
          const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
          const c0 = c00 * (1 - ty) + c10 * ty;
          const c1 = c01 * (1 - ty) + c11 * ty;
          s += (c0 * (1 - tz) + c1 * tz) * amp;
          norm += amp;
          amp *= 0.5;
        }
        // Billowy remap.
        const val = Math.pow(s / norm, 1.4);
        data[(z * size + y) * size + x] = Math.round(clamp(val * 1.6 - 0.25, 0, 1) * 255);
      }
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------------------- cloud noise

/** Tileable 3D Worley noise (1 − nearest-feature distance), `cells` per side. */
function worley3D(size: number, cells: number, rng: Rng): Float32Array {
  const pts = new Float32Array(cells * cells * cells * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = rng.next();
  const out = new Float32Array(size * size * size);
  const cs = size / cells;
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) / cs,
          fy = (y + 0.5) / cs,
          fz = (z + 0.5) / cs;
        const cx = Math.floor(fx),
          cy = Math.floor(fy),
          cz = Math.floor(fz);
        let best = 9;
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const ix = cx + dx,
                iy = cy + dy,
                iz = cz + dz;
              const w = (((iz % cells) + cells) % cells) * cells * cells + (((iy % cells) + cells) % cells) * cells + (((ix % cells) + cells) % cells);
              const px = ix + pts[3 * w] - fx,
                py = iy + pts[3 * w + 1] - fy,
                pz = iz + pts[3 * w + 2] - fz;
              const d = px * px + py * py + pz * pz;
              if (d < best) best = d;
            }
        out[(z * size + y) * size + x] = 1 - Math.min(1, Math.sqrt(best));
      }
  return out;
}

/** Tileable value-noise fBm (smooth lattice noise, octaves at 4, 8, 16, 32 per side). */
function valueFbm3D(size: number, rng: Rng): Float32Array {
  const octs = [4, 8, 16].map((n) => {
    const v = new Float32Array(n * n * n);
    for (let i = 0; i < v.length; i++) v[i] = rng.next();
    return { n, v };
  });
  const out = new Float32Array(size * size * size);
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0,
          amp = 0.6,
          norm = 0;
        for (const { n, v } of octs) {
          const fx = (x / size) * n,
            fy = (y / size) * n,
            fz = (z / size) * n;
          const x0 = Math.floor(fx),
            y0 = Math.floor(fy),
            z0 = Math.floor(fz);
          const tx = fade(fx - x0),
            ty = fade(fy - y0),
            tz = fade(fz - z0);
          const at = (i: number, j: number, k: number) => v[((k % n) * n + (j % n)) * n + (i % n)];
          const c00 = at(x0, y0, z0) * (1 - tx) + at(x0 + 1, y0, z0) * tx;
          const c10 = at(x0, y0 + 1, z0) * (1 - tx) + at(x0 + 1, y0 + 1, z0) * tx;
          const c01 = at(x0, y0, z0 + 1) * (1 - tx) + at(x0 + 1, y0, z0 + 1) * tx;
          const c11 = at(x0, y0 + 1, z0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1) * tx;
          s += ((c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz) * amp;
          norm += amp;
          amp *= 0.5;
        }
        out[(z * size + y) * size + x] = s / norm;
      }
  return out;
}

function tex3D(data: Uint8Array, size: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export interface CloudNoise {
  /** R: Perlin–Worley (billowy cumulus); G/B/A: Worley at 4, 8, 16 cells. */
  shape: THREE.Data3DTexture;
  /** RGB: fine Worley at 8, 16, 32 cells (edge erosion). */
  detail: THREE.Data3DTexture;
  /** Mean and spread of the base shape value, for coverage calibration. */
  mu: number;
  sd: number;
}

let cloudNoise: CloudNoise | null = null;

/** Cloud noise volumes in the style of production real-time cloud renderers (built once). */
export function getCloudNoise(): CloudNoise {
  if (cloudNoise) return cloudNoise;
  const rng = new Rng(4242);
  const S = 64;
  const perlin = valueFbm3D(S, rng);
  const w4 = worley3D(S, 4, rng),
    w8 = worley3D(S, 8, rng),
    w16 = worley3D(S, 16, rng);
  const n = S * S * S;
  const shape = new Uint8Array(n * 4);
  let sum = 0,
    sum2 = 0;
  for (let k = 0; k < n; k++) {
    const wf = 0.625 * w4[k] + 0.25 * w8[k] + 0.125 * w16[k];
    // Perlin–Worley: value noise dilated by inverted Worley → connected billows.
    const pw = clamp(wf + (perlin[k] - 0.5) * 1.4, 0, 1);
    shape[4 * k] = Math.round(pw * 255);
    shape[4 * k + 1] = Math.round(w4[k] * 255);
    shape[4 * k + 2] = Math.round(w8[k] * 255);
    shape[4 * k + 3] = Math.round(w16[k] * 255);
    // Base shape exactly as the shader builds it (remap of pw by the Worley fBm).
    const base = clamp((pw - (wf - 1)) / (2 - wf), 0, 1);
    sum += base;
    sum2 += base * base;
  }
  const D = 32;
  const d8 = worley3D(D, 8, rng),
    d16 = worley3D(D, 16, rng),
    d32 = worley3D(D, 32, rng);
  const detail = new Uint8Array(D * D * D * 4);
  for (let k = 0; k < D * D * D; k++) {
    detail[4 * k] = Math.round(d8[k] * 255);
    detail[4 * k + 1] = Math.round(d16[k] * 255);
    detail[4 * k + 2] = Math.round(d32[k] * 255);
    detail[4 * k + 3] = 255;
  }
  const mu = sum / n;
  cloudNoise = { shape: tex3D(shape, S), detail: tex3D(detail, D), mu, sd: Math.sqrt(Math.max(1e-6, sum2 / n - mu * mu)) };
  return cloudNoise;
}

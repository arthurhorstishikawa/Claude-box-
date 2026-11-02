import { DAY } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { fmtTemp } from '../core/format';
import type { TerrestrialClimate } from '../climate/terrestrial';
import { plantPigment } from '../climate/life';
import { stormCategory } from '../climate/storms';
import { LAYERS, type LayerId } from '../render/viewSettings';

type RGB = [number, number, number];

export function turbo(x: number): RGB {
  x = clamp(x, 0, 1);
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
  return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
}
export function blueRed(x: number): RGB {
  x = clamp(x, 0, 1);
  const a: RGB = [0.05, 0.2, 0.65],
    m: RGB = [0.95, 0.95, 0.95],
    b: RGB = [0.75, 0.08, 0.06];
  const f = (p: RGB, q: RGB, t: number): RGB => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  return x < 0.5 ? f(a, m, x * 2) : f(m, b, x * 2 - 1);
}
const BIOME_RGB: RGB[] = [
  [0.04, 0.12, 0.35],
  [0.92, 0.95, 1.0],
  [0.55, 0.55, 0.45],
  [0.1, 0.28, 0.18],
  [0.15, 0.45, 0.13],
  [0.6, 0.68, 0.25],
  [0.88, 0.76, 0.5],
  [0.74, 0.62, 0.25],
  [0.02, 0.3, 0.07],
  [0.45, 0.4, 0.37],
];
export function biomeRGB(v: number): RGB {
  return BIOME_RGB[clamp(Math.round(v), 0, 9)];
}
export function rain(x: number): RGB {
  x = clamp(x, 0, 1);
  const f = (p: RGB, q: RGB, t: number): RGB => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  return f(f([0.85, 0.75, 0.55], [0.3, 0.75, 0.35], smoothstep(0, 0.4, x)), [0.1, 0.25, 0.75], smoothstep(0.4, 1, x));
}

const srgb = (c: number) => Math.round(255 * clamp(c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055, 0, 1));

export interface Station {
  lat: number;
  lon: number;
  t: number[];
  T: number[];
  P: number[];
  wind: number[];
}

/** 2D equirectangular climate map with isobars, storms, terminator and weather stations. */
export class ClimateMap {
  canvas: HTMLCanvasElement;
  private off = document.createElement('canvas');
  private coast = document.createElement('canvas');
  private coastKey = '';
  private night = document.createElement('canvas');
  station: Station | null = null;
  onStation: ((s: Station) => void) | null = null;
  private climate: TerrestrialClimate | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map';
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const lon = (x - 0.5) * 2 * Math.PI;
      const lat = (0.5 - y) * Math.PI;
      this.station = { lat, lon, t: [], T: [], P: [], wind: [] };
      this.onStation?.(this.station);
    });
  }

  private ensureCoast(c: TerrestrialClimate): void {
    const t = c.terrain;
    const key = `${c.terrainVersion}:${Math.round(c.seaLevel)}:${t.w}`;
    if (key === this.coastKey) return;
    this.coastKey = key;
    const W = t.w,
      H = t.h;
    this.coast.width = W;
    this.coast.height = H;
    const ctx = this.coast.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const sea = Number.isFinite(c.seaLevel) ? c.seaLevel : -Infinity;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const k = j * W + i;
        const land = t.elev[k] >= sea;
        const right = t.elev[j * W + ((i + 1) % W)] >= sea;
        const down = j + 1 < H ? t.elev[(j + 1) * W + i] >= sea : land;
        const edge = land !== right || land !== down;
        const o = 4 * k;
        img.data[o] = 255;
        img.data[o + 1] = 255;
        img.data[o + 2] = 255;
        img.data[o + 3] = edge ? 170 : 0;
      }
    ctx.putImageData(img, 0, 0);
  }

  draw(c: TerrestrialClimate, layer: LayerId, subLon: number | null, subLat: number): void {
    this.climate = c;
    const g = c.grid;
    const W = g.nLon,
      H = g.nLat;
    this.off.width = W;
    this.off.height = H;
    const ctx = this.off.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const L = LAYERS.find((l) => l.id === layer) ?? LAYERS[0];
    let field: ArrayLike<number> | null = null;
    if (layer !== 'true' && layer !== 'pop') field = c.field(layer as any);
    if (layer === 'pop' && c.civ) {
      const A = 4 * Math.PI * (c as any).R * (c as any).R;
      const f = new Float64Array(g.N);
      for (let k = 0; k < g.N; k++) f[k] = (c.civ.pop[k] / (g.cellArea[Math.floor(k / W)] * A)) * 1e6;
      field = f;
    }
    const pig = plantPigment(c.hostTeff);
    for (let k = 0; k < g.N; k++) {
      let rgb: RGB;
      if (field) {
        const v = layer === 'precip' ? field[k] * DAY : field[k];
        const x = (v - L.range[0]) / (L.range[1] - L.range[0]);
        rgb = L.palette === 'biome' ? biomeRGB(v) : L.palette === 'blueRed' ? blueRed(x) : L.palette === 'rain' ? rain(x) : turbo(x);
      } else {
        const fo = c.ocean[k];
        const ice = smoothstep(0.02, 0.4, c.seaIce[k]) * fo + smoothstep(5, 100, c.snow[k]) * (1 - fo);
        const land: RGB = [0.35 + 0.25 * c.material[k], 0.3 + 0.2 * c.material[k], 0.22 + 0.15 * c.material[k]];
        const veg = c.veg[k];
        const lnd: RGB = [land[0] * (1 - veg) + pig[0] * 2.2 * veg, land[1] * (1 - veg) + pig[1] * 2.2 * veg, land[2] * (1 - veg) + pig[2] * 2.2 * veg];
        const sea: RGB = c.vol.id === 'CH4' ? [0.08, 0.05, 0.02] : [0.03, 0.12, 0.3];
        rgb = [lnd[0] * (1 - fo) + sea[0] * fo, lnd[1] * (1 - fo) + sea[1] * fo, lnd[2] * (1 - fo) + sea[2] * fo];
        rgb = [rgb[0] + (0.92 - rgb[0]) * ice, rgb[1] + (0.94 - rgb[1]) * ice, rgb[2] + (0.97 - rgb[2]) * ice];
        if (c.Ts[k] > 900) rgb = [1, 0.35, 0.05];
        const cl = c.cloud[k] * 0.45;
        rgb = [rgb[0] + (1 - rgb[0]) * cl, rgb[1] + (1 - rgb[1]) * cl, rgb[2] + (1 - rgb[2]) * cl];
      }
      const o = 4 * k;
      img.data[o] = srgb(rgb[0]);
      img.data[o + 1] = srgb(rgb[1]);
      img.data[o + 2] = srgb(rgb[2]);
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = this.canvas.clientWidth || 500;
    const chh = this.canvas.clientHeight || 250;
    if (this.canvas.width !== cw * dpr) {
      this.canvas.width = cw * dpr;
      this.canvas.height = chh * dpr;
    }
    const m = this.canvas.getContext('2d')!;
    const CW = this.canvas.width,
      CH = this.canvas.height;
    m.imageSmoothingEnabled = true;
    m.imageSmoothingQuality = 'high';
    m.drawImage(this.off, 0, 0, CW, CH);
    // Coastlines.
    if (c.waterTotal > 0 && Number.isFinite(c.seaLevel)) {
      this.ensureCoast(c);
      m.globalAlpha = 0.65;
      m.drawImage(this.coast, 0, 0, CW, CH);
      m.globalAlpha = 1;
    }
    // Day/night: shade every point where the star is below the horizon, with a soft twilight band.
    if (subLon !== null) {
      this.drawNight(subLon, subLat);
      m.drawImage(this.night, 0, 0, CW, CH);
    }
    // Isobars from the pressure anomaly (marching squares, 4 hPa spacing).
    if (c.P > 5e3 && layer === 'pAnom') this.isobars(m, c, CW, CH);
    // Storms.
    m.font = `${11 * dpr}px Inter, sans-serif`;
    for (const s of c.storms.storms) {
      if (s.vmax < 15) continue;
      const x = ((s.lon / (2 * Math.PI) + 0.5) % 1) * CW;
      const y = (0.5 - s.lat / Math.PI) * CH;
      m.strokeStyle = s.kind === 'tropical' ? '#ff6b6b' : s.kind === 'dust' ? '#e0a050' : '#9fd0ff';
      m.lineWidth = 2 * dpr;
      m.beginPath();
      m.arc(x, y, 6 * dpr, 0, Math.PI * 2);
      m.stroke();
      m.fillStyle = '#fff';
      m.fillText(`${s.name} · ${stormCategory(s)}`, x + 9 * dpr, y + 4 * dpr);
    }
    // Station.
    if (this.station) {
      const x = ((this.station.lon / (2 * Math.PI) + 0.5) % 1) * CW;
      const y = (0.5 - this.station.lat / Math.PI) * CH;
      m.fillStyle = '#ffd36b';
      m.beginPath();
      m.moveTo(x, y - 8 * dpr);
      m.lineTo(x - 5 * dpr, y);
      m.lineTo(x + 5 * dpr, y);
      m.fill();
    }
  }

  private drawNight(subLon: number, subLat: number): void {
    const W = 128,
      H = 64;
    if (this.night.width !== W) {
      this.night.width = W;
      this.night.height = H;
    }
    const ctx = this.night.getContext('2d')!;
    const img = ctx.createImageData(W, H);
    const sd = Math.sin(subLat),
      cd = Math.cos(subLat);
    for (let j = 0; j < H; j++) {
      const lat = Math.PI / 2 - ((j + 0.5) / H) * Math.PI;
      const sl = Math.sin(lat),
        cl = Math.cos(lat);
      for (let i = 0; i < W; i++) {
        const lon = -Math.PI + ((i + 0.5) / W) * 2 * Math.PI;
        const cosZ = sl * sd + cl * cd * Math.cos(lon - subLon);
        const a = 1 - smoothstep(-0.12, 0.04, cosZ);
        const o = 4 * (j * W + i);
        img.data[o] = 0;
        img.data[o + 1] = 2;
        img.data[o + 2] = 12;
        img.data[o + 3] = Math.round(120 * a);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private isobars(m: CanvasRenderingContext2D, c: TerrestrialClimate, CW: number, CH: number): void {
    const g = c.grid;
    const p = c.circ.pAnom;
    const step = 400;
    m.strokeStyle = 'rgba(255,255,255,0.35)';
    m.lineWidth = 1;
    const X = (i: number) => ((i + 0.5) / g.nLon) * CW;
    const Y = (j: number) => ((j + 0.5) / g.nLat) * CH;
    m.beginPath();
    for (let j = 0; j < g.nLat - 1; j++)
      for (let i = 0; i < g.nLon - 1; i++) {
        const a = p[j * g.nLon + i],
          b = p[j * g.nLon + i + 1],
          cc = p[(j + 1) * g.nLon + i + 1],
          d = p[(j + 1) * g.nLon + i];
        const lo = Math.min(a, b, cc, d),
          hi = Math.max(a, b, cc, d);
        for (let lev = Math.ceil(lo / step) * step; lev <= hi; lev += step) {
          const pts: [number, number][] = [];
          const edge = (v0: number, v1: number, x0: number, y0: number, x1: number, y1: number) => {
            if ((v0 - lev) * (v1 - lev) < 0) {
              const t = (lev - v0) / (v1 - v0);
              pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
            }
          };
          edge(a, b, X(i), Y(j), X(i + 1), Y(j));
          edge(b, cc, X(i + 1), Y(j), X(i + 1), Y(j + 1));
          edge(cc, d, X(i + 1), Y(j + 1), X(i), Y(j + 1));
          edge(d, a, X(i), Y(j + 1), X(i), Y(j));
          if (pts.length >= 2) {
            m.moveTo(pts[0][0], pts[0][1]);
            m.lineTo(pts[1][0], pts[1][1]);
          }
        }
      }
    m.stroke();
  }

  /** Record the station's readings (called each UI tick). */
  sampleStation(time: number): void {
    const s = this.station;
    const c = this.climate;
    if (!s || !c) return;
    const g = c.grid;
    s.t.push(time);
    s.T.push(g.sample(c.Ts, s.lat, s.lon));
    s.P.push(c.P + g.sample(c.circ.pAnom, s.lat, s.lon));
    s.wind.push(Math.hypot(g.sample(c.circ.u, s.lat, s.lon), g.sample(c.circ.v, s.lat, s.lon)));
    if (s.t.length > 600) for (const arr of [s.t, s.T, s.P, s.wind]) arr.splice(0, arr.length - 600);
  }

  stationText(): string {
    const s = this.station;
    const c = this.climate;
    if (!s || !c) return 'Click the map to place a weather station.';
    const g = c.grid;
    const T = g.sample(c.Ts, s.lat, s.lon);
    const pr = g.sample(c.precip, s.lat, s.lon) * DAY;
    const w = Math.hypot(g.sample(c.circ.u, s.lat, s.lon), g.sample(c.circ.v, s.lat, s.lon));
    const cl = g.sample(c.cloud, s.lat, s.lon);
    return `Station ${(s.lat * 57.3).toFixed(1)}°, ${(s.lon * 57.3).toFixed(1)}° — ${fmtTemp(T)}, wind ${w.toFixed(1)} m/s, rain ${pr.toFixed(1)} mm/day, cloud ${(cl * 100).toFixed(0)}%`;
  }
}

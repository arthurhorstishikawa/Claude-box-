import { Noise3 } from '../core/noise';
import { Rng } from '../core/rng';
import { smoothstep } from '../core/math';

/**
 * Procedural, seeded terrain generation. Every world's land is generated — no real maps.
 * Output is an equirectangular elevation map (metres) plus a 0..1 "material" channel used
 * for surface tint/albedo variation (maria vs highlands, sulfur plains, dark terrain ...).
 * Row 0 is the north pole edge, column 0 is longitude -180°.
 */
export type TerrainStyle =
  | 'earthlike'
  | 'oceanic'
  | 'continental'
  | 'marslike'
  | 'venuslike'
  | 'moonlike'
  | 'mercurylike'
  | 'europalike'
  | 'ganymedelike'
  | 'callistolike'
  | 'iolike'
  | 'titanlike'
  | 'plutolike'
  | 'tritonlike'
  | 'asteroid'
  | 'lavaworld';

export const TERRAIN_STYLES: { id: TerrainStyle; label: string }[] = [
  { id: 'earthlike', label: 'Earth-like (plate tectonics)' },
  { id: 'oceanic', label: 'Archipelago world' },
  { id: 'continental', label: 'Supercontinent world' },
  { id: 'marslike', label: 'Mars-like (dichotomy, volcanoes)' },
  { id: 'venuslike', label: 'Venus-like (volcanic plains)' },
  { id: 'moonlike', label: 'Cratered with maria' },
  { id: 'mercurylike', label: 'Heavily cratered' },
  { id: 'europalike', label: 'Cracked ice shell' },
  { id: 'ganymedelike', label: 'Grooved ice' },
  { id: 'callistolike', label: 'Ancient cratered ice' },
  { id: 'iolike', label: 'Volcanic sulfur world' },
  { id: 'titanlike', label: 'Dunes & polar basins' },
  { id: 'plutolike', label: 'Nitrogen-ice plains' },
  { id: 'tritonlike', label: 'Cantaloupe terrain' },
  { id: 'asteroid', label: 'Rubble / asteroid' },
  { id: 'lavaworld', label: 'Young lava world' },
];

export interface TerrainMap {
  style: TerrainStyle;
  seed: number;
  w: number;
  h: number;
  elev: Float32Array;
  material: Float32Array;
  min: number;
  max: number;
}

interface Ctx {
  t: TerrainMap;
  px: Float32Array;
  py: Float32Array;
  pz: Float32Array;
  lat: Float32Array;
  noise: Noise3;
  rng: Rng;
  /** Plate drift elapsed (Myr). */
  drift: number;
}

/** Rotate v about the unit axis a by angle (Rodrigues). */
function rotateVec(v: [number, number, number], a: [number, number, number], ang: number): [number, number, number] {
  const c = Math.cos(ang),
    s = Math.sin(ang);
  const d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  const cx = a[1] * v[2] - a[2] * v[1],
    cy = a[2] * v[0] - a[0] * v[2],
    cz = a[0] * v[1] - a[1] * v[0];
  return [v[0] * c + cx * s + a[0] * d * (1 - c), v[1] * c + cy * s + a[1] * d * (1 - c), v[2] * c + cz * s + a[2] * d * (1 - c)];
}

const randomUnit = (rng: Rng): [number, number, number] => {
  const z = rng.range(-1, 1);
  const a = rng.range(0, Math.PI * 2);
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), s * Math.sin(a), z];
};

const unitFromLatLon = (lat: number, lon: number): [number, number, number] => [
  Math.cos(lat) * Math.cos(lon),
  Math.cos(lat) * Math.sin(lon),
  Math.sin(lat),
];

/** Add a radial feature centred at unit vector c with angular radius R. f(r) gets r = ang/R. */
function stamp(
  ctx: Ctx,
  c: [number, number, number],
  R: number,
  extent: number,
  f: (r: number, k: number) => number,
  mat?: (r: number, m: number, k: number) => number,
) {
  const { t, px, py, pz } = ctx;
  const { w, h } = t;
  const lat0 = Math.asin(Math.max(-1, Math.min(1, c[2])));
  const lon0 = Math.atan2(c[1], c[0]);
  const reach = R * extent;
  const latMax = Math.min(Math.PI / 2, lat0 + reach);
  const latMin = Math.max(-Math.PI / 2, lat0 - reach);
  const j0 = Math.max(0, Math.floor((0.5 - latMax / Math.PI) * h));
  const j1 = Math.min(h - 1, Math.ceil((0.5 - latMin / Math.PI) * h));
  const cosReach = Math.cos(Math.min(Math.PI, reach));
  for (let j = j0; j <= j1; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI;
    const cl = Math.cos(lat);
    let i0 = 0;
    let i1 = w - 1;
    let wrap = false;
    if (cl > 1e-3 && reach / cl < Math.PI * 0.95) {
      const dl = reach / cl;
      i0 = Math.floor(((lon0 - dl + Math.PI) / (2 * Math.PI)) * w);
      i1 = Math.ceil(((lon0 + dl + Math.PI) / (2 * Math.PI)) * w);
      wrap = true;
    }
    for (let ii = i0; ii <= i1; ii++) {
      const i = wrap ? ((ii % w) + w) % w : ii;
      const k = j * w + i;
      const d = px[k] * c[0] + py[k] * c[1] + pz[k] * c[2];
      if (d < cosReach) continue;
      const r = Math.acos(Math.min(1, d)) / R;
      if (r >= extent) continue;
      t.elev[k] += f(r, k);
      if (mat) t.material[k] = mat(r, t.material[k], k);
    }
  }
}

function craterProfile(depth: number, rim: number, peak: number) {
  return (r: number) => {
    if (r < 1) {
      let e = depth * (r * r - 1) + rim * smoothstep(0.75, 1, r);
      if (peak > 0) e += peak * Math.exp(-(r * r) / 0.03);
      return e;
    }
    const x = r - 1;
    return rim * Math.exp(-(x * x) / 0.02) + rim * 0.25 * Math.pow(r, -3);
  };
}

/** Sprinkle impact craters with a power-law size distribution. */
function craters(ctx: Ctx, count: number, rMin: number, rMax: number, depthScale: number, opts: { rays?: boolean; weight?: (c: [number, number, number]) => number } = {}) {
  const { rng } = ctx;
  for (let n = 0; n < count; n++) {
    const c = randomUnit(rng);
    if (opts.weight && rng.next() > opts.weight(c)) continue;
    const u = Math.max(1e-6, rng.next());
    const R = Math.min(rMax, rMin * Math.pow(u, -1 / 1.8));
    const relSize = R / rMax;
    const depth = depthScale * (R < 0.02 ? R / 0.02 : Math.pow(R / 0.02, 0.35)) * 2500;
    const rim = depth * 0.35;
    const peak = R > 0.02 ? depth * 0.35 : 0;
    const bright = opts.rays && rng.chance(0.25);
    stamp(ctx, c, R, bright ? 3 : 1.8, craterProfile(depth, rim, peak), (r, m) => {
      if (bright) return Math.min(1, m + 0.35 * Math.exp(-r * 1.2) * (1 - relSize));
      return r < 1 ? m * 0.9 + 0.05 : m;
    });
  }
}

function fill(ctx: Ctx, fn: (k: number, x: number, y: number, z: number, lat: number) => [number, number]) {
  const { t, px, py, pz, lat } = ctx;
  const n = t.w * t.h;
  for (let k = 0; k < n; k++) {
    const [e, m] = fn(k, px[k], py[k], pz[k], lat[k]);
    t.elev[k] += e;
    t.material[k] = m;
  }
}

// ------------------------------------------------------------------ plate tectonics

interface Plate {
  c: [number, number, number];
  v: [number, number, number];
  cont: boolean;
  base: number;
}

function plates(ctx: Ctx, contFrac: number) {
  const { rng, noise } = ctx;
  const nPlates = rng.int(12, 18);
  const ps: Plate[] = [];
  for (let k = 0; k < nPlates; k++) {
    const c = randomUnit(rng);
    // Random tangent velocity at the plate centre.
    const r = randomUnit(rng);
    const d = r[0] * c[0] + r[1] * c[1] + r[2] * c[2];
    let v: [number, number, number] = [r[0] - d * c[0], r[1] - d * c[1], r[2] - d * c[2]];
    const vl = Math.hypot(...v) || 1;
    const speed = rng.range(0.25, 1);
    v = [(v[0] / vl) * speed, (v[1] / vl) * speed, (v[2] / vl) * speed];
    ps.push({ c, v, cont: false, base: 0 });
  }
  // Estimate plate areas and choose continental plates until the target area is reached.
  const area = new Array(nPlates).fill(0);
  for (let s = 0; s < 4000; s++) {
    const p = randomUnit(rng);
    let best = -2;
    let bi = 0;
    for (let k = 0; k < nPlates; k++) {
      const d = p[0] * ps[k].c[0] + p[1] * ps[k].c[1] + p[2] * ps[k].c[2];
      if (d > best) {
        best = d;
        bi = k;
      }
    }
    area[bi] += 1 / 4000;
  }
  const order = ps.map((_, k) => k).sort(() => rng.next() - 0.5);
  let acc = 0;
  for (const k of order) {
    if (acc >= contFrac) break;
    if (acc + area[k] > contFrac + 0.12 && acc > 0.05) continue;
    ps[k].cont = true;
    acc += area[k];
  }
  for (const p of ps) p.base = p.cont ? rng.range(380, 800) : rng.range(-4700, -3900);
  // Continental drift: each plate turns about its Euler pole (speed 1 ≈ 8 cm/yr).
  const euler = ps.map((p) => {
    const ax: [number, number, number] = [p.c[1] * p.v[2] - p.c[2] * p.v[1], p.c[2] * p.v[0] - p.c[0] * p.v[2], p.c[0] * p.v[1] - p.c[1] * p.v[0]];
    const l = Math.hypot(...ax) || 1;
    return { axis: [ax[0] / l, ax[1] / l, ax[2] / l] as [number, number, number], ang: Math.hypot(...p.v) * ctx.drift * 0.012 };
  });
  if (ctx.drift > 0)
    ps.forEach((p, i) => {
      p.c = rotateVec(p.c, euler[i].axis, euler[i].ang);
      p.v = rotateVec(p.v, euler[i].axis, euler[i].ang);
    });

  const hotspots: { c: [number, number, number]; R: number; h: number }[] = [];
  for (let k = 0; k < rng.int(4, 9); k++) hotspots.push({ c: randomUnit(rng), R: rng.range(0.012, 0.03), h: rng.range(3500, 6000) });

  const W = 0.12;
  fill(ctx, (k, x, y, z) => {
    // Domain-warp so plate boundaries wiggle.
    const wx = noise.fbm(x * 1.7 + 11.3, y * 1.7, z * 1.7, 2);
    const wy = noise.fbm(x * 1.7, y * 1.7 + 7.1, z * 1.7, 2);
    const wz = noise.fbm(x * 1.7, y * 1.7, z * 1.7 + 3.7, 2);
    let qx = x + 0.32 * wx;
    let qy = y + 0.32 * wy;
    let qz = z + 0.32 * wz;
    const ql = Math.hypot(qx, qy, qz);
    qx /= ql;
    qy /= ql;
    qz /= ql;
    let b1 = -2,
      b2 = -2,
      i1 = 0,
      i2 = 0;
    for (let p = 0; p < ps.length; p++) {
      const c = ps[p].c;
      const d = qx * c[0] + qy * c[1] + qz * c[2];
      if (d > b1) {
        b2 = b1;
        i2 = i1;
        b1 = d;
        i1 = p;
      } else if (d > b2) {
        b2 = d;
        i2 = p;
      }
    }
    const A = ps[i1];
    const B = ps[i2];
    const delta = (Math.acos(Math.min(1, b2)) - Math.acos(Math.min(1, b1))) * 0.5;
    const s = smoothstep(0, W, delta);
    let e = A.base + (B.base - A.base) * 0.5 * (1 - s);
    // Boundary normal (A → B) in the tangent plane, and convergence rate.
    let nx = B.c[0] - A.c[0],
      ny = B.c[1] - A.c[1],
      nz = B.c[2] - A.c[2];
    const nd = nx * qx + ny * qy + nz * qz;
    nx -= nd * qx;
    ny -= nd * qy;
    nz -= nd * qz;
    const nl = Math.hypot(nx, ny, nz) || 1;
    const conv = ((A.v[0] - B.v[0]) * nx + (A.v[1] - B.v[1]) * ny + (A.v[2] - B.v[2]) * nz) / nl;
    const g = (mu: number, sig: number) => Math.exp(-((delta - mu) * (delta - mu)) / (sig * sig));
    if (A.cont && B.cont) {
      if (conv > 0) e += conv * (5200 * g(0, 0.045) + 1800 * g(0, 0.16));
      else e -= -conv * 900 * g(0, 0.02);
    } else if (A.cont && !B.cont) {
      if (conv > 0) e += conv * 3800 * g(0.045, 0.03);
    } else if (!A.cont && B.cont) {
      if (conv > 0) e -= conv * 3200 * g(0.008, 0.014);
    } else {
      if (conv > 0) {
        if (i1 > i2) e += conv * 4200 * g(0.03, 0.012);
        else e -= conv * 3500 * g(0.006, 0.012);
      } else e += (0.35 - conv) * 1800 * g(0, 0.035);
    }
    // Detail is carried by the plate: evaluate it in the plate's own (pre-drift) frame.
    if (ctx.drift > 0 && euler[i1].ang > 0) [x, y, z] = rotateVec([x, y, z], euler[i1].axis, -euler[i1].ang);
    // Detail: hills, ranges, abyssal relief and fractal coasts.
    const cont = e > -1500 ? 1 : 0;
    const hills = cont ? noise.fbm(x * 3 + 5, y * 3, z * 3, 4) * 420 + 120 : noise.fbm(x * 3 + 5, y * 3, z * 3, 3) * 300;
    const mask = smoothstep(0.05, 0.45, noise.fbm(x * 1.3 + 2, y * 1.3 - 4, z * 1.3, 2));
    const ridges = cont ? noise.ridged(x * 5 + 1, y * 5, z * 5, 4) * 2600 * mask : 0;
    e += hills + ridges;
    e += noise.fbm(x * 9, y * 9 + 3, z * 9, 3) * 320 * Math.exp(-(e * e) / (700 * 700));
    // Hotspot volcano chains.
    for (const hs of hotspots) {
      const d = x * hs.c[0] + y * hs.c[1] + z * hs.c[2];
      if (d > 0.995) {
        const r = Math.acos(Math.min(1, d)) / hs.R;
        if (r < 2.5) e += hs.h * Math.exp(-r * r * 1.6);
      }
    }
    const material = 0.5 + 0.5 * noise.fbm(x * 2.2 - 9, y * 2.2, z * 2.2, 3);
    return [e, material];
  });
}

// ------------------------------------------------------------------ styles

function marsLike(ctx: Ctx) {
  const { rng, noise } = ctx;
  const dn = randomUnit(rng);
  const tharsis = randomUnit(rng);
  // Push the volcanic province near the dichotomy boundary.
  const td = tharsis[0] * dn[0] + tharsis[1] * dn[1] + tharsis[2] * dn[2];
  const th: [number, number, number] = [tharsis[0] - 0.8 * td * dn[0], tharsis[1] - 0.8 * td * dn[1], tharsis[2] - 0.8 * td * dn[2]];
  const tl = Math.hypot(...th);
  const T: [number, number, number] = [th[0] / tl, th[1] / tl, th[2] / tl];
  fill(ctx, (_k, x, y, z) => {
    const s = x * dn[0] + y * dn[1] + z * dn[2] + 0.18 * noise.fbm(x * 2, y * 2, z * 2, 4);
    let e = 5000 * smoothstep(-0.2, 0.2, s) - 3500;
    e += noise.fbm(x * 4 + 3, y * 4, z * 4, 6) * 900;
    const dt = x * T[0] + y * T[1] + z * T[2];
    const ang = Math.acos(Math.min(1, dt));
    e += 5500 * Math.exp(-(ang * ang) / (0.5 * 0.5));
    const material = 0.5 + 0.35 * noise.fbm(x * 3 - 4, y * 3, z * 3 + 1, 4) + 0.15 * smoothstep(-0.1, 0.3, s);
    return [e, material];
  });
  // Shield volcanoes around the province plus one giant outlier.
  const shield = (h: number, cr: number) => (r: number) => {
    if (r >= 1) return 0;
    let e = h * Math.pow(1 - r, 1.6);
    if (r < cr) e -= h * 0.15 * (1 - r / cr);
    return e;
  };
  for (let k = 0; k < 3; k++) {
    const off = randomUnit(rng);
    const c = norm([T[0] + 0.18 * off[0], T[1] + 0.18 * off[1], T[2] + 0.18 * off[2]]);
    stamp(ctx, c, rng.range(0.05, 0.08), 1, shield(rng.range(10000, 15000), 0.12), (r, m) => (r < 1 ? m * 0.85 + 0.1 : m));
  }
  const off = randomUnit(rng);
  const big = norm([T[0] + 0.45 * off[0], T[1] + 0.45 * off[1], T[2] + 0.45 * off[2]]);
  stamp(ctx, big, 0.1, 1.15, (r) => (r < 1 ? 20000 * Math.pow(1 - r, 1.4) : r < 1.15 ? -1200 * Math.sin(((r - 1) / 0.15) * Math.PI) : 0));
  // Impact basins.
  for (let k = 0; k < rng.int(2, 3); k++) {
    stamp(ctx, randomUnit(rng), rng.range(0.15, 0.35), 1.5, craterProfile(rng.range(4000, 7000), 1500, 0), (r, m) => (r < 1 ? m * 0.7 + 0.25 : m));
  }
  // Canyon system leading away from the volcanic province.
  const axis = norm(cross(T, randomUnit(rng)));
  for (let s = 0; s < 40; s++) {
    const a = 0.2 + s * 0.018;
    const c = rotate(T, axis, a);
    stamp(ctx, c, 0.035, 1.5, (r) => -6000 * Math.exp(-r * r * 3) * (1 - s / 48), (r, m) => (r < 1 ? m * 0.8 : m));
  }
  craters(ctx, 900, 0.006, 0.08, 0.6, { weight: (c: [number, number, number]) => 0.25 + 0.75 * smoothstep(-0.2, 0.3, c[0] * dn[0] + c[1] * dn[1] + c[2] * dn[2]) });
}

function venusLike(ctx: Ctx) {
  const { rng, noise } = ctx;
  fill(ctx, (_k, x, y, z) => {
    let e = noise.fbm(x * 2.5, y * 2.5, z * 2.5, 6) * 1200;
    e += noise.ridged(x * 6 + 2, y * 6, z * 6, 4) * 500;
    const material = 0.5 + 0.5 * noise.fbm(x * 4 + 1, y * 4, z * 4, 4);
    return [e, material];
  });
  for (let k = 0; k < 2; k++) {
    const c = randomUnit(rng);
    const R = rng.range(0.25, 0.4);
    stamp(ctx, c, R, 1.2, (r) => 3500 * (1 - smoothstep(0.6, 1.1, r)));
    if (k === 0) stamp(ctx, rotate(c, norm(cross(c, randomUnit(rng))), R * 0.4), 0.06, 1, (r) => (r < 1 ? 8000 * Math.pow(1 - r, 1.3) : 0));
  }
  for (let k = 0; k < 30; k++) {
    const c = randomUnit(rng);
    if (rng.chance(0.5)) stamp(ctx, c, rng.range(0.02, 0.05), 1, (r) => (r < 1 ? rng.range(1500, 4000) * Math.pow(1 - r, 1.5) : 0));
    else stamp(ctx, c, rng.range(0.04, 0.09), 1.4, (r) => 700 * Math.exp(-((r - 1) * (r - 1)) / 0.02) - 400 * (r < 1 ? 1 - r : 0));
  }
  craters(ctx, 120, 0.006, 0.03, 0.5);
}

function moonLike(ctx: Ctx, maria: boolean, densityScale = 1) {
  const { rng, noise } = ctx;
  fill(ctx, (_k, x, y, z) => {
    const e = noise.fbm(x * 3, y * 3, z * 3, 6) * 1500;
    const material = 0.7 + 0.15 * noise.fbm(x * 5 + 3, y * 5, z * 5, 4);
    return [e, material];
  });
  if (maria) {
    // Maria concentrate on the hemisphere facing lon 0 (the primary, when tidally locked).
    const { px, py, pz } = ctx;
    for (let k = 0; k < 7; k++) {
      const lat = rng.range(-0.6, 0.8);
      const lon = rng.range(-1.3, 1.3);
      const base = unitFromLatLon(lat, lon);
      const R0 = rng.range(0.18, 0.34);
      for (let b = 0; b < 3; b++) {
        const off = randomUnit(rng);
        const c = norm([base[0] + 0.12 * off[0], base[1] + 0.12 * off[1], base[2] + 0.12 * off[2]]);
        const R = R0 * rng.range(0.5, 0.9);
        const edge = (r: number, q: number) => r + 0.35 * noise.fbm(px[q] * 6 + k, py[q] * 6, pz[q] * 6, 3);
        stamp(ctx, c, R, 1.6, (r, q) => (b === 0 ? -1600 : -500) * (1 - smoothstep(0.7, 1.1, edge(r, q))), (r, m, q) => (edge(r, q) < 1 ? Math.min(m, 0.1 + 0.06 * noise.noise(px[q] * 9, py[q] * 9, pz[q] * 9)) : m));
      }
    }
  }
  craters(ctx, Math.round(1500 * densityScale), 0.005, 0.12, 1, { rays: true });
  // A couple of giant basins.
  for (let k = 0; k < 2; k++) stamp(ctx, randomUnit(rng), rng.range(0.3, 0.5), 1.4, craterProfile(5000, 1500, 0));
}

function icyCracked(ctx: Ctx) {
  const { rng, noise, px, py, pz, t } = ctx;
  fill(ctx, (_k, x, y, z) => {
    const chaos = smoothstep(0.35, 0.6, noise.fbm(x * 3 + 8, y * 3, z * 3, 4));
    const e = -120 * chaos + noise.fbm(x * 8, y * 8, z * 8, 4) * 80;
    return [e, 0.88 - 0.35 * chaos];
  });
  // Lineae: long arcs of great circles, a double ridge with a dark band.
  const arcs: { n: [number, number, number]; c: [number, number, number]; ext: number; w: number }[] = [];
  for (let a = 0; a < 70; a++) {
    arcs.push({ n: randomUnit(rng), c: randomUnit(rng), ext: Math.cos(rng.range(0.4, 1.6)), w: rng.range(0.003, 0.009) });
  }
  const n = t.w * t.h;
  for (let k = 0; k < n; k++) {
    const x = px[k],
      y = py[k],
      z = pz[k];
    let line = 0;
    for (const a of arcs) {
      if (x * a.c[0] + y * a.c[1] + z * a.c[2] < a.ext) continue;
      const d = Math.abs(x * a.n[0] + y * a.n[1] + z * a.n[2]);
      if (d < a.w * 3) line = Math.max(line, Math.exp(-(d * d) / (a.w * a.w)));
    }
    t.elev[k] += 180 * line;
    t.material[k] = Math.max(0.15, t.material[k] - 0.55 * line);
  }
  craters(ctx, 25, 0.008, 0.04, 0.2);
}

function icyGrooved(ctx: Ctx, cratered: number) {
  const { noise } = ctx;
  fill(ctx, (_k, x, y, z) => {
    const region = noise.fbm(x * 1.6 + 1, y * 1.6, z * 1.6, 4);
    const dark = smoothstep(-0.05, 0.1, region);
    const grooves = noise.ridged(x * 12, y * 4, z * 9, 3) * (1 - dark);
    const e = noise.fbm(x * 3, y * 3, z * 3, 5) * 900 + grooves * 400;
    const material = 0.75 - 0.45 * dark + 0.1 * grooves;
    return [e, material];
  });
  craters(ctx, Math.round(900 * cratered), 0.005, 0.08, 0.5, { rays: true });
}

function ioLike(ctx: Ctx) {
  const { rng, noise } = ctx;
  fill(ctx, (_k, x, y, z) => {
    const e = noise.fbm(x * 3, y * 3, z * 3, 5) * 600;
    const material = 0.5 + 0.5 * noise.fbm(x * 4 + 2, y * 4, z * 4, 5);
    return [e, material];
  });
  for (let k = 0; k < 80; k++) {
    stamp(ctx, randomUnit(rng), rng.range(0.008, 0.03), 2.5, (r) => (r < 1 ? -300 * (1 - r) : 0), (r, m) => (r < 1 ? 0.02 : r < 2.5 ? Math.min(m, 0.25 + 0.3 * (r - 1)) : m));
  }
  for (let k = 0; k < 10; k++) stamp(ctx, randomUnit(rng), rng.range(0.03, 0.07), 1, (r) => (r < 1 ? rng.range(4000, 10000) * (1 - smoothstep(0.3, 1, r)) : 0));
}

function titanLike(ctx: Ctx) {
  const { rng, noise } = ctx;
  fill(ctx, (_k, x, y, z, lat) => {
    const eq = 1 - smoothstep(0.35, 0.6, Math.abs(lat));
    const dunes = noise.ridged(x * 30, y * 30, z * 4, 2) * 120 * eq;
    const polar = smoothstep(0.9, 1.35, Math.abs(lat));
    const basins = -1100 * polar * (0.6 + 0.4 * noise.fbm(x * 5, y * 5, z * 5, 4)) * (lat > 0 ? 1 : 0.55);
    const e = noise.fbm(x * 3 + 1, y * 3, z * 3, 6) * 500 + dunes + basins + noise.ridged(x * 4, y * 4 + 2, z * 4, 4) * 400 * (1 - eq);
    const material = 0.5 - 0.25 * eq + 0.2 * noise.fbm(x * 3 + 6, y * 3, z * 3, 3);
    return [e, material];
  });
  craters(ctx, 15, 0.01, 0.05, 0.4);
  void rng;
}

function plutoLike(ctx: Ctx) {
  const { rng, noise } = ctx;
  fill(ctx, (_k, x, y, z, lat) => {
    const e = noise.fbm(x * 3, y * 3, z * 3, 5) * 1500;
    const band = 1 - smoothstep(0.15, 0.5, Math.abs(lat + 0.1 * noise.fbm(x * 2, y * 2, z * 2, 3)));
    const material = 0.75 - 0.55 * band * smoothstep(-0.2, 0.2, noise.fbm(x * 1.5 + 4, y * 1.5, z * 1.5, 3));
    return [e, material];
  });
  craters(ctx, 400, 0.006, 0.07, 0.6);
  const c = unitFromLatLon(rng.range(-0.2, 0.5), rng.range(-1, 1));
  stamp(ctx, c, 0.35, 1.25, (r) => (r < 1 ? -3500 * (1 - smoothstep(0.75, 1, r)) : 1800 * Math.exp(-((r - 1.08) * (r - 1.08)) / 0.003)), (r, m) => (r < 1 ? 0.95 : m));
}

function tritonLike(ctx: Ctx) {
  const { noise } = ctx;
  fill(ctx, (_k, x, y, z, lat) => {
    const cells = noise.ridged(x * 14, y * 14, z * 14, 2);
    const e = cells * 350 + noise.fbm(x * 3, y * 3, z * 3, 4) * 500;
    const cap = smoothstep(-0.2, -0.6, lat);
    const material = 0.6 + 0.3 * cap - 0.15 * cells;
    return [e, material];
  });
  craters(ctx, 60, 0.006, 0.03, 0.3);
}

function asteroidLike(ctx: Ctx) {
  const { noise } = ctx;
  fill(ctx, (_k, x, y, z) => [noise.fbm(x * 2, y * 2, z * 2, 5) * 6000, 0.5 + 0.3 * noise.fbm(x * 4, y * 4, z * 4, 3)]);
  craters(ctx, 300, 0.03, 0.3, 2, { rays: false });
}

function lavaWorld(ctx: Ctx) {
  const { noise } = ctx;
  fill(ctx, (_k, x, y, z) => {
    const e = noise.fbm(x * 3, y * 3, z * 3, 6) * 800 + noise.ridged(x * 8, y * 8, z * 8, 3) * 300;
    return [e, 0.5 + 0.5 * noise.fbm(x * 6 + 3, y * 6, z * 6, 4)];
  });
}

// ------------------------------------------------------------------ vector helpers
function norm(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function rotate(v: [number, number, number], k: [number, number, number], ang: number): [number, number, number] {
  const c = Math.cos(ang),
    s = Math.sin(ang);
  const kxv = cross(k, v);
  const kd = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return norm([v[0] * c + kxv[0] * s + k[0] * kd * (1 - c), v[1] * c + kxv[1] * s + k[1] * kd * (1 - c), v[2] * c + kxv[2] * s + k[2] * kd * (1 - c)]);
}

const cache = new Map<string, TerrainMap>();

/** Generate (or fetch from cache) a terrain map. */
export function generateTerrain(style: TerrainStyle, seed: number, w = 512, h = 256, drift = 0): TerrainMap {
  const key = `${style}:${seed}:${w}x${h}:${drift.toFixed(1)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const n = w * h;
  const t: TerrainMap = { style, seed, w, h, elev: new Float32Array(n), material: new Float32Array(n).fill(0.5), min: 0, max: 0 };
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pz = new Float32Array(n);
  const lat = new Float32Array(n);
  for (let j = 0; j < h; j++) {
    const la = (0.5 - (j + 0.5) / h) * Math.PI;
    for (let i = 0; i < w; i++) {
      const lo = ((i + 0.5) / w) * 2 * Math.PI - Math.PI;
      const k = j * w + i;
      px[k] = Math.cos(la) * Math.cos(lo);
      py[k] = Math.cos(la) * Math.sin(lo);
      pz[k] = Math.sin(la);
      lat[k] = la;
    }
  }
  const ctx: Ctx = { t, px, py, pz, lat, noise: new Noise3(seed), rng: new Rng(seed * 7919 + 13), drift };
  switch (style) {
    case 'earthlike':
      plates(ctx, 0.4);
      break;
    case 'oceanic':
      plates(ctx, 0.14);
      break;
    case 'continental':
      plates(ctx, 0.62);
      break;
    case 'marslike':
      marsLike(ctx);
      break;
    case 'venuslike':
      venusLike(ctx);
      break;
    case 'moonlike':
      moonLike(ctx, true);
      break;
    case 'mercurylike':
      moonLike(ctx, false, 1.4);
      break;
    case 'europalike':
      icyCracked(ctx);
      break;
    case 'ganymedelike':
      icyGrooved(ctx, 0.6);
      break;
    case 'callistolike':
      icyGrooved(ctx, 1.8);
      break;
    case 'iolike':
      ioLike(ctx);
      break;
    case 'titanlike':
      titanLike(ctx);
      break;
    case 'plutolike':
      plutoLike(ctx);
      break;
    case 'tritonlike':
      tritonLike(ctx);
      break;
    case 'asteroid':
      asteroidLike(ctx);
      break;
    case 'lavaworld':
      lavaWorld(ctx);
      break;
  }
  let mn = Infinity,
    mx = -Infinity;
  for (let k = 0; k < n; k++) {
    const e = t.elev[k];
    if (e < mn) mn = e;
    if (e > mx) mx = e;
    t.material[k] = Math.max(0, Math.min(1, t.material[k]));
  }
  t.min = mn;
  t.max = mx;
  if (cache.size > 24) cache.delete(cache.keys().next().value as string);
  cache.set(key, t);
  return t;
}

/** Default terrain style for a body with the given surface character. */
export function defaultTerrainFor(opts: { hasAtmosphere: boolean; icy: boolean; water: boolean; volcanic?: boolean }): TerrainStyle {
  if (opts.volcanic) return 'iolike';
  if (opts.water) return 'earthlike';
  if (opts.icy) return opts.hasAtmosphere ? 'tritonlike' : 'ganymedelike';
  return opts.hasAtmosphere ? 'marslike' : 'moonlike';
}

// ------------------------------------------------------------------ runtime impact craters

export interface CraterRecord {
  /** Body-fixed latitude/longitude (rad). */
  lat: number;
  lon: number;
  /** Final rim-to-rim diameter (m) and depth (m). */
  diameter: number;
  depth: number;
  /** Sim time of the impact (s). */
  time: number;
}

const pixelCache = new WeakMap<TerrainMap, { px: Float32Array; py: Float32Array; pz: Float32Array; lat: Float32Array }>();

function pixelVectors(t: TerrainMap) {
  let v = pixelCache.get(t);
  if (v) return v;
  const n = t.w * t.h;
  v = { px: new Float32Array(n), py: new Float32Array(n), pz: new Float32Array(n), lat: new Float32Array(n) };
  for (let j = 0; j < t.h; j++) {
    const la = (0.5 - (j + 0.5) / t.h) * Math.PI;
    for (let i = 0; i < t.w; i++) {
      const lo = ((i + 0.5) / t.w) * 2 * Math.PI - Math.PI;
      const k = j * t.w + i;
      v.px[k] = Math.cos(la) * Math.cos(lo);
      v.py[k] = Math.cos(la) * Math.sin(lo);
      v.pz[k] = Math.sin(la);
      v.lat[k] = la;
    }
  }
  pixelCache.set(t, v);
  return v;
}

/** Deep copy so a body can be cratered without touching the shared cached base map. */
export function cloneTerrain(t: TerrainMap): TerrainMap {
  return { ...t, elev: t.elev.slice(), material: t.material.slice() };
}

/**
 * Final crater size from impactor properties (Collins, Melosh & Marcus 2005 pi-scaling).
 * Returns diameters/depth in metres.
 */
export function craterScaling(
  impactorDiameter: number,
  velocity: number,
  rhoImpactor: number,
  rhoTarget: number,
  gravity: number,
  angle = Math.PI / 4,
): { transient: number; diameter: number; depth: number; complex: boolean } {
  const g = Math.max(0.01, gravity);
  const Dtc = 1.161 * Math.cbrt(rhoImpactor / rhoTarget) * Math.pow(impactorDiameter, 0.78) * Math.pow(velocity, 0.44) * Math.pow(g, -0.22) * Math.cbrt(Math.sin(angle));
  const Dc = 3200 * (9.81 / g); // simple → complex transition
  if (1.25 * Dtc < Dc) {
    const D = 1.25 * Dtc;
    return { transient: Dtc, diameter: D, depth: 0.2 * D, complex: false };
  }
  const D = (1.17 * Math.pow(Dtc, 1.13)) / Math.pow(Dc, 0.13);
  const depth = 1044 * Math.pow(D / 1000, 0.301) * Math.pow(1.62 / g, 0.3);
  return { transient: Dtc, diameter: D, depth: Math.min(depth, 0.2 * D), complex: true };
}

/** Carve a crater (bowl, rim, central peak, ejecta blanket and bright rays) into the map. */
export function applyCrater(t: TerrainMap, c: CraterRecord, planetRadius: number): void {
  const v = pixelVectors(t);
  const R = Math.min(1.2, c.diameter / 2 / planetRadius);
  const centre = unitFromLatLon(c.lat, c.lon);
  const complex = c.depth < 0.15 * c.diameter;
  const rim = c.depth * (complex ? 0.18 : 0.32);
  const peak = complex ? c.depth * 0.3 : 0;
  // Tangent basis for ray azimuths.
  let e1 = cross([0, 0, 1], centre);
  if (Math.hypot(...e1) < 1e-6) e1 = [1, 0, 0];
  e1 = norm(e1);
  const e2 = cross(centre, e1);
  const noise = new Noise3(Math.floor((c.lat + 7) * 1e5 + c.lon * 1e3) >>> 0);
  const nRays = 9 + Math.floor(noise.noise(c.lat, c.lon, 1) * 4 + 4);
  const ctx: Ctx = { t, px: v.px, py: v.py, pz: v.pz, lat: v.lat, noise, rng: new Rng(1), drift: 0 };
  const profile = craterProfile(c.depth, rim, peak);
  // Big basins flatten the pre-existing relief inside the cavity.
  stamp(
    ctx,
    centre,
    R,
    3.2,
    (r, k) => {
      const base = profile(r);
      if (r < 1 && R > 0.02) {
        // Partially erase older topography inside the cavity (melt pool / floor).
        return base - (t.elev[k] - (t.elev[k] * 0.4)) * (1 - smoothstep(0.6, 1, r)) * 0.6;
      }
      return base;
    },
    (r, m, k) => {
      const x = v.px[k],
        y = v.py[k],
        z = v.pz[k];
      const az = Math.atan2(x * e2[0] + y * e2[1] + z * e2[2], x * e1[0] + y * e1[1] + z * e1[2]);
      if (r < 1) return Math.max(0.05, m * 0.5 + 0.15);
      const ray = Math.pow(Math.max(0, Math.cos(az * nRays * 0.5 + noise.noise(az * 3, 0, 0) * 2)), 6);
      const blanket = Math.exp(-(r - 1) * 2.2);
      return Math.min(1, m + 0.45 * blanket * (0.35 + 0.65 * ray));
    },
  );
  let mn = Infinity,
    mx = -Infinity;
  for (let k = 0; k < t.elev.length; k++) {
    const e = t.elev[k];
    if (e < mn) mn = e;
    if (e > mx) mx = e;
  }
  t.min = mn;
  t.max = mx;
}

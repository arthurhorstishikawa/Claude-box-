/**
 * Regular latitude–longitude grid on the sphere. Row 0 is the northernmost row, column 0
 * starts at longitude −180°. Provides area weights, an unconditionally stable implicit
 * (ADI / Lie-split) diffusion solver and semi-Lagrangian advection.
 */
export class LatLonGrid {
  readonly N: number;
  readonly lat: Float64Array;
  readonly lon: Float64Array;
  readonly cosLat: Float64Array;
  readonly sinLat: Float64Array;
  /** Fraction of the sphere's area in one cell of each row (sums to 1 over the grid). */
  readonly cellArea: Float64Array;
  /** cos(latitude) at the face between row j and j+1 (length nLat-1). */
  readonly cosFace: Float64Array;
  readonly dLat: number;
  readonly dLon: number;
  // scratch
  private a: Float64Array;
  private b: Float64Array;
  private c: Float64Array;
  private r: Float64Array;
  private x: Float64Array;
  private z: Float64Array;
  private u: Float64Array;
  private bb: Float64Array;
  private gam: Float64Array;
  private tmp: Float64Array;

  constructor(readonly nLat: number, readonly nLon: number) {
    this.N = nLat * nLon;
    this.dLat = Math.PI / nLat;
    this.dLon = (2 * Math.PI) / nLon;
    this.lat = new Float64Array(nLat);
    this.cosLat = new Float64Array(nLat);
    this.sinLat = new Float64Array(nLat);
    this.cellArea = new Float64Array(nLat);
    this.cosFace = new Float64Array(Math.max(0, nLat - 1));
    for (let j = 0; j < nLat; j++) {
      const la = Math.PI / 2 - (j + 0.5) * this.dLat;
      this.lat[j] = la;
      this.cosLat[j] = Math.cos(la);
      this.sinLat[j] = Math.sin(la);
      const top = Math.PI / 2 - j * this.dLat;
      const bot = top - this.dLat;
      this.cellArea[j] = (Math.sin(top) - Math.sin(bot)) / 2 / nLon;
    }
    for (let j = 0; j < nLat - 1; j++) this.cosFace[j] = Math.cos(Math.PI / 2 - (j + 1) * this.dLat);
    this.lon = new Float64Array(nLon);
    for (let i = 0; i < nLon; i++) this.lon[i] = -Math.PI + (i + 0.5) * this.dLon;
    const m = Math.max(nLat, nLon);
    this.a = new Float64Array(m);
    this.b = new Float64Array(m);
    this.c = new Float64Array(m);
    this.r = new Float64Array(m);
    this.x = new Float64Array(m);
    this.z = new Float64Array(m);
    this.u = new Float64Array(m);
    this.bb = new Float64Array(m);
    this.gam = new Float64Array(m);
    this.tmp = new Float64Array(this.N);
  }

  idx(j: number, i: number): number {
    return j * this.nLon + i;
  }

  /** Area-weighted global mean. */
  mean(f: ArrayLike<number>, mask?: ArrayLike<number>): number {
    let s = 0;
    let w = 0;
    for (let j = 0; j < this.nLat; j++) {
      const a = this.cellArea[j];
      for (let i = 0; i < this.nLon; i++) {
        const k = j * this.nLon + i;
        const m = mask ? mask[k] : 1;
        s += f[k] * a * m;
        w += a * m;
      }
    }
    return w > 0 ? s / w : 0;
  }

  /** Bilinear sample at (lat, lon) in radians. */
  sample(f: ArrayLike<number>, lat: number, lon: number): number {
    const { nLat, nLon } = this;
    let y = (0.5 - lat / Math.PI) * nLat - 0.5;
    let x = ((lon + Math.PI) / (2 * Math.PI)) * nLon - 0.5;
    if (y < 0) y = 0;
    if (y > nLat - 1) y = nLat - 1;
    x = ((x % nLon) + nLon) % nLon;
    const j0 = Math.floor(y);
    const j1 = Math.min(nLat - 1, j0 + 1);
    const fy = y - j0;
    const i0 = Math.floor(x);
    const i1 = (i0 + 1) % nLon;
    const fx = x - i0;
    const a = f[j0 * nLon + i0] * (1 - fx) + f[j0 * nLon + i1] * fx;
    const b = f[j1 * nLon + i0] * (1 - fx) + f[j1 * nLon + i1] * fx;
    return a * (1 - fy) + b * fy;
  }

  /** Cell index containing (lat, lon). */
  cellOf(lat: number, lon: number): number {
    const j = Math.min(this.nLat - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * this.nLat)));
    let i = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * this.nLon);
    i = ((i % this.nLon) + this.nLon) % this.nLon;
    return j * this.nLon + i;
  }

  private tridag(n: number, a: Float64Array, b: Float64Array, c: Float64Array, r: Float64Array, x: Float64Array) {
    const gam = this.gam;
    let bet = b[0];
    x[0] = r[0] / bet;
    for (let k = 1; k < n; k++) {
      gam[k] = c[k - 1] / bet;
      bet = b[k] - a[k] * gam[k];
      x[k] = (r[k] - a[k] * x[k - 1]) / bet;
    }
    for (let k = n - 2; k >= 0; k--) x[k] -= gam[k + 1] * x[k + 1];
  }

  /** Cyclic tridiagonal solve (Sherman–Morrison). alpha = A[n-1][0], beta = A[0][n-1]. */
  private cyclic(n: number, a: Float64Array, b: Float64Array, c: Float64Array, alpha: number, beta: number, r: Float64Array, x: Float64Array) {
    const bb = this.bb;
    const u = this.u;
    const z = this.z;
    const gamma = -b[0];
    for (let k = 0; k < n; k++) bb[k] = b[k];
    bb[0] = b[0] - gamma;
    bb[n - 1] = b[n - 1] - (alpha * beta) / gamma;
    this.tridag(n, a, bb, c, r, x);
    u.fill(0, 0, n);
    u[0] = gamma;
    u[n - 1] = alpha;
    this.tridag(n, a, bb, c, u, z);
    const fact = (x[0] + (beta * x[n - 1]) / gamma) / (1 + z[0] + (beta * z[n - 1]) / gamma);
    for (let k = 0; k < n; k++) x[k] -= fact * z[k];
  }

  /**
   * Implicit diffusion of field X over dt:  C ∂X/∂t = ∇·(κ m ∇X), where κ = conductance factor
   * (e.g. heat capacity × diffusivity, W/K) and m an optional per-cell connectivity mask (face
   * conductance uses min of the two cells). cap = per-cell capacity (J/m²/K) or scalar.
   */
  diffuse(X: Float64Array, cap: Float64Array | number, kappa: number, R: number, dt: number, mask?: Float64Array): void {
    if (kappa <= 0 || dt <= 0) return;
    const { nLat, nLon, a, b, c, r, x } = this;
    const capAt = (k: number) => (typeof cap === 'number' ? cap : cap[k]);
    const R2 = R * R;
    const dl2 = this.dLon * this.dLon;
    const dp2 = this.dLat * this.dLat;
    // Zonal sweeps (periodic).
    for (let j = 0; j < nLat; j++) {
      const cl = Math.max(this.cosLat[j], 1e-4);
      const g0 = kappa / (R2 * cl * cl * dl2);
      const base = j * nLon;
      let any = false;
      for (let i = 0; i < nLon; i++) {
        const k = base + i;
        const kl = base + ((i - 1 + nLon) % nLon);
        const kr = base + ((i + 1) % nLon);
        const ml = mask ? Math.min(mask[k], mask[kl]) : 1;
        const mr = mask ? Math.min(mask[k], mask[kr]) : 1;
        const s = dt / Math.max(capAt(k), 1e-9);
        const gl = g0 * ml * s;
        const gr = g0 * mr * s;
        if (gl > 0 || gr > 0) any = true;
        a[i] = -gl;
        c[i] = -gr;
        b[i] = 1 + gl + gr;
        r[i] = X[k];
      }
      if (!any) continue;
      this.cyclic(nLon, a, b, c, c[nLon - 1], a[0], r, x);
      for (let i = 0; i < nLon; i++) X[base + i] = x[i];
    }
    // Meridional sweeps.
    for (let i = 0; i < nLon; i++) {
      let any = false;
      for (let j = 0; j < nLat; j++) {
        const k = j * nLon + i;
        const cl = Math.max(this.cosLat[j], 1e-4);
        const s = dt / Math.max(capAt(k), 1e-9);
        let gn = 0;
        let gs = 0;
        if (j > 0) {
          const kn = k - nLon;
          const m = mask ? Math.min(mask[k], mask[kn]) : 1;
          gn = ((kappa * this.cosFace[j - 1]) / (R2 * cl * dp2)) * m * s;
        }
        if (j < nLat - 1) {
          const ks = k + nLon;
          const m = mask ? Math.min(mask[k], mask[ks]) : 1;
          gs = ((kappa * this.cosFace[j]) / (R2 * cl * dp2)) * m * s;
        }
        if (gn > 0 || gs > 0) any = true;
        a[j] = -gn;
        c[j] = -gs;
        b[j] = 1 + gn + gs;
        r[j] = X[k];
      }
      if (!any) continue;
      this.tridag(nLat, a, b, c, r, x);
      for (let j = 0; j < nLat; j++) X[j * nLon + i] = x[j];
    }
  }

  /**
   * Semi-Lagrangian advection of X by winds (u east, v north; m/s) over dt.
   * Displacements are capped to keep the scheme meaningful at large steps.
   */
  advect(X: Float64Array, u: Float64Array, v: Float64Array, R: number, dt: number, maxAngle = 0.35): void {
    const { nLat, nLon } = this;
    const out = this.tmp;
    for (let j = 0; j < nLat; j++) {
      const la = this.lat[j];
      const cl = Math.max(this.cosLat[j], 0.02);
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        let dphi = (v[k] * dt) / R;
        let dlam = (u[k] * dt) / (R * cl);
        const mag = Math.hypot(dphi, dlam * cl);
        if (mag > maxAngle) {
          const s = maxAngle / mag;
          dphi *= s;
          dlam *= s;
        }
        let lat = la - dphi;
        let lon = this.lon[i] - dlam;
        if (lat > Math.PI / 2) {
          lat = Math.PI - lat;
          lon += Math.PI;
        } else if (lat < -Math.PI / 2) {
          lat = -Math.PI - lat;
          lon += Math.PI;
        }
        out[k] = this.sample(X, lat, lon);
      }
    }
    X.set(out.subarray(0, this.N));
  }

  /** Simple box blur (one pass, 3×3 with wrap), for smoothing diagnostic fields. */
  blur(X: Float64Array, out: Float64Array): void {
    const { nLat, nLon } = this;
    for (let j = 0; j < nLat; j++) {
      const jn = Math.max(0, j - 1);
      const js = Math.min(nLat - 1, j + 1);
      for (let i = 0; i < nLon; i++) {
        const il = (i - 1 + nLon) % nLon;
        const ir = (i + 1) % nLon;
        out[j * nLon + i] =
          (4 * X[j * nLon + i] + X[j * nLon + il] + X[j * nLon + ir] + X[jn * nLon + i] + X[js * nLon + i]) / 8;
      }
    }
  }
}

/** Resample a field between grids (bilinear). */
export function regrid(src: Float64Array, from: LatLonGrid, to: LatLonGrid): Float64Array {
  const out = new Float64Array(to.N);
  for (let j = 0; j < to.nLat; j++) for (let i = 0; i < to.nLon; i++) out[j * to.nLon + i] = from.sample(src, to.lat[j], to.lon[i]);
  return out;
}

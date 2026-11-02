import { clamp } from '../core/math';
import type { LatLonGrid } from './grid';

const OMEGA_EARTH = 7.2921e-5;

export interface CirculationInput {
  Ts: Float64Array;
  R: number;
  g: number;
  /** Signed rotation rate relative to the inertial frame (rad/s). */
  omega: number;
  /** Surface pressure (Pa) and dry-air molar mass (kg/mol). */
  P: number;
  molar: number;
  Tmean: number;
  locked: boolean;
  /** Latitude of the substellar point (rad) — ITCZ guide for slow rotators. */
  subLat: number;
}

/** Diagnostic general circulation: Hadley/Ferrel/polar cells, thermal lows, frictional winds. */
export class Circulation {
  u: Float64Array;
  v: Float64Array;
  /** Upper-level (cloud-level) zonal wind for cloud motion. */
  uCloud: Float64Array;
  pAnom: Float64Array;
  zonalT: Float64Array;
  hadleyEdge = 0.5;
  itcz = 0;
  nCells = 3;
  jet = 0;
  equatorPoleDT = 0;
  private anom: Float64Array;
  private anom2: Float64Array;
  private pTherm: Float64Array;

  constructor(private grid: LatLonGrid) {
    this.u = new Float64Array(grid.N);
    this.v = new Float64Array(grid.N);
    this.uCloud = new Float64Array(grid.N);
    this.pAnom = new Float64Array(grid.N);
    this.zonalT = new Float64Array(grid.nLat);
    this.anom = new Float64Array(grid.N);
    this.anom2 = new Float64Array(grid.N);
    this.pTherm = new Float64Array(grid.N);
  }

  update(inp: CirculationInput): void {
    const grid = this.grid;
    const { nLat, nLon } = grid;
    const { Ts, R, g, P } = inp;
    if (P < 1) {
      this.u.fill(0);
      this.v.fill(0);
      this.uCloud.fill(0);
      this.pAnom.fill(0);
      return;
    }
    // Zonal means and contrast.
    let tMax = -Infinity,
      tMin = Infinity,
      jMax = 0;
    for (let j = 0; j < nLat; j++) {
      let s = 0;
      for (let i = 0; i < nLon; i++) s += Ts[j * nLon + i];
      const z = s / nLon;
      this.zonalT[j] = z;
      if (z > tMax) {
        tMax = z;
        jMax = j;
      }
      if (z < tMin) tMin = z;
    }
    const dT = Math.max(1, tMax - tMin);
    this.equatorPoleDT = dT;
    const Tm = Math.max(30, inp.Tmean);
    const absOm = Math.max(Math.abs(inp.omega), 1e-9);
    const H = Math.min(12_000 * (9.81 / g) * (Tm / 288), 0.2 * R);
    const Ro = (g * H * 1.5 * dT) / (Tm * absOm * absOm * R * R);
    const phiH = clamp(Math.sqrt((5 / 3) * Ro), 0.2, Math.PI / 2);
    const n = clamp(Math.round(Math.PI / 2 / phiH), 1, 6);
    this.nCells = n;
    this.hadleyEdge = n === 1 ? Math.PI / 2 : phiH;
    const w = n > 1 ? (Math.PI / 2 - phiH) / (n - 1) : 1;
    // ITCZ: warmest zonal band (or substellar latitude for slow rotators).
    let itcz = grid.lat[jMax];
    if (n === 1 || inp.locked) itcz = inp.subLat;
    itcz = clamp(itcz, -0.6 * this.hadleyEdge, 0.6 * this.hadleyEdge);
    this.itcz = itcz;
    const rot = Math.sign(inp.omega) || 1;
    const U0 = 7 * Math.sqrt(dT / 45) * Math.pow(P / 1e5, -0.1) * (n === 1 ? 0.5 : 1);
    const Ap = 800 * Math.pow(Math.min(P, 2e7) / 1e5, 0.8) * Math.sqrt(Math.min(dT, 200) / 45);
    // Jet stream at the poleward edge of the Hadley cell.
    const jetLat = Math.min(this.hadleyEdge + 0.1, 1.2);
    this.jet = n > 1 ? Math.min(80, 25 * Math.sqrt(dT / 45) * Math.sqrt(OMEGA_EARTH / absOm)) : 0;
    const superRot = n === 1 || inp.locked ? Math.min(100, 30 * Math.pow(P / 1e5, 0.3)) : 0;

    // Thermal anomaly relative to zonal mean, smoothed (thermal lows/highs are large scale).
    for (let k = 0; k < grid.N; k++) this.anom[k] = Ts[k] - this.zonalT[Math.floor(k / nLon)];
    grid.blur(this.anom, this.anom2);
    grid.blur(this.anom2, this.anom);
    const kp = 60 * Math.pow(Math.min(P, 2e7) / 1e5, 0.8);
    for (let k = 0; k < grid.N; k++) this.pTherm[k] = -kp * this.anom[k];

    const rho = (P * inp.molar) / (8.314 * Tm);
    const rf = 1.2e-5;
    for (let j = 0; j < nLat; j++) {
      const phi = grid.lat[j];
      const s = phi - itcz;
      const hs = s >= 0 ? 1 : -1;
      const as = Math.abs(s);
      let uz = 0,
        vz = 0,
        pz = 0;
      if (n === 1 || as < phiH) {
        const edge = n === 1 ? Math.PI / 2 + Math.abs(itcz) : phiH;
        const x = clamp(as / edge, 0, 1);
        vz = -hs * 0.35 * U0 * Math.sin(Math.PI * x);
        uz = -U0 * Math.sin(Math.PI * x) * 0.9;
        pz = -Ap * Math.cos(Math.PI * x);
      } else {
        const rel = as - phiH;
        const k = Math.min(n - 1, 1 + Math.floor(rel / w));
        const x = clamp((rel - (k - 1) * w) / w, 0, 1);
        const westerly = k % 2 === 1;
        uz = (westerly ? 1 : -1) * U0 * Math.sin(Math.PI * x) * (k === 1 ? 1.1 : 0.6);
        vz = (westerly ? hs : -hs) * 0.2 * U0 * Math.sin(Math.PI * x);
        pz = (westerly ? 1 : -1) * Ap * Math.cos(Math.PI * x);
      }
      uz *= rot;
      const f = 2 * inp.omega * Math.sin(phi);
      const cl = Math.max(grid.cosLat[j], 0.05);
      const jet = this.jet * Math.exp(-((Math.abs(phi) - jetLat) ** 2) / 0.04) * rot;
      const sr = superRot * Math.cos(phi) * rot;
      for (let i = 0; i < nLon; i++) {
        const k = j * nLon + i;
        const kl = j * nLon + ((i - 1 + nLon) % nLon);
        const kr = j * nLon + ((i + 1) % nLon);
        const kn = j > 0 ? k - nLon : k;
        const ks = j < nLat - 1 ? k + nLon : k;
        const dpdx = (this.pTherm[kr] - this.pTherm[kl]) / (2 * R * cl * grid.dLon);
        const dpdy = (this.pTherm[kn] - this.pTherm[ks]) / ((kn !== k && ks !== k ? 2 : 1) * R * grid.dLat);
        const Gx = -dpdx / rho;
        const Gy = -dpdy / rho;
        const den = rf * rf + f * f;
        let up = (rf * Gx + f * Gy) / den;
        let vp = (rf * Gy - f * Gx) / den;
        const sp = Math.hypot(up, vp);
        if (sp > 30) {
          up *= 30 / sp;
          vp *= 30 / sp;
        }
        this.u[k] = uz + up;
        this.v[k] = vz + vp;
        this.uCloud[k] = 1.3 * this.u[k] + jet + sr;
        this.pAnom[k] = pz + this.pTherm[k];
      }
    }
  }
}

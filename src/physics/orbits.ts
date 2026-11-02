import { V3 } from '../core/vec3';

/**
 * Two-body orbit described with perifocal basis vectors (P toward periapsis, Q 90° ahead in
 * the direction of motion, W = angular momentum direction). Avoids angle singularities.
 */
export interface Orbit {
  mu: number;
  /** Semi-major axis (negative for hyperbolic). */
  a: number;
  e: number;
  P: V3;
  Q: V3;
  W: V3;
  /** Mean anomaly at epoch t0 (elliptic) or hyperbolic mean anomaly. */
  M0: number;
  t0: number;
  /** Mean motion (rad/s). */
  n: number;
}

export function solveKeplerE(M: number, e: number): number {
  M = M % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  else if (M < -Math.PI) M += 2 * Math.PI;
  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let k = 0; k < 50; k++) {
    const f = E - e * Math.sin(E) - M;
    const d = 1 - e * Math.cos(E);
    const dE = f / d;
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

export function solveKeplerH(M: number, e: number): number {
  let H = Math.asinh(M / e);
  for (let k = 0; k < 60; k++) {
    const f = e * Math.sinh(H) - H - M;
    const d = e * Math.cosh(H) - 1;
    const dH = f / d;
    H -= dH;
    if (Math.abs(dH) < 1e-12) break;
  }
  return H;
}

/** Build an orbit from relative state (r, v) at time t. */
export function orbitFromState(r: V3, v: V3, mu: number, t: number): Orbit {
  const rl = r.len();
  const v2 = v.len2();
  const h = r.cross(v);
  const hl = h.len();
  const W = hl > 0 ? V3.scaled(h, 1 / hl) : V3.perpendicular(r.clone().normalize());
  const rv = r.dot(v);
  const ev = V3.scaled(r, (v2 - mu / rl) / mu).addScaled(v, -rv / mu);
  let e = ev.len();
  const energy = v2 / 2 - mu / rl;
  let a = -mu / (2 * energy);
  let P: V3;
  if (e > 1e-9) P = V3.scaled(ev, 1 / e);
  else {
    e = 0;
    P = V3.scaled(r, 1 / rl);
  }
  const Q = W.cross(P).normalize();
  const cosNu = r.dot(P) / rl;
  const sinNu = r.dot(Q) / rl;
  let M0: number;
  let n: number;
  if (e < 1) {
    const E = Math.atan2(Math.sqrt(1 - e * e) * sinNu, e + cosNu);
    M0 = E - e * Math.sin(E);
    n = Math.sqrt(mu / (a * a * a));
  } else {
    if (Math.abs(e - 1) < 1e-6) e = 1 + 1e-6;
    a = Math.min(a, -1); // guard parabolic
    const nu = Math.atan2(sinNu, cosNu);
    const H = 2 * Math.atanh(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2));
    M0 = e * Math.sinh(H) - H;
    n = Math.sqrt(mu / -(a * a * a));
  }
  return { mu, a, e, P, Q, W, M0, t0: t, n };
}

/** Position & velocity relative to the focus at time t. */
export function orbitState(o: Orbit, t: number, outR: V3, outV: V3): void {
  const M = o.M0 + o.n * (t - o.t0);
  if (o.e < 1) {
    const E = solveKeplerE(M, o.e);
    const cE = Math.cos(E);
    const sE = Math.sin(E);
    const b = Math.sqrt(1 - o.e * o.e);
    const x = o.a * (cE - o.e);
    const y = o.a * b * sE;
    const rr = o.a * (1 - o.e * cE);
    const k = Math.sqrt(o.mu * o.a) / rr;
    const vx = -k * sE;
    const vy = k * b * cE;
    outR.set(o.P.x * x + o.Q.x * y, o.P.y * x + o.Q.y * y, o.P.z * x + o.Q.z * y);
    outV.set(o.P.x * vx + o.Q.x * vy, o.P.y * vx + o.Q.y * vy, o.P.z * vx + o.Q.z * vy);
  } else {
    const H = solveKeplerH(M, o.e);
    const A = -o.a;
    const ch = Math.cosh(H);
    const sh = Math.sinh(H);
    const s = Math.sqrt(o.e * o.e - 1);
    const x = A * (o.e - ch);
    const y = A * s * sh;
    const dH = o.n / (o.e * ch - 1);
    const vx = -A * sh * dH;
    const vy = A * s * ch * dH;
    outR.set(o.P.x * x + o.Q.x * y, o.P.y * x + o.Q.y * y, o.P.z * x + o.Q.z * y);
    outV.set(o.P.x * vx + o.Q.x * vy, o.P.y * vx + o.Q.y * vy, o.P.z * vx + o.Q.z * vy);
  }
}

export function orbitPeriod(o: Orbit): number {
  return o.e < 1 ? (2 * Math.PI) / o.n : Infinity;
}

export function periapsis(o: Orbit): number {
  return o.e < 1 ? o.a * (1 - o.e) : -o.a * (o.e - 1);
}

export function apoapsis(o: Orbit): number {
  return o.e < 1 ? o.a * (1 + o.e) : Infinity;
}

/** Inclination (rad) relative to the reference plane normal (default +z). */
export function inclination(o: Orbit, ref = new V3(0, 0, 1)): number {
  return Math.acos(Math.max(-1, Math.min(1, o.W.dot(ref))));
}

/** Sample points along the orbit (relative positions) for drawing. */
export function orbitPoints(o: Orbit, n: number, maxR = Infinity): V3[] {
  const pts: V3[] = [];
  if (o.e < 1) {
    const b = Math.sqrt(1 - o.e * o.e);
    for (let k = 0; k <= n; k++) {
      const E = (k / n) * 2 * Math.PI;
      const x = o.a * (Math.cos(E) - o.e);
      const y = o.a * b * Math.sin(E);
      pts.push(new V3(o.P.x * x + o.Q.x * y, o.P.y * x + o.Q.y * y, o.P.z * x + o.Q.z * y));
    }
  } else {
    const A = -o.a;
    const s = Math.sqrt(o.e * o.e - 1);
    const rMax = Math.min(maxR, 1e3 * A);
    const Hmax = Math.acosh(Math.max(1.0001, (rMax / A + 1) / o.e));
    for (let k = 0; k <= n; k++) {
      const H = -Hmax + (2 * Hmax * k) / n;
      const x = A * (o.e - Math.cosh(H));
      const y = A * s * Math.sinh(H);
      pts.push(new V3(o.P.x * x + o.Q.x * y, o.P.y * x + o.Q.y * y, o.P.z * x + o.Q.z * y));
    }
  }
  return pts;
}

export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

export function hillRadius(a: number, e: number, m: number, M: number): number {
  return a * (1 - e) * Math.cbrt(m / (3 * M));
}

/** Fluid Roche limit for a satellite of density rhoS around a primary of radius Rp, density rhoP. */
export function rocheLimit(Rp: number, rhoP: number, rhoS: number): number {
  return 2.44 * Rp * Math.cbrt(rhoP / rhoS);
}

/** Build an orbit from classical elements (angles in radians) around mu at time t. */
export function orbitFromElements(
  mu: number,
  a: number,
  e: number,
  i: number,
  raan: number,
  argp: number,
  meanAnomaly: number,
  t: number,
  refFrame?: { x: V3; y: V3; z: V3 },
): Orbit {
  const cO = Math.cos(raan),
    sO = Math.sin(raan),
    ci = Math.cos(i),
    si = Math.sin(i),
    cw = Math.cos(argp),
    sw = Math.sin(argp);
  let P = new V3(cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si);
  let Q = new V3(-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si);
  let W = new V3(sO * si, -cO * si, ci);
  if (refFrame) {
    const tr = (v: V3) =>
      new V3(
        refFrame.x.x * v.x + refFrame.y.x * v.y + refFrame.z.x * v.z,
        refFrame.x.y * v.x + refFrame.y.y * v.y + refFrame.z.y * v.z,
        refFrame.x.z * v.x + refFrame.y.z * v.y + refFrame.z.z * v.z,
      );
    P = tr(P);
    Q = tr(Q);
    W = tr(W);
  }
  const n = Math.sqrt(mu / Math.abs(a * a * a));
  return { mu, a, e, P, Q, W, M0: meanAnomaly, t0: t, n };
}

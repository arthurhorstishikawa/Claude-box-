import { G } from '../core/constants';
import { V3 } from '../core/vec3';
import type { Body } from './body';
import { hillRadius, orbitFromState, orbitState, periapsis, type Orbit } from './orbits';

/**
 * Direct-summation N-body integrator: kick–drift–kick leapfrog with an adaptive global step.
 * State is packed into typed arrays for speed and copied back to Body objects after a frame.
 */
export class NBody {
  n = 0;
  pos = new Float64Array(0);
  vel = new Float64Array(0);
  acc = new Float64Array(0);
  mass = new Float64Array(0);
  rad = new Float64Array(0);
  /** Accuracy parameter: fraction of the local dynamical time per step. */
  eta = 0.015;
  minDyn = Infinity;
  minCross = Infinity;
  collision: [number, number] | null = null;
  private accValid = false;

  load(bodies: Body[]): void {
    const n = bodies.length;
    if (this.pos.length !== 3 * n) {
      this.pos = new Float64Array(3 * n);
      this.vel = new Float64Array(3 * n);
      this.acc = new Float64Array(3 * n);
      this.mass = new Float64Array(n);
      this.rad = new Float64Array(n);
    }
    this.n = n;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      this.pos[3 * i] = b.pos.x;
      this.pos[3 * i + 1] = b.pos.y;
      this.pos[3 * i + 2] = b.pos.z;
      this.vel[3 * i] = b.vel.x;
      this.vel[3 * i + 1] = b.vel.y;
      this.vel[3 * i + 2] = b.vel.z;
      this.mass[i] = b.mass;
      this.rad[i] = b.radius;
    }
    this.accValid = false;
  }

  store(bodies: Body[]): void {
    for (let i = 0; i < this.n; i++) {
      bodies[i].pos.set(this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]);
      bodies[i].vel.set(this.vel[3 * i], this.vel[3 * i + 1], this.vel[3 * i + 2]);
    }
  }

  computeAcc(): void {
    const { n, pos, vel, acc, mass, rad } = this;
    acc.fill(0);
    let minDyn = Infinity;
    let minCross = Infinity;
    this.collision = null;
    for (let i = 0; i < n; i++) {
      const xi = pos[3 * i],
        yi = pos[3 * i + 1],
        zi = pos[3 * i + 2];
      const mi = mass[i];
      for (let j = i + 1; j < n; j++) {
        const dx = pos[3 * j] - xi;
        const dy = pos[3 * j + 1] - yi;
        const dz = pos[3 * j + 2] - zi;
        let r2 = dx * dx + dy * dy + dz * dz;
        const rs = rad[i] + rad[j];
        if (r2 < rs * rs && !this.collision) this.collision = [i, j];
        const floor = 1e-4 * rs * rs + 1;
        if (r2 < floor) r2 = floor;
        const r = Math.sqrt(r2);
        const inv3 = 1 / (r2 * r);
        const mj = mass[j];
        const fi = G * mj * inv3;
        const fj = G * mi * inv3;
        acc[3 * i] += dx * fi;
        acc[3 * i + 1] += dy * fi;
        acc[3 * i + 2] += dz * fi;
        acc[3 * j] -= dx * fj;
        acc[3 * j + 1] -= dy * fj;
        acc[3 * j + 2] -= dz * fj;
        const mu = G * (mi + mj);
        if (mu > 0) {
          const td = Math.sqrt((r2 * r) / mu);
          if (td < minDyn) minDyn = td;
        }
        // Approach time to contact for converging pairs.
        const dvx = vel[3 * j] - vel[3 * i];
        const dvy = vel[3 * j + 1] - vel[3 * i + 1];
        const dvz = vel[3 * j + 2] - vel[3 * i + 2];
        const rv = dx * dvx + dy * dvy + dz * dvz;
        if (rv < 0) {
          const v = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
          const tc = Math.max(r - rs, 0.05 * rs) / v;
          if (tc < minCross) minCross = tc;
        }
      }
    }
    this.minDyn = minDyn;
    this.minCross = minCross;
    this.accValid = true;
  }

  suggestedStep(): number {
    if (!this.accValid) this.computeAcc();
    return Math.min(this.eta * this.minDyn, 0.25 * this.minCross);
  }

  /** Advance up to dt with at most maxSteps substeps; stops at the first collision. */
  integrate(dt: number, maxSteps: number): { advanced: number; steps: number; collision: [number, number] | null } {
    const { n, pos, vel, acc } = this;
    if (n === 0) return { advanced: dt, steps: 0, collision: null };
    if (!this.accValid) this.computeAcc();
    if (this.collision) return { advanced: 0, steps: 0, collision: this.collision };
    let t = 0;
    let steps = 0;
    const N3 = 3 * n;
    while (t < dt && steps < maxSteps) {
      let h = this.suggestedStep();
      if (!(h > 0) || !Number.isFinite(h)) h = dt - t;
      if (t + h > dt) h = dt - t;
      const hh = 0.5 * h;
      for (let k = 0; k < N3; k++) vel[k] += acc[k] * hh;
      for (let k = 0; k < N3; k++) pos[k] += vel[k] * h;
      this.computeAcc();
      for (let k = 0; k < N3; k++) vel[k] += acc[k] * hh;
      t += h;
      steps++;
      if (this.collision) return { advanced: t, steps, collision: this.collision };
    }
    return { advanced: t, steps, collision: null };
  }

  invalidate(): void {
    this.accValid = false;
  }
}

interface KeplerEntry {
  body: Body;
  primary: Body | null;
  center: Body[];
  orbit: Orbit | null;
  hill: number;
}

/**
 * Hierarchical analytic propagation for extreme time warps. Each body rides a Kepler orbit
 * around the barycentre of its primary (plus more massive inner companions, e.g. a binary).
 */
export class KeplerSystem {
  entries: KeplerEntry[] = [];
  private t0 = 0;
  private X0 = new V3();
  private V0 = new V3();
  private M = 0;
  private lastT = 0;

  build(bodies: Body[], t: number): void {
    const sorted = bodies.slice().sort((a, b) => b.mass - a.mass);
    const info = new Map<number, KeplerEntry & { children: Body[] }>();
    this.entries = [];
    for (const b of sorted) {
      let best: (KeplerEntry & { children: Body[] }) | null = null;
      let bestCenter: Body[] = [];
      for (const e of info.values()) {
        const p = e.body;
        if (p.mass < b.mass) continue;
        const r = b.pos.distTo(p.pos);
        if (r > e.hill) continue;
        const center = [p, ...e.children.filter((c) => {
          const ce = info.get(c.id);
          return ce?.orbit && ce.orbit.e < 1 && ce.orbit.a < 0.45 * r;
        })];
        const { pos: cp, vel: cv, mass: cm } = barycenter(center);
        const mu = G * (cm + b.mass);
        const rr = V3.sub(b.pos, cp);
        const vv = V3.sub(b.vel, cv);
        const energy = 0.5 * vv.len2() - mu / rr.len();
        if (energy >= 0) continue;
        if (!best || e.hill < best.hill) {
          best = e;
          bestCenter = center;
        }
      }
      let entry: KeplerEntry & { children: Body[] };
      if (!best) {
        entry = { body: b, primary: null, center: [], orbit: null, hill: Infinity, children: [] };
      } else {
        const { pos: cp, vel: cv, mass: cm } = barycenter(bestCenter);
        const orbit = orbitFromState(V3.sub(b.pos, cp), V3.sub(b.vel, cv), G * (cm + b.mass), t);
        const hill = orbit.e < 1 ? hillRadius(orbit.a, orbit.e, b.mass, cm) : 0;
        entry = { body: b, primary: best.body, center: bestCenter, orbit, hill, children: [] };
        best.children.push(b);
      }
      info.set(b.id, entry);
      this.entries.push(entry);
    }
    const bc = barycenter(bodies);
    this.X0 = bc.pos;
    this.V0 = bc.vel;
    this.M = bc.mass;
    this.t0 = t;
    this.lastT = t;
  }

  /** Map body id → primary id from the latest build. */
  primaries(): Map<number, number | null> {
    const m = new Map<number, number | null>();
    for (const e of this.entries) m.set(e.body.id, e.primary ? e.primary.id : null);
    return m;
  }

  /** Adiabatic response to slow mass changes (stellar winds): a·M = const. */
  adjustMasses(t: number): void {
    for (const e of this.entries) {
      if (!e.orbit) continue;
      let cm = 0;
      for (const c of e.center) cm += c.mass;
      const mu = G * (cm + e.body.mass);
      const o = e.orbit;
      if (Math.abs(mu / o.mu - 1) < 1e-10) continue;
      const Mnow = o.M0 + o.n * (t - o.t0);
      if (o.e < 1) {
        o.a *= o.mu / mu;
        o.n = Math.sqrt(mu / (o.a * o.a * o.a));
      } else {
        o.n = Math.sqrt(mu / -(o.a * o.a * o.a));
      }
      o.M0 = Mnow;
      o.t0 = t;
      o.mu = mu;
    }
  }

  propagate(t: number): void {
    const dtRoot = t - this.lastT;
    const r = new V3();
    const v = new V3();
    for (const e of this.entries) {
      if (!e.orbit) {
        e.body.pos.addScaled(e.body.vel, dtRoot);
        continue;
      }
      const c = barycenter(e.center);
      orbitState(e.orbit, t, r, v);
      e.body.pos.copy(c.pos).add(r);
      e.body.vel.copy(c.vel).add(v);
    }
    // Keep the system barycentre on its straight line (gives stars their reflex wobble).
    const bodies = this.entries.map((e) => e.body);
    const bc = barycenter(bodies);
    if (bc.mass > 0 && Math.abs(bc.mass / this.M - 1) < 1e-3) {
      const X = this.X0.clone().addScaled(this.V0, t - this.t0);
      const dX = X.sub(bc.pos);
      const dV = this.V0.clone().sub(bc.vel);
      for (const b of bodies) {
        b.pos.add(dX);
        b.vel.add(dV);
      }
    } else {
      this.X0 = bc.pos;
      this.V0 = bc.vel;
      this.M = bc.mass;
      this.t0 = t;
    }
    this.lastT = t;
  }

  /** Bodies whose periapsis dips inside their primary (engulfment / impact). */
  findPlunges(): [Body, Body][] {
    const out: [Body, Body][] = [];
    for (const e of this.entries) {
      if (!e.orbit || !e.primary) continue;
      if (periapsis(e.orbit) < e.primary.radius + e.body.radius) out.push([e.primary, e.body]);
    }
    return out;
  }
}

export function barycenter(bodies: Body[]): { pos: V3; vel: V3; mass: number } {
  let m = 0;
  const p = new V3();
  const v = new V3();
  for (const b of bodies) {
    m += b.mass;
    p.addScaled(b.pos, b.mass);
    v.addScaled(b.vel, b.mass);
  }
  if (m > 0) {
    p.scale(1 / m);
    v.scale(1 / m);
  }
  return { pos: p, vel: v, mass: m };
}

/** Compute display primaries (most local bound attractor) for all bodies. */
export function computePrimaries(bodies: Body[]): Map<number, number | null> {
  const ks = new KeplerSystem();
  ks.build(bodies, 0);
  return ks.primaries();
}

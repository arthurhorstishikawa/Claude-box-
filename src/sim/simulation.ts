import { AU, DAY, G, L_SUN, M_EARTH, M_SUN, R_EARTH, TWO_PI, YEAR } from '../core/constants';
import { Emitter } from '../core/events';
import { clamp, wrap2Pi } from '../core/math';
import { Rng } from '../core/rng';
import { V3 } from '../core/vec3';
import { fmtMass, sig } from '../core/format';
import { Body } from '../physics/body';
import { classifyBody, updateRadius } from '../physics/classify';
import { computePrimaries, KeplerSystem, NBody } from '../physics/gravity';
import { orbitFromState, orbitPeriod, rocheLimit } from '../physics/orbits';
import { M_HBURN } from '../core/constants';
import { PHASE_LABEL, xuvFraction } from '../stars/stellar';
import { GasGiantClimate, giantIntrinsicTemp } from '../climate/gasGiant';
import type { Illuminator } from '../climate/insolation';
import { TerrestrialClimate, type ClimateResolution } from '../climate/terrestrial';
import { craterScaling } from '../climate/terrain';
import { makeRocky, refreshStar } from './factory';
import { CivAgency } from './civilizations';
import type { Scenario } from './scenarios';

export type PhysicsMode = 'nbody' | 'kepler';

export interface SimSettings {
  accuracy: number;
  physics: 'auto' | 'nbody' | 'kepler';
  collisions: boolean;
  storms: boolean;
  geology: boolean;
  civilizations: boolean;
  climateQuality: ClimateResolution;
  climateBudgetMs: number;
}

export type NotifyLevel = 'info' | 'warn' | 'danger' | 'success';

export interface SimEvents extends Record<string, unknown> {
  notify: { msg: string; level: NotifyLevel; bodyId?: number };
  bodyAdded: Body;
  bodyRemoved: Body;
  impact: { target: Body; impactorName: string; energy: number; pos: V3; radius: number; lat: number; lon: number; crater: number };
  merge: { a: Body; b: Body; result: Body; pos: V3; energy: number };
  supernova: { body: Body; pos: V3 };
  disrupted: { body: Body; primary: Body; pos: V3 };
  reset: undefined;
  changed: Body;
  eruption: { body: Body; lat: number; lon: number; vei: number };
  flare: { star: Body; superflare: boolean };
}

export class Simulation {
  bodies: Body[] = [];
  time = 0;
  epochMs: number | null = null;
  speed = DAY;
  paused = false;
  actualSpeed = 0;
  limited = false;
  mode: PhysicsMode = 'nbody';
  focusId: number | null = null;
  scenarioId = 'solar';
  settings: SimSettings = {
    accuracy: 0.015,
    physics: 'auto',
    collisions: true,
    storms: true,
    geology: true,
    civilizations: true,
    climateQuality: 'medium',
    climateBudgetMs: 6,
  };
  events = new Emitter<SimEvents>();
  /** Terraforming projects and interstellar voyages of advanced civilizations. */
  agency = new CivAgency(this);
  private nbody = new NBody();
  private kepler = new KeplerSystem();
  private keplerDirty = true;
  private primaries = new Map<number, number | null>();
  private primClock = 1e9;
  private pending = new Map<number, number>();
  private rr = 0;
  private rng = new Rng(12345);
  private flags = new Map<string, boolean>();
  private speedEMA = 0;

  // ------------------------------------------------------------------ setup

  loadScenario(sc: Scenario): void {
    this.bodies = [];
    this.pending.clear();
    this.flags.clear();
    this.time = 0;
    this.agency.reset();
    this.epochMs = sc.epochMs;
    this.speed = sc.speed;
    this.scenarioId = sc.id;
    this.mode = 'nbody';
    for (const b of sc.build()) this.bodies.push(b);
    this.recenter();
    this.primClock = 1e9;
    this.refreshPrimaries();
    const focus = this.bodies.find((b) => b.name === sc.focus) ?? this.bodies[0];
    this.focusId = focus?.id ?? null;
    for (const b of this.bodies) this.initBody(b);
    sc.afterLoad?.(this);
    this.keplerDirty = true;
    this.events.emit('reset', undefined);
  }

  /** Put the system barycentre at rest at the origin. */
  recenter(): void {
    let m = 0;
    const p = new V3();
    const v = new V3();
    for (const b of this.bodies) {
      m += b.mass;
      p.addScaled(b.pos, b.mass);
      v.addScaled(b.vel, b.mass);
    }
    if (m <= 0) return;
    p.scale(1 / m);
    v.scale(1 / m);
    for (const b of this.bodies) {
      b.pos.sub(p);
      b.vel.sub(v);
    }
  }

  /** Create climate models and settle them into equilibrium. */
  initBody(b: Body): void {
    b.kind = classifyBody(b);
    if (b.star) refreshStar(b, 0);
    else updateRadius(b);
    if (b.isRocky && b.world && b.kind !== 'smallBody') {
      const res: ClimateResolution = b.id === this.focusId ? this.settings.climateQuality : 'low';
      const c = new TerrestrialClimate(b.world, b.radius, b.surfaceGravity(), res);
      c.onEvent = (msg, kind) => this.notify(`${b.name}: ${msg}`, kind === 'danger' ? 'danger' : kind === 'warn' ? 'warn' : 'info', b.id);
      b.climate = c;
      if ((b as any).civStart && this.settings.civilizations) c.seedCivilization((b as any).civStart);
      this.spinUp(b);
    } else if (b.isGiant) {
      const spec = b.giant ?? { palette: 'auto' as const, seed: b.id * 31 };
      b.giant = spec;
      const g = new GasGiantClimate(spec.palette, spec.seed, b.kind === 'iceGiant', spec.vortices);
      g.onEvent = (msg, kind) => this.notify(`${b.name}: ${msg}`, kind === 'danger' ? 'danger' : 'info', b.id);
      b.climate = g;
      this.spinUp(b);
    }
    this.pending.set(b.id, 0);
  }

  private spinUp(b: Body): void {
    const c = b.climate;
    if (!c) return;
    // Transients while the climate settles are not news: mute its event messages.
    const say = c.onEvent;
    c.onEvent = null;
    try {
      this.spinUpSteps(b, c);
    } finally {
      c.onEvent = say;
    }
  }

  private spinUpSteps(b: Body, c: TerrestrialClimate | GasGiantClimate): void {
    const il = this.illuminators(b);
    const orbitP = il.length && Number.isFinite(il[0].orbitPeriod) ? il[0].orbitPeriod : YEAR;
    if (c instanceof TerrestrialClimate) {
      const ctx = this.climateContext(b, il, 0);
      c.spinningUp = true;
      for (let n = 0; n < 24; n++) c.step(Math.max(orbitP, YEAR) * 2, { ...ctx, realDt: 0 });
      for (let n = 0; n < 4; n++) c.step(Math.min(10 * DAY, orbitP / 12), { ...ctx, realDt: 0 });
      c.spinningUp = false;
      c.history.clear();
    } else if (c instanceof GasGiantClimate) {
      const ctx = this.giantContext(b, il, 0);
      for (let n = 0; n < 6; n++) c.step(5 * YEAR, { ...ctx, realDt: 0 });
      c.history.clear();
    }
  }

  // ------------------------------------------------------------------ accessors

  getBody(id: number | null): Body | null {
    if (id === null) return null;
    return this.bodies.find((b) => b.id === id) ?? null;
  }

  primaryOf(b: Body): Body | null {
    const id = this.primaries.get(b.id);
    return id ? this.getBody(id) : null;
  }

  childrenOf(b: Body): Body[] {
    return this.bodies.filter((c) => this.primaries.get(c.id) === b.id);
  }

  focus(): Body | null {
    return this.getBody(this.focusId);
  }

  setFocus(id: number | null): void {
    if (id === this.focusId) return;
    const old = this.focus();
    this.focusId = id;
    if (old?.climate instanceof TerrestrialClimate) old.climate.setResolution('low');
    const f = this.focus();
    if (f?.climate instanceof TerrestrialClimate) f.climate.setResolution(this.settings.climateQuality);
  }

  notify(msg: string, level: NotifyLevel = 'info', bodyId?: number): void {
    this.events.emit('notify', { msg, level, bodyId });
  }

  private once(key: string, fn: () => void) {
    if (this.flags.get(key)) return;
    this.flags.set(key, true);
    fn();
  }

  addBody(b: Body): void {
    b.createdAt = this.time;
    this.bodies.push(b);
    this.initBody(b);
    this.keplerDirty = true;
    this.primClock = 1e9;
    this.refreshPrimaries();
    this.events.emit('bodyAdded', b);
  }

  removeBody(b: Body): void {
    const i = this.bodies.indexOf(b);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    b.alive = false;
    this.pending.delete(b.id);
    if (this.focusId === b.id) this.focusId = this.bodies[0]?.id ?? null;
    this.keplerDirty = true;
    this.primClock = 1e9;
    this.events.emit('bodyRemoved', b);
  }

  /** Call after editing a body's mass/composition/orbit from the UI. */
  bodyChanged(b: Body): void {
    const before = b.kind;
    if (b.star && b.star.model === 'track' && b.mass < M_HBURN) {
      b.star.model = 'BD';
    }
    if (!b.star && b.mass >= M_HBURN) {
      b.star = { model: 'track', initialMass: b.mass, age: 0, fL: 1, fR: 1, phase: 'MS', L: 0, R: 1, T: 0, snapshot: null, snTime: null, typeIa: false, activity: 0.5 };
      b.climate = null;
      this.notify(`${b.name} has ignited hydrogen fusion — a new star is born!`, 'success', b.id);
    }
    b.kind = classifyBody(b);
    if (b.star) refreshStar(b, 0);
    else updateRadius(b);
    if (before !== b.kind) {
      if ((b.kind === 'brownDwarf' || b.kind === 'gasGiant' || b.kind === 'iceGiant') && !(b.climate instanceof GasGiantClimate) && !b.star) this.initBody(b);
      if (b.kind === 'brownDwarf' && !b.star) {
        b.star = { model: 'BD', initialMass: b.mass, age: b.age, fL: 1, fR: 1, phase: 'BD', L: 0, R: b.radius, T: 0, snapshot: null, snTime: null, typeIa: false, activity: 0 };
        refreshStar(b, 0);
        this.notify(`${b.name} has crossed 13 Jupiter masses: deuterium fusion makes it a brown dwarf.`, 'info', b.id);
      }
    }
    if (b.climate instanceof TerrestrialClimate) {
      b.climate.onEvent ??= null;
    }
    this.keplerDirty = true;
    this.primClock = 1e9;
    this.events.emit('changed', b);
  }

  // ------------------------------------------------------------------ main loop

  update(realDt: number): void {
    const rdt = Math.min(Math.max(realDt, 0), 0.1);
    this.primClock += rdt;
    if (this.primClock > 0.5) this.refreshPrimaries();
    if (this.paused || this.bodies.length === 0) {
      this.actualSpeed = 0;
      this.stepClimates(0, rdt);
      return;
    }
    const want = this.speed * rdt;
    const done = this.advancePhysics(want);
    this.time += done;
    this.speedEMA += ((rdt > 0 ? done / rdt : 0) - this.speedEMA) * 0.1;
    this.actualSpeed = this.speedEMA;
    this.limited = done < want * 0.98;
    this.updateRotation(done);
    this.updateStars(done);
    this.updateTides(done);
    this.updateFlares(done);
    this.checkRoche();
    for (const b of this.bodies) b.age += done;
    this.stepClimates(done, rdt);
    if (this.settings.civilizations) this.agency.update(done);
  }

  private budgetSteps(): number {
    const n = Math.max(1, this.bodies.length);
    return clamp(Math.floor(5e5 / (n * n)), 150, 20000);
  }

  private advancePhysics(dt: number): number {
    if (dt <= 0) return 0;
    this.nbody.eta = this.settings.accuracy;
    let useKepler = this.settings.physics === 'kepler';
    if (this.settings.physics === 'auto') {
      this.nbody.load(this.bodies);
      const h = this.nbody.suggestedStep();
      const need = dt / Math.max(h, 1e-6);
      const budget = this.budgetSteps();
      if (this.mode === 'nbody') useKepler = need > budget * 3;
      else useKepler = need > budget * 1.5;
    }
    if (useKepler) {
      if (this.mode !== 'kepler' || this.keplerDirty) {
        this.kepler.build(this.bodies, this.time);
        this.keplerDirty = false;
        if (this.mode !== 'kepler') this.notify('Extreme time warp: switching to analytic Kepler orbits.', 'info');
      }
      this.mode = 'kepler';
      this.kepler.adjustMasses(this.time + dt);
      this.kepler.propagate(this.time + dt);
      if (this.settings.collisions) {
        for (const [p, b] of this.kepler.findPlunges()) {
          if (p.alive && b.alive) this.handleCollision(p, b);
        }
        this.checkOverlaps();
      }
      return dt;
    }
    if (this.mode === 'kepler') this.notify('Returning to full N-body gravity.', 'info');
    this.mode = 'nbody';
    let done = 0;
    let budget = this.budgetSteps();
    let guard = 0;
    while (done < dt && budget > 0 && guard++ < 20) {
      this.nbody.load(this.bodies);
      const res = this.nbody.integrate(dt - done, budget);
      this.nbody.store(this.bodies);
      done += res.advanced;
      budget -= res.steps;
      if (res.collision && this.settings.collisions) {
        const [i, j] = res.collision;
        this.handleCollision(this.bodies[i], this.bodies[j]);
      } else if (res.collision) {
        break;
      }
      if (res.steps === 0 && !res.collision) break;
    }
    return done;
  }

  private checkOverlaps(): void {
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i],
          b = bs[j];
        if (!a.alive || !b.alive) continue;
        if (a.pos.distTo(b.pos) < a.radius + b.radius) this.handleCollision(a, b);
      }
  }

  // ------------------------------------------------------------------ hierarchy, rotation, tides

  refreshPrimaries(): void {
    this.primClock = 0;
    this.primaries = computePrimaries(this.bodies);
    for (const b of this.bodies) b.primaryId = this.primaries.get(b.id) ?? null;
  }

  private updateRotation(dt: number): void {
    for (const b of this.bodies) {
      const p = this.primaryOf(b);
      if (b.tidallyLocked && p) {
        const d = V3.sub(p.pos, b.pos).normalize();
        const z = b.spinAxis;
        const x = d.clone().addScaled(z, -d.dot(z));
        if (x.len() > 1e-6) {
          x.normalize();
          const ref = b.primeRef;
          const ang = Math.atan2(z.dot(ref.cross(x)), ref.dot(x));
          b.rotationAngle = wrap2Pi(ang);
          const o = orbitFromState(V3.sub(b.pos, p.pos), V3.sub(b.vel, p.vel), G * (p.mass + b.mass), 0);
          const P = orbitPeriod(o);
          if (Number.isFinite(P)) b.rotationPeriod = P * Math.sign(o.W.dot(z) || 1);
        }
        continue;
      }
      const P = b.rotationPeriod;
      // At extreme warp a planet would spin thousands of times per frame and appear to flicker
      // at random; its climate already uses day-averaged sunlight there, so turn it at most a
      // little per step instead.
      if (Number.isFinite(P) && P !== 0) b.rotationAngle = wrap2Pi(b.rotationAngle + TWO_PI * Math.sign(P) * Math.min(Math.abs(dt / P), dt > 30 * DAY ? 0.01 : Infinity));
    }
  }

  private tideClock = 0;
  private updateTides(dt: number): void {
    this.tideClock += dt;
    for (const b of this.bodies) {
      b.impactHeat *= Math.exp(-dt / (1e6 * YEAR));
      if (b.isStarLike) continue;
      const p = this.primaryOf(b);
      if (!p) {
        b.tidalHeat = 0;
        continue;
      }
      const rel = V3.sub(b.pos, p.pos);
      const relV = V3.sub(b.vel, p.vel);
      const o = orbitFromState(rel, relV, G * (p.mass + b.mass), 0);
      if (!(o.e < 1)) {
        b.tidalHeat = 0;
        continue;
      }
      const P = orbitPeriod(o);
      this.precess(b, p, o.W, dt);
      const k = 1 - Math.exp(-dt / Math.max(10 * P, 1));
      b.eccSmoothed += (o.e - b.eccSmoothed) * k;
      const e = Math.max(b.forcedEcc, b.eccSmoothed);
      const n = (2 * Math.PI) / P;
      const k2Q = b.isGiant ? 1e-5 : b.composition.ice > 0.3 ? 0.0015 : 0.0075;
      const a = o.a;
      const power = 10.5 * k2Q * ((G * p.mass * p.mass * Math.pow(b.radius, 5) * n * e * e) / Math.pow(a, 6));
      b.tidalHeat = Math.min(1e4, power / (4 * Math.PI * b.radius * b.radius));
      this.tidalMigration(b, p, a, o.e, n, o.W, dt);
      // Tidal locking progress.
      if (!b.tidallyLocked && b.rotationPeriod !== 0) {
        const w = Math.abs(TWO_PI / b.rotationPeriod);
        const Q = b.isGiant ? 1e4 : 100;
        const k2 = b.isGiant ? 0.4 : 0.3;
        const I = 0.33 * b.mass * b.radius * b.radius;
        const tLock = (w * Math.pow(a, 6) * I * Q) / (3 * G * p.mass * p.mass * k2 * Math.pow(b.radius, 5));
        b.lockProgress += dt / Math.max(tLock, 1);
        if (b.lockProgress >= 1) {
          b.tidallyLocked = true;
          this.notify(`${b.name} has become tidally locked to ${p.name}.`, 'info', b.id);
        }
      }
    }
  }

  private tideAcc = new Map<number, number>();
  /**
   * Tidal orbital evolution. The tide a satellite raises on its primary is carried ahead of
   * (or behind) it by the primary's spin, so the orbit slowly widens if the primary spins
   * faster than the satellite orbits — the Moon recedes ~2 cm/yr while Earth's day lengthens —
   * and decays if it spins slower (a Phobos spirals in until it is torn into a ring).
   * Angular momentum is exchanged with the primary's spin.
   */
  private tidalMigration(b: Body, p: Body, a: number, e: number, n: number, W: V3, dt: number): void {
    if (dt <= 0 || b.mass > 0.3 * p.mass) return;
    const k2Q = p.star ? 3e-8 : p.isGiant ? 2e-5 : 0.012;
    const spin = Number.isFinite(p.rotationPeriod) && p.rotationPeriod !== 0 ? (TWO_PI / p.rotationPeriod) * p.spinAxis.dot(W) : 0;
    const sign = Math.sign(spin - n);
    if (sign === 0) return;
    const rate = sign * 3 * k2Q * (b.mass / p.mass) * Math.pow(p.radius / a, 5) * n; // (da/dt)/a
    const frac = clamp(rate * dt, -0.02, 0.02);
    const acc = (this.tideAcc.get(b.id) ?? 0) + frac;
    if (Math.abs(acc) < 1e-6) {
      this.tideAcc.set(b.id, acc);
      return;
    }
    this.tideAcc.set(b.id, 0);
    this.rescaleOrbit(b, p, 1 + acc, 1 / Math.sqrt(1 + acc));
    if (this.mode === 'kepler') this.keplerDirty = true;
    // Spin of the primary: orbital angular momentum gained is spin angular momentum lost.
    if (!p.tidallyLocked && !p.star) {
      const dL = 0.5 * acc * b.mass * Math.sqrt(G * p.mass * a * Math.max(1 - e * e, 0.01));
      const I = (p.isGiant ? 0.25 : 0.33) * p.mass * p.radius * p.radius;
      const w0 = TWO_PI / p.rotationPeriod;
      const w1 = w0 - (Math.sign(w0) * dL * Math.sign(p.spinAxis.dot(W) * w0 || 1)) / I;
      if (Math.sign(w1) === Math.sign(w0) && Math.abs(w1) > 1e-9) p.rotationPeriod = TWO_PI / w1;
    }
  }

  /** Scale b's orbit around p (distance × fr, speed × fv), carrying b's own satellites along. */
  private rescaleOrbit(b: Body, p: Body, fr: number, fv: number): void {
    const dr = V3.sub(b.pos, p.pos).scale(fr - 1);
    const dv = V3.sub(b.vel, p.vel).scale(fv - 1);
    for (const m of this.bodies) {
      if (m === b || !this.isUnder(m, b)) continue;
      m.pos.add(dr);
      m.vel.add(dv);
    }
    b.pos.add(dr);
    b.vel.add(dv);
  }

  /**
   * Axial precession: the star (and any moons) pull on the equatorial bulge raised by the
   * body's spin, so the spin axis slowly circles the orbit normal (Earth: ~26 000 years).
   * Over time this shifts which hemisphere has summer at perihelion — one of the
   * Milankovitch cycles that pace ice ages.
   */
  private precess(b: Body, primary: Body, normal: V3, dt: number): void {
    const P = b.rotationPeriod;
    if (b.tidallyLocked || !Number.isFinite(P) || P === 0 || b.kind === 'smallBody') {
      b.precessionPeriod = Infinity;
      return;
    }
    const w = (2 * Math.PI) / Math.abs(P);
    const q = (w * w * b.radius ** 3) / (G * b.mass);
    const H = clamp(0.95 * q, 0, 0.1); // dynamical ellipticity from rotational flattening
    let pull = (G * primary.mass) / primary.pos.distTo(b.pos) ** 3;
    for (const m of this.bodies) if (m !== b && m.primaryId === b.id && !m.isStarLike) pull += (G * m.mass) / Math.max(m.pos.distTo(b.pos), b.radius) ** 3;
    const cosE = b.spinAxis.dot(normal);
    const rate = (1.5 * H * Math.abs(cosE) * pull) / w;
    if (!(rate > 0)) {
      b.precessionPeriod = Infinity;
      return;
    }
    b.precessionPeriod = (2 * Math.PI) / rate;
    b.setSpinAxis(V3.rotate(b.spinAxis, normal, -rate * dt * Math.sign(cosE || 1)));
  }

  /** Red-dwarf flares: brief brightenings; rare superflares erode close planets' air. */
  private updateFlares(dt: number): void {
    for (const s of this.bodies) {
      if (s.flare > 0) s.flare *= Math.exp(-dt / 600);
      if (!s.star || s.star.phase !== 'MS' || s.star.T > 3900 || dt <= 0) continue;
      // Activity fades over billions of years.
      const act = clamp(Math.pow(Math.max(s.star.age / YEAR, 1e7) / 1e9, -0.6), 0.05, 4);
      const rate = act / (3 * DAY);
      if (dt < 30 * DAY && Math.random() < 1 - Math.exp(-dt * rate)) {
        const superflare = Math.random() < 0.03;
        s.flare = Math.max(s.flare, superflare ? 3 : 0.4 + Math.random());
        this.events.emit('flare', { star: s, superflare });
        if (superflare) this.notify(`${s.name} unleashed a superflare!`, 'warn', s.id);
      }
      // Integrated superflare erosion of close-in atmospheres (applied at any speed).
      const superCount = rate * 0.03 * dt; // superflares during this step
      for (const b of this.bodies) {
        const c = b.climate;
        if (!(c instanceof TerrestrialClimate) || this.primaryOf(b) !== s) continue;
        const d = b.pos.distTo(s.pos) / AU;
        const hz = Math.sqrt(s.star.L / L_SUN);
        // ~2e-10 of the air per superflare at the habitable-zone distance, ∝ 1/(d²·g): a few
        // tenths of an atmosphere per Gyr for an Earth around an active M dwarf.
        const frac = superCount * 2e-10 * (hz / Math.max(d, 1e-4)) ** 2 * (9.81 / Math.max(b.surfaceGravity(), 0.5));
        if (frac > 0) c.stripAtmosphere(Math.min(0.5, frac));
      }
    }
  }

  private checkRoche(): void {
    if (!this.settings.collisions) return;
    for (const s of this.bodies) {
      if (!s.alive || !(s.kind === 'terrestrial' || s.kind === 'smallBody')) continue;
      const p = this.primaryOf(s);
      if (!p || p.mass < 10 * s.mass) continue;
      const d = s.pos.distTo(p.pos);
      const lim = rocheLimit(p.radius, p.kind === 'blackHole' ? 1e17 : p.density(), s.density());
      if (d < lim && d > p.radius + s.radius) {
        this.disrupt(s, p);
      }
    }
  }

  private disrupt(s: Body, p: Body): void {
    this.notify(`${s.name} crossed the Roche limit of ${p.name} and was torn apart!`, 'danger', p.id);
    this.events.emit('disrupted', { body: s, primary: p, pos: s.pos.clone() });
    if (!p.isStarLike) {
      const d = s.pos.distTo(p.pos);
      const ring = p.rings ?? { inner: p.radius * 1.2, outer: d, mass: 0, seed: s.id, color: [0.7, 0.68, 0.64] as [number, number, number], opacity: 0.6 };
      ring.inner = Math.min(ring.inner, Math.max(p.radius * 1.15, d * 0.6));
      ring.outer = Math.max(ring.outer, d * 1.1);
      ring.mass += s.mass;
      ring.opacity = clamp(ring.opacity + Math.log10(1 + s.mass / 1e18) * 0.08, 0.3, 1);
      p.rings = ring;
    }
    p.mass += s.mass * 0.2;
    this.removeBody(s);
  }

  // ------------------------------------------------------------------ stars

  private updateStars(dt: number): void {
    for (const b of this.bodies.slice()) {
      const s = b.star;
      if (!s) continue;
      const prevPhase = s.phase;
      const prevMass = b.mass;
      refreshStar(b, dt);
      // Stellar winds and planetary-nebula ejection take far longer than an orbit, so orbits
      // widen adiabatically (a ∝ 1/M, eccentricity kept) — even when one frame of extreme
      // time warp covers the whole loss. Supernovae are handled as impulsive below.
      if (s.phase !== 'SN' && b.mass < prevMass * (1 - 1e-6)) this.adiabaticMassLoss(b, prevMass);
      if (s.phase !== prevPhase) {
        const label = PHASE_LABEL[s.phase];
        const lvl: NotifyLevel = s.phase === 'SN' ? 'danger' : 'warn';
        if (s.phase === 'SN') this.supernova(b, prevMass);
        else this.notify(`${b.name} is now a ${label.toLowerCase()}.`, lvl, b.id);
      }
      // White dwarfs pushed over the Chandrasekhar limit explode as type Ia supernovae.
      if (s.model === 'WD' && b.mass > 1.38 * M_SUN) this.typeIa(b);
      if (s.model === 'NS' && b.mass > 2.3 * M_SUN) {
        s.model = 'BH';
        refreshStar(b, 0);
        this.notify(`${b.name} collapsed into a black hole.`, 'danger', b.id);
      }
    }
  }

  /** Expand the orbits of everything orbiting `star` as if its mass loss were slow. */
  private adiabaticMassLoss(star: Body, before: number): void {
    const f = before / star.mass; // > 1
    // Applied to the state vectors in both gravity modes; analytic orbits are rebuilt from them.
    if (this.mode === 'kepler') this.keplerDirty = true;
    for (const b of this.bodies) if (b !== star && this.primaryOf(b) === star) this.rescaleOrbit(b, star, f, 1 / f);
  }

  private isUnder(m: Body, p: Body): boolean {
    for (let x = this.primaryOf(m), n = 0; x && n < 8; x = this.primaryOf(x), n++) if (x === p) return true;
    return false;
  }

  private supernova(b: Body, massBefore: number): void {
    const s = b.star!;
    s.snTime = this.time;
    this.notify(`💥 ${b.name} exploded as a core-collapse supernova! Ejecta: ${fmtMass(massBefore - b.mass)}.`, 'danger', b.id);
    this.events.emit('supernova', { body: b, pos: b.pos.clone() });
    this.keplerDirty = true;
    this.blast(b, 1e44, massBefore - b.mass);
  }

  private typeIa(b: Body): void {
    this.notify(`💥 ${b.name} exceeded the Chandrasekhar limit and detonated as a type Ia supernova!`, 'danger', b.id);
    this.events.emit('supernova', { body: b, pos: b.pos.clone() });
    this.blast(b, 1.3e44, b.mass);
    this.removeBody(b);
  }

  /** Supernova ejecta: strip atmospheres, deposit heat, vaporise close planets. */
  private blast(src: Body, energy: number, ejecta: number): void {
    const vEj = Math.sqrt((2 * energy) / Math.max(ejecta, 1e29));
    for (const p of this.bodies.slice()) {
      if (p === src || p.isStarLike) continue;
      const d = Math.max(p.pos.distTo(src.pos), p.radius * 2);
      const frac = (p.radius * p.radius) / (4 * d * d);
      const eAbs = energy * frac;
      const binding = (0.6 * G * p.mass * p.mass) / p.radius;
      if (eAbs > 0.5 * binding) {
        this.notify(`${p.name} was vaporised by the supernova blast.`, 'danger', p.id);
        this.events.emit('disrupted', { body: p, primary: src, pos: p.pos.clone() });
        this.removeBody(p);
        continue;
      }
      const c = p.climate;
      if (c instanceof TerrestrialClimate) {
        const atm = (c.P * 4 * Math.PI * p.radius * p.radius) / p.surfaceGravity();
        const momentum = ejecta * frac * vEj;
        const strip = atm > 0 ? clamp(momentum / (atm * p.escapeVelocity()), 0, 1) : 0;
        if (strip > 0.01) {
          c.stripAtmosphere(strip);
          this.notify(`${p.name} lost ${(strip * 100).toFixed(0)}% of its atmosphere to the supernova shock.`, 'danger', p.id);
        }
        c.heatPulse((eAbs / (Math.PI * p.radius * p.radius)) * 0.02);
      }
    }
  }

  // ------------------------------------------------------------------ collisions

  handleCollision(a: Body, b: Body): void {
    if (!a.alive || !b.alive) return;
    const big = a.mass >= b.mass ? a : b;
    const small = big === a ? b : a;
    const relV = V3.sub(small.vel, big.vel);
    const v = Math.max(relV.len(), small.escapeVelocity() > 0 ? Math.sqrt(2 * G * big.mass / (big.radius + small.radius)) : 0);
    const mu = (big.mass * small.mass) / (big.mass + small.mass);
    const energy = 0.5 * mu * v * v;
    const dir = V3.sub(small.pos, big.pos).normalize();
    const hitPos = big.pos.clone().addScaled(dir, big.radius);
    // Momentum-conserving merge.
    const m = big.mass + small.mass;
    const vel = big.vel.clone().scale(big.mass).addScaled(small.vel, small.mass).scale(1 / m);
    const pos = big.pos.clone().scale(big.mass).addScaled(small.pos, small.mass).scale(1 / m);
    if (big.isStarLike) {
      this.notify(`${small.name} plunged into ${big.name}.`, small.mass > 1e-3 * big.mass ? 'warn' : 'info', big.id);
      big.mass = m;
      if (big.star) {
        if (big.star.model === 'track') big.star.initialMass += small.mass;
        refreshStar(big, 0);
      }
      big.pos.copy(pos);
      big.vel.copy(vel);
      this.events.emit('merge', { a: big, b: small, result: big, pos: hitPos, energy });
      this.removeBody(small);
      this.bodyChanged(big);
      return;
    }
    // Where on the target did it hit (body-fixed lat/lon)?
    const local = big.toBody(dir);
    const lat = Math.asin(clamp(local.z, -1, 1));
    const lon = Math.atan2(local.y, local.x);
    const ratio = small.mass / big.mass;
    let craterD = 0;
    const tc = big.climate;
    if (tc instanceof TerrestrialClimate) {
      let crater: { diameter: number; depth: number } | null = null;
      if (ratio < 0.02) {
        const cs = craterScaling(2 * small.radius, v, small.density(), Math.min(big.density(), 3000), big.surfaceGravity(), Math.PI / 4);
        crater = { diameter: Math.min(cs.diameter, Math.PI * big.radius), depth: cs.depth };
        craterD = crater.diameter;
      }
      const water = small.composition.ice * small.mass * 0.8;
      tc.impact({ lat, lon, energy, crater, water, time: this.time, targetMass: big.mass, vesc: big.escapeVelocity() });
    }
    const mt = (energy / 4.184e15).toExponential(1);
    if (ratio < 0.02) {
      this.notify(
        `Impact on ${big.name}: ${small.name} (${sig((2 * small.radius) / 1e3, 3)} km) at ${sig(v / 1e3, 3)} km/s released ${mt} Mt` +
          (craterD > 0 ? ` and carved a ${sig(craterD / 1e3, 3)} km crater.` : '.'),
        energy > 1e22 ? 'danger' : 'warn',
        big.id,
      );
    } else {
      this.notify(`Giant impact! ${small.name} and ${big.name} merged (${mt} Mt).`, 'danger', big.id);
      // Giant impacts reorient the spin.
      const tilt = this.rng.range(-1, 1) * Math.min(1, ratio * 3) * 1.2;
      big.setSpinAxis(V3.rotate(big.spinAxis, V3.perpendicular(big.spinAxis), tilt));
      big.rotationPeriod = Math.max(2 * 3600, Math.abs(big.rotationPeriod) * this.rng.range(0.3, 1.2)) * Math.sign(big.rotationPeriod || 1);
      big.tidallyLocked = false;
      big.lockProgress = 0;
      big.impactHeat += clamp(energy / (4 * Math.PI * big.radius * big.radius * 3e13), 0, 500);
    }
    this.events.emit('impact', { target: big, impactorName: small.name, energy, pos: hitPos, radius: small.radius, lat, lon, crater: craterD });
    // Merge composition and mass.
    const mix = (k: 'iron' | 'rock' | 'ice' | 'gas') => (big.composition[k] * big.mass + small.composition[k] * small.mass) / m;
    big.composition = { iron: mix('iron'), rock: mix('rock'), ice: mix('ice'), gas: mix('gas') };
    if (big.radiusAnchor) big.radiusAnchor = { ...big.radiusAnchor };
    big.mass = m;
    big.pos.copy(pos);
    big.vel.copy(vel);
    // An oblique giant impact throws mantle debris into orbit, which gathers into a moon just
    // outside the Roche limit (how Earth's Moon is thought to have formed). The merged planet
    // is left spinning fast in the same sense, so tides then push the new moon outward.
    const Lvec = V3.sub(small.pos, big.pos).cross(relV);
    const oblique = Lvec.len() / Math.max(relV.len() * (big.radius + small.radius), 1);
    const formsMoon = ratio >= 0.02 && !big.isGiant && oblique > 0.25 && m > 1e22 && this.bodies.length < 200;
    this.removeBody(small);
    this.bodyChanged(big);
    if (formsMoon) {
      const mMoon = clamp(0.12 * small.mass * oblique, 1e-4 * m, 0.03 * m);
      const axis = Lvec.clone().normalize();
      big.mass -= mMoon;
      big.setSpinAxis(axis);
      big.rotationPeriod = 5 * 3600;
      this.bodyChanged(big);
      const moon = makeRocky({ name: `${big.name}'s moon`, mass: mMoon, rotationHours: 20, terrain: 'moonlike', seed: Math.floor(this.rng.range(1, 1e9)), initialTemp: 1400, internalHeat: 0.5, tidallyLocked: true, color: '#b8b5ae' });
      const a = 3.2 * big.radius;
      const u = V3.perpendicular(axis);
      moon.pos.copy(big.pos).addScaled(u, a);
      moon.vel.copy(big.vel).addScaled(axis.cross(u).normalize(), Math.sqrt((G * big.mass) / a));
      moon.setSpinAxis(axis);
      this.addBody(moon);
      this.notify(`Debris from the impact has gathered into a moon of ${big.name} (${sig(mMoon / 7.342e22, 2)} lunar masses).`, 'success', moon.id);
    }
  }

  // ------------------------------------------------------------------ light & climate

  /** Fraction of star S's disk visible from P (eclipses by other bodies). */
  private eclipseFactor(P: Body, S: Body, toS: V3, dS: number): number {
    let f = 1;
    const aS = Math.asin(Math.min(1, S.radius / dS));
    for (const O of this.bodies) {
      if (O === P || O === S || O.radius <= 0 || O.kind === 'blackHole') continue;
      const dO = V3.sub(O.pos, P.pos);
      const lO = dO.len();
      if (lO >= dS || lO <= P.radius) continue;
      const cos = dO.dot(toS) / lO;
      if (cos <= 0) continue;
      const aO = Math.asin(Math.min(1, O.radius / lO));
      const th = Math.acos(clamp(cos, -1, 1));
      if (th >= aS + aO) continue;
      let overlap: number;
      if (th <= Math.abs(aO - aS)) overlap = aO >= aS ? 1 : (aO * aO) / (aS * aS);
      else {
        const r1 = aS,
          r2 = aO,
          d = th;
        const p1 = r1 * r1 * Math.acos(clamp((d * d + r1 * r1 - r2 * r2) / (2 * d * r1), -1, 1));
        const p2 = r2 * r2 * Math.acos(clamp((d * d + r2 * r2 - r1 * r1) / (2 * d * r2), -1, 1));
        const p3 = 0.5 * Math.sqrt(Math.max(0, (-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2)));
        overlap = (p1 + p2 - p3) / (Math.PI * r1 * r1);
      }
      f *= 1 - clamp(overlap, 0, 1);
    }
    return f;
  }

  /** Top-level ancestor of P that directly orbits S (P itself if its primary is S). */
  private ancestorBelow(P: Body, S: Body): Body {
    let cur = P;
    for (let k = 0; k < 8; k++) {
      const p = this.primaryOf(cur);
      if (!p || p === S || p.isStarLike) return cur;
      cur = p;
    }
    return cur;
  }

  illuminators(P: Body): Illuminator[] {
    const out: Illuminator[] = [];
    const frame = P.frame();
    for (const S of this.bodies) {
      if (S === P || !S.star || S.star.L <= 0) continue;
      const d = V3.sub(S.pos, P.pos);
      const r = Math.max(d.len(), S.radius + 1);
      const dir = d.clone().scale(1 / r);
      const ecl = this.eclipseFactor(P, S, dir, r);
      const flux = (S.star.L / (4 * Math.PI * r * r)) * P.insolationFactor;
      const A = this.ancestorBelow(P, S);
      const o = orbitFromState(V3.sub(A.pos, S.pos), V3.sub(A.vel, S.vel), G * (S.mass + A.mass), 0);
      const period = orbitPeriod(o);
      const bound = o.e < 1 && Number.isFinite(period);
      const meanFlux = bound ? ((S.star.L / (4 * Math.PI * o.a * o.a * Math.sqrt(1 - o.e * o.e))) * P.insolationFactor) : flux;
      const obl = Math.acos(clamp(P.spinAxis.dot(o.W), -1, 1));
      let synodic: number;
      const lockedToS = P.tidallyLocked && this.primaryOf(P) === S;
      if (lockedToS) synodic = Infinity;
      else {
        const wRot = P.omega();
        const wOrb = bound ? (TWO_PI / period) * Math.sign(o.W.dot(P.spinAxis) || 1) : 0;
        const ws = wRot - wOrb;
        synodic = Math.abs(ws) < 1e-12 ? Infinity : TWO_PI / ws;
      }
      out.push({
        dir: [dir.dot(frame.x), dir.dot(frame.y), dir.dot(frame.z)],
        flux: flux * ecl,
        meanFlux,
        teff: S.star.T,
        synodic,
        orbitPeriod: bound ? period : Infinity,
        obliquity: obl,
        xuvFrac: xuvFraction(S.star.age / YEAR, S.mass / M_SUN, S.star.phase),
      });
    }
    return out;
  }

  climateContext(b: Body, il: Illuminator[], realDt: number) {
    const main = il.reduce((m, x) => (x.meanFlux > (m?.meanFlux ?? -1) ? x : m), il[0] as Illuminator | undefined);
    return {
      illum: il,
      g: b.surfaceGravity(),
      R: b.radius,
      mass: b.mass,
      omega: b.omega(),
      synodicDay: main ? main.synodic : Number.isFinite(b.rotationPeriod) ? b.rotationPeriod : Infinity,
      orbitPeriod: main ? main.orbitPeriod : Infinity,
      internalHeat: b.internalHeat + b.tidalHeat + b.impactHeat,
      geothermal: b.internalHeat,
      time: this.time,
      realDt,
      storms: this.settings.storms,
      geology: this.settings.geology,
      locked: b.tidallyLocked && !!main && !Number.isFinite(main.synodic),
    };
  }

  giantContext(b: Body, il: Illuminator[], realDt: number) {
    const tInt =
      b.kind === 'brownDwarf' && b.star
        ? b.star.T
        : b.giant?.tInt ?? giantIntrinsicTemp(b.mass, b.age / YEAR, b.kind === 'iceGiant');
    return {
      illum: il,
      R: b.radius,
      g: b.surfaceGravity(),
      mass: b.mass,
      omega: b.omega(),
      tInt: Math.max(tInt, Math.pow(Math.max(0, (b.tidalHeat + b.impactHeat) / 5.670374419e-8), 0.25)),
      time: this.time,
      realDt,
      locked: b.tidallyLocked,
    };
  }

  /** Advance climate models within a per-frame CPU budget (focused world first). */
  private stepClimates(dt: number, realDt: number): void {
    const t0 = performance.now();
    const climateBodies = this.bodies.filter((b) => b.climate);
    for (const b of climateBodies) this.pending.set(b.id, (this.pending.get(b.id) ?? 0) + dt);
    if (climateBodies.length === 0) return;
    const focus = this.focus();
    const order: Body[] = [];
    if (focus?.climate) order.push(focus);
    for (let k = 0; k < climateBodies.length; k++) {
      const b = climateBodies[(this.rr + k) % climateBodies.length];
      if (b !== focus) order.push(b);
    }
    this.rr = (this.rr + 1) % climateBodies.length;
    for (const b of order) {
      const isFocus = b === focus;
      const pend = this.pending.get(b.id) ?? 0;
      const minDt = isFocus ? 120 : 2 * 3600;
      if (pend < minDt && !(isFocus && realDt > 0 && dt === 0)) {
        if (!(isFocus && pend > 0 && dt === 0)) continue;
      }
      if (!isFocus && performance.now() - t0 > this.settings.climateBudgetMs) break;
      const il = this.illuminators(b);
      if (pend <= 0) {
        // Paused: still let storms/visual clocks tick for the focused world.
        continue;
      }
      const c = b.climate!;
      if (c instanceof TerrestrialClimate) {
        const ctx = this.climateContext(b, il, isFocus ? realDt : realDt * 4);
        const n = isFocus ? clamp(Math.ceil(pend / 1800), 1, 2) : 1;
        const h = pend / n;
        for (let s = 0; s < n; s++) {
          // Each sub-step sees the star where it was at that time: earlier sub-steps had the
          // sub-stellar point further east. (Using the frame's final geometry for all of them
          // would light the same hemisphere repeatedly at some time speeds.)
          const rem = (n - 1 - s) * h;
          if (rem > 0) {
            const il2 = il.map((x) => {
              if (!Number.isFinite(x.synodic) || x.synodic === 0) return x;
              const a = (TWO_PI * rem) / x.synodic;
              const ca = Math.cos(a),
                sa = Math.sin(a);
              return { ...x, dir: [x.dir[0] * ca - x.dir[1] * sa, x.dir[0] * sa + x.dir[1] * ca, x.dir[2]] as [number, number, number] };
            });
            c.step(h, { ...ctx, illum: il2 });
          } else c.step(h, ctx);
        }
        if (this.settings.civilizations) c.civStep(pend, ctx);
        for (const e of c.eruptions) this.events.emit('eruption', { body: b, ...e });
        c.eruptions.length = 0;
        if (c.civ && this.settings.civilizations) this.agency.act(b, c, pend);
      } else if (c instanceof GasGiantClimate) {
        c.step(pend, this.giantContext(b, il, isFocus ? realDt : realDt * 4));
      }
      this.pending.set(b.id, 0);
      if (performance.now() - t0 > this.settings.climateBudgetMs * 1.5) break;
    }
  }
}

export { L_SUN, M_EARTH, R_EARTH };

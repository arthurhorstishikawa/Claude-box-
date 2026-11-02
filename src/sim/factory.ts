import { AU, DEG, G, L_SUN, M_EARTH, M_SUN, R_SUN, YEAR } from '../core/constants';
import { V3 } from '../core/vec3';
import { Body, type GiantSpec, type WorldSpec } from '../physics/body';
import { classifyBody, defaultComposition, updateRadius } from '../physics/classify';
import { orbitFromElements, orbitState } from '../physics/orbits';
import { blackbodyHex } from '../stars/blackbody';
import { evolveStar, PHASE_LABEL } from '../stars/stellar';
import type { TerrainStyle } from '../climate/terrain';

/** Ecliptic J2000 obliquity, for converting IAU pole RA/Dec to ecliptic coordinates. */
const EPS = 23.4392911 * DEG;

/** Unit vector from equatorial RA/Dec (deg) expressed in the ecliptic frame (x = vernal equinox). */
export function eclipticFromRaDec(raDeg: number, decDeg: number): V3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const x = Math.cos(dec) * Math.cos(ra);
  const y = Math.cos(dec) * Math.sin(ra);
  const z = Math.sin(dec);
  return new V3(x, y * Math.cos(EPS) + z * Math.sin(EPS), -y * Math.sin(EPS) + z * Math.cos(EPS)).normalize();
}

export interface StarOptions {
  name: string;
  /** Initial mass in solar masses. */
  mass: number;
  /** Age in years. */
  age: number;
  /** Observed luminosity / radius (solar) to calibrate the track at this age. */
  L?: number;
  R?: number;
  rotationDays?: number;
  remnant?: 'WD' | 'NS' | 'BH';
  remnantMass?: number;
}

export function makeStar(o: StarOptions): Body {
  const b = new Body(o.name, o.mass * M_SUN, R_SUN);
  if (o.remnant) {
    const m = (o.remnantMass ?? o.mass) * M_SUN;
    b.mass = m;
    b.star = {
      model: o.remnant,
      initialMass: m,
      age: o.age * YEAR,
      fL: 1,
      fR: 1,
      phase: o.remnant,
      L: 0,
      R: 1,
      T: 0,
      snapshot: null,
      snTime: null,
      typeIa: false,
      activity: 0,
    };
  } else if (o.mass < 0.075) {
    b.star = { model: 'BD', initialMass: b.mass, age: o.age * YEAR, fL: 1, fR: 1, phase: 'BD', L: 0, R: 1, T: 0, snapshot: null, snTime: null, typeIa: false, activity: 0 };
  } else {
    const snap = evolveStar(o.mass, o.age);
    b.star = {
      model: 'track',
      initialMass: o.mass * M_SUN,
      age: o.age * YEAR,
      fL: o.L ? o.L / snap.L : 1,
      fR: o.R ? o.R / snap.R : 1,
      phase: snap.phase,
      L: snap.L * L_SUN,
      R: snap.R * R_SUN,
      T: snap.T,
      snapshot: snap,
      snTime: null,
      typeIa: false,
      activity: 0.5,
    };
  }
  b.composition = defaultComposition('star');
  b.rotationPeriod = (o.rotationDays ?? 25) * 86400;
  b.internalHeat = 0;
  refreshStar(b, 0);
  b.description = PHASE_LABEL[b.star!.phase];
  return b;
}

import { blackHoleRadius, brownDwarf, neutronStar, whiteDwarf } from '../stars/stellar';
import { T_SUN } from '../core/constants';

/** Recompute a star's luminosity, radius, temperature and mass from its evolutionary model. */
export function refreshStar(b: Body, dtAge: number): void {
  const s = b.star;
  if (!s) return;
  s.age += dtAge;
  const ageYr = s.age / YEAR;
  let L: number, R: number, T: number;
  switch (s.model) {
    case 'track': {
      const snap = evolveStar(s.initialMass / M_SUN, ageYr);
      s.snapshot = snap;
      s.phase = snap.phase;
      const calib = snap.phase === 'MS' || snap.phase === 'SG' || snap.phase === 'RGB' || snap.phase === 'HB' || snap.phase === 'AGB';
      L = snap.L * (calib ? s.fL : 1);
      R = snap.R * (calib ? s.fR : 1);
      T = R > 0 ? T_SUN * Math.pow(L / (R * R), 0.25) : 0;
      b.mass = snap.m * M_SUN * (s.initialMass > 0 ? 1 : 1);
      break;
    }
    case 'WD': {
      const snap = whiteDwarf(b.mass / M_SUN, ageYr);
      s.phase = 'WD';
      s.snapshot = snap;
      ({ L, R, T } = snap);
      break;
    }
    case 'NS': {
      const snap = neutronStar(b.mass / M_SUN, ageYr);
      s.phase = 'NS';
      s.snapshot = snap;
      ({ L, R, T } = snap);
      break;
    }
    case 'BH':
      s.phase = 'BH';
      L = 0;
      R = blackHoleRadius(b.mass) / R_SUN;
      T = 0;
      break;
    case 'BD':
    default: {
      const snap = brownDwarf(b.mass / M_SUN, ageYr);
      s.phase = 'BD';
      s.snapshot = snap;
      ({ L, R, T } = snap);
      break;
    }
  }
  s.L = L * L_SUN;
  s.R = R * R_SUN;
  s.T = T;
  b.kind = classifyBody(b);
  b.radius = s.R;
  b.color = s.T > 0 ? blackbodyHex(s.T) : '#222';
}

export interface RockyOptions {
  name: string;
  mass: number;
  radius?: number;
  composition?: { iron: number; rock: number; ice: number; gas: number };
  rotationHours: number;
  obliquityDeg?: number;
  atmosphere?: Record<string, number>;
  waterGEL?: number;
  volatile?: 'H2O' | 'CH4';
  biosphere?: boolean;
  terrain: TerrainStyle;
  seed: number;
  haze?: number;
  dust?: number;
  initialTemp?: number;
  iceCapLat?: number;
  internalHeat?: number;
  color?: string;
  tidallyLocked?: boolean;
  forcedEcc?: number;
  civilization?: 'modern' | 'preindustrial' | null;
}

export function makeRocky(o: RockyOptions): Body {
  const b = new Body(o.name, o.mass, o.radius ?? 1);
  b.composition = o.composition ?? defaultComposition('terrestrial');
  b.kind = classifyBody(b);
  if (o.radius) b.radiusAnchor = { mass: o.mass, radius: o.radius };
  updateRadius(b);
  b.rotationPeriod = o.rotationHours * 3600;
  b.internalHeat = o.internalHeat ?? 0.087 * Math.pow(o.mass / M_EARTH, 0.5);
  b.tidallyLocked = !!o.tidallyLocked;
  b.forcedEcc = o.forcedEcc ?? 0;
  const world: WorldSpec = {
    atmosphere: o.atmosphere ?? {},
    waterGEL: o.waterGEL ?? 0,
    volatile: o.volatile ?? 'H2O',
    biosphere: !!o.biosphere,
    terrain: o.terrain,
    terrainSeed: o.seed,
    haze: o.haze,
    dust: o.dust,
    initialTemp: o.initialTemp,
    iceCapLat: o.iceCapLat,
  };
  b.world = world;
  (b as any).civStart = o.civilization ?? null;
  b.color = o.color ?? '#b9a58a';
  b.setSpinAxis(new V3(0, 0, 1));
  return b;
}

export interface GiantOptions {
  name: string;
  mass: number;
  radius?: number;
  rotationHours: number;
  palette?: GiantSpec['palette'];
  seed: number;
  tInt?: number;
  ice?: boolean;
  vortices?: GiantSpec['vortices'];
  rings?: { inner: number; outer: number; color?: [number, number, number]; opacity?: number; mass?: number };
  color?: string;
  tidallyLocked?: boolean;
}

export function makeGiant(o: GiantOptions): Body {
  const b = new Body(o.name, o.mass, o.radius ?? 1);
  b.composition = o.ice ? { iron: 0.05, rock: 0.15, ice: 0.65, gas: 0.15 } : { iron: 0.02, rock: 0.04, ice: 0.04, gas: 0.9 };
  b.kind = classifyBody(b);
  if (o.radius) b.radiusAnchor = { mass: o.mass, radius: o.radius };
  updateRadius(b);
  b.rotationPeriod = o.rotationHours * 3600;
  b.giant = { palette: o.palette ?? 'auto', seed: o.seed, tInt: o.tInt, vortices: o.vortices };
  b.internalHeat = 0;
  b.tidallyLocked = !!o.tidallyLocked;
  if (o.rings)
    b.rings = {
      inner: o.rings.inner,
      outer: o.rings.outer,
      mass: o.rings.mass ?? 1.5e19,
      seed: o.seed,
      color: o.rings.color ?? [0.85, 0.78, 0.66],
      opacity: o.rings.opacity ?? 0.9,
    };
  b.color = o.color ?? (o.ice ? '#8fc3e0' : '#d9b98c');
  return b;
}

export function makeSmallBody(name: string, mass: number, radius: number, icy: boolean, seed: number): Body {
  const b = new Body(name, mass, radius);
  b.composition = icy ? { iron: 0.05, rock: 0.35, ice: 0.6, gas: 0 } : { iron: 0.15, rock: 0.8, ice: 0.05, gas: 0 };
  b.kind = classifyBody(b);
  b.radiusAnchor = { mass, radius };
  b.rotationPeriod = (4 + (seed % 20)) * 3600;
  b.internalHeat = 0;
  b.world = { atmosphere: {}, waterGEL: 0, volatile: 'H2O', biosphere: false, terrain: 'asteroid', terrainSeed: seed };
  b.color = icy ? '#cfe3f0' : '#8d8478';
  return b;
}

/** Orbit frame helpers. */
export function frameFromPole(pole: V3): { x: V3; y: V3; z: V3 } {
  const z = pole.clone().normalize();
  // Node of the equator on the ecliptic (or any perpendicular).
  let x = new V3(0, 0, 1).cross(z);
  if (x.len() < 1e-6) x = new V3(1, 0, 0);
  x.normalize();
  const y = z.cross(x);
  return { x, y, z };
}

/**
 * Place `b` on an orbit around `primary` from classical elements (angles in degrees).
 * `frame` defaults to the ecliptic; pass the primary's equatorial frame for regular moons.
 */
export function placeOnOrbit(
  b: Body,
  primary: Body,
  el: { a: number; e: number; i: number; node: number; peri: number; M: number },
  frame?: { x: V3; y: V3; z: V3 },
): void {
  const mu = G * (primary.mass + b.mass);
  const o = orbitFromElements(mu, el.a, el.e, el.i * DEG, el.node * DEG, el.peri * DEG, el.M * DEG, 0, frame);
  const r = new V3();
  const v = new V3();
  orbitState(o, 0, r, v);
  b.pos.copy(primary.pos).add(r);
  b.vel.copy(primary.vel).add(v);
}

/** Spin axis from obliquity relative to the current orbit normal around `primary`. */
export function setObliquity(b: Body, primary: Body, obliquityDeg: number, azimuthDeg = 90): void {
  const r = V3.sub(b.pos, primary.pos);
  const v = V3.sub(b.vel, primary.vel);
  const n = r.cross(v).normalize();
  if (n.len() < 0.5) {
    b.setSpinAxis(new V3(0, 0, 1));
    return;
  }
  const ref = V3.perpendicular(n);
  const tiltDir = V3.rotate(ref, n, azimuthDeg * DEG);
  const axis = n.clone().scale(Math.cos(obliquityDeg * DEG)).addScaled(tiltDir, Math.sin(obliquityDeg * DEG)).normalize();
  b.setSpinAxis(axis);
}

/** Circular orbit velocity for a body placed at `pos` around `primary` in the plane with normal `normal`. */
export function circularVelocity(pos: V3, primary: Body, mass: number, normal = new V3(0, 0, 1)): V3 {
  const r = V3.sub(pos, primary.pos);
  const d = r.len();
  const speed = Math.sqrt((G * (primary.mass + mass)) / d);
  let t = normal.cross(r);
  if (t.len() < 1e-9) t = V3.perpendicular(r);
  t.normalize().scale(speed);
  return t.add(primary.vel);
}

export const AU_M = AU;

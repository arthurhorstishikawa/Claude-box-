import { AU, G, L_SUN, M_EARTH, M_JUP, M_SUN, R_EARTH, R_SUN } from '../core/constants';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import { Body, resetBodyIds } from '../physics/body';
import { effectiveFlux, frostLine, habitableZone } from '../stars/habitableZone';
import type { TerrainStyle } from '../climate/terrain';
import { TerrestrialClimate } from '../climate/terrestrial';
import { makeGiant, makeRocky, makeSmallBody, makeStar, placeOnOrbit, setObliquity } from './factory';
import type { Scenario } from './scenarios';

/**
 * Procedural planetary systems. Architecture follows what exoplanet surveys and planet
 * formation suggest: closely packed rocky worlds inside the snow line, giants just beyond
 * it (rarer around small stars), ice giants and icy dwarfs farther out, period ratios of
 * ~1.4–2.2 between neighbours. Atmospheres and water follow equilibrium temperature and
 * gravity; habitable-zone worlds get Earth-like air whose CO₂ rises toward the outer edge
 * (as the carbonate–silicate thermostat would arrange).
 */

export type StarPreset = 'random' | 'A' | 'F' | 'G' | 'K' | 'M' | 'ultracool' | 'browndwarf' | 'whitedwarf' | 'binary';

export const STAR_PRESETS: { id: StarPreset; label: string; mass: number; age: number; note: string }[] = [
  { id: 'random', label: 'Surprise me', mass: 0, age: 0, note: 'Any of the types below, weighted by how common they are.' },
  { id: 'G', label: 'Sun-like G star', mass: 1.0, age: 4.6, note: '10 billion years on the main sequence.' },
  { id: 'K', label: 'K dwarf (orange)', mass: 0.75, age: 5, note: 'Long-lived and calm: favourite for habitability.' },
  { id: 'M', label: 'M dwarf (red)', mass: 0.35, age: 5, note: 'The most common stars; habitable worlds are tidally locked.' },
  { id: 'ultracool', label: 'Ultracool dwarf', mass: 0.09, age: 7, note: 'TRAPPIST-1-like: a compact system of small worlds.' },
  { id: 'browndwarf', label: 'Brown dwarf', mass: 0.06, age: 0.4, note: 'Fusion never ignited; it cools, so its habitable zone slides inward over time.' },
  { id: 'F', label: 'F star (yellow-white)', mass: 1.3, age: 2, note: 'Brighter and hotter, with a wider habitable zone farther out.' },
  { id: 'A', label: 'A star (white)', mass: 1.9, age: 0.4, note: 'Short-lived; strong UV.' },
  { id: 'whitedwarf', label: 'White dwarf', mass: 0.6, age: 1, note: 'A stellar remnant with a tiny, shrinking habitable zone.' },
  { id: 'binary', label: 'Close binary (G + K)', mass: 1.0, age: 4, note: 'Circumbinary planets with two suns in the sky.' },
];

export interface SystemOptions {
  seed: number;
  star: StarPreset;
  /** Stellar mass override (M☉); 0 = preset. */
  starMass?: number;
  /** Age override (Gyr); 0 = preset. */
  ageGyr?: number;
  /** Number of planets; 0 = only the star; -1 = automatic. */
  planets: number;
  /** Guarantee a temperate world in the habitable zone. */
  habitable: boolean;
  life: boolean;
  civilization: 'none' | 'preindustrial' | 'modern';
  moons: boolean;
  belt: boolean;
}

export interface GeneratedSystem {
  bodies: Body[];
  focus: string;
  name: string;
  summary: string;
}

const SYLL = ['ka', 've', 'lo', 'ri', 'tha', 'mi', 'zo', 'an', 'el', 'qua', 'dor', 'syl', 'ne', 'ar', 'is', 'ul', 'phe', 'ro', 'ta', 'ny', 'ce', 'ix', 'or', 'ea'];
const HAB_NAMES = ['Halcyon', 'Verdance', 'Aurelia', 'Nerea', 'Solace', 'Tamsin', 'Ilios', 'Cyrene', 'Meridia', 'Thalassa', 'Ember', 'Avalon', 'Kythera', 'Lumen', 'Oriel', 'Brisa'];

function properName(rng: Rng): string {
  const n = rng.int(2, 3);
  let s = '';
  for (let i = 0; i < n; i++) s += rng.pick(SYLL);
  return s[0].toUpperCase() + s.slice(1);
}

function starName(rng: Rng, preset: StarPreset): string {
  if (preset === 'browndwarf') return `WISE J${rng.int(1000, 2359)}${rng.chance(0.5) ? '+' : '−'}${rng.int(10, 89)}`;
  if (preset === 'whitedwarf') return `WD ${rng.int(1000, 2399)}${rng.chance(0.5) ? '+' : '−'}${rng.int(100, 899)}`;
  if (rng.chance(0.45)) return properName(rng);
  return `${rng.pick(['HD', 'GJ', 'Kepler', 'TOI', 'LHS', 'HIP'])}-${rng.int(100, 9999)}`;
}

function pickPreset(rng: Rng): Exclude<StarPreset, 'random'> {
  const r = rng.next();
  if (r < 0.34) return 'M';
  if (r < 0.48) return 'K';
  if (r < 0.62) return 'G';
  if (r < 0.7) return 'F';
  if (r < 0.75) return 'A';
  if (r < 0.83) return 'ultracool';
  if (r < 0.9) return 'browndwarf';
  if (r < 0.94) return 'whitedwarf';
  return 'binary';
}

/** Equilibrium temperature (K) at distance a for luminosity L, zero albedo. */
function teq(L: number, a: number): number {
  return 278.6 * Math.pow(L / L_SUN, 0.25) / Math.sqrt(a / AU);
}

const logRange = (rng: Rng, a: number, b: number) => Math.exp(rng.range(Math.log(a), Math.log(b)));

export function generateSystem(o: SystemOptions): GeneratedSystem {
  resetBodyIds(1);
  const rng = new Rng(o.seed * 2654435761 + 17);
  const preset = o.star === 'random' ? pickPreset(rng) : o.star;
  const p = STAR_PRESETS.find((x) => x.id === preset)!;
  const mass = o.starMass && o.starMass > 0 ? o.starMass : preset === 'G' ? rng.range(0.92, 1.08) : p.mass * rng.range(0.9, 1.1);
  const age = o.ageGyr && o.ageGyr > 0 ? o.ageGyr : p.age * (preset === 'browndwarf' || preset === 'A' ? rng.range(0.7, 1.4) : rng.range(0.6, 1.5));
  const name = starName(rng, preset);
  const bodies: Body[] = [];
  let star: Body;
  let companion: Body | null = null;
  if (preset === 'whitedwarf') star = makeStar({ name, mass, age: age * 1e9, remnant: 'WD' });
  else star = makeStar({ name: preset === 'binary' ? `${name} A` : name, mass, age: age * 1e9, rotationDays: preset === 'browndwarf' ? 0.2 : preset === 'M' || preset === 'ultracool' ? rng.range(2, 60) : rng.range(8, 30) });
  bodies.push(star);
  if (preset === 'binary') {
    companion = makeStar({ name: `${name} B`, mass: mass * rng.range(0.6, 0.8), age: age * 1e9, rotationDays: rng.range(15, 35) });
    placeOnOrbit(companion, star, { a: rng.range(0.08, 0.18) * AU, e: rng.range(0, 0.1), i: 0, node: 0, peri: 0, M: rng.range(0, 360) });
    bodies.push(companion);
  }
  const Ltot = (star.star?.L ?? 0) + (companion?.star?.L ?? 0);
  const Teff = star.star?.T ?? 3000;
  const Mtot = star.mass + (companion?.mass ?? 0);
  const host = star;
  const hz = habitableZone(Math.max(Ltot, 1e-12 * L_SUN), Teff);
  const hzMid = Math.sqrt(hz.inner * hz.outer);
  const snow = frostLine(Math.max(Ltot, 1e-12 * L_SUN));
  const mSun = Mtot / M_SUN;
  // Innermost stable orbit: outside the star (and the binary), past the dust sublimation radius.
  const binA = companion ? companion.pos.distTo(star.pos) : 0;
  const aMin = Math.max(4 * star.radius, 0.03 * AU * Math.sqrt(Ltot / L_SUN), 0.25 * hz.inner, binA * 3.5, 0.004 * AU * Math.cbrt(mSun));
  const aMax = Math.max(aMin * 8, Math.min(45 * AU * Math.sqrt(mSun), Math.max(snow * 25, 0.5 * AU)));
  const small = mSun < 0.15;
  let n = o.planets >= 0 ? o.planets : small ? rng.int(3, 7) : rng.int(4, 9);
  n = clamp(n, 0, 12);

  // --- orbital slots
  const slots: number[] = [];
  if (n > 0) {
    const ratio = () => Math.pow(rng.range(1.35, small ? 1.8 : 2.4), 2 / 3); // period ratio → a ratio
    // Where an Earth-like world would sit for this spectrum (redder light warms more per watt).
    const earthEq = effectiveFlux('runaway', Teff) / effectiveFlux('runaway', 5780);
    const aEarth = Math.sqrt(Ltot / L_SUN / (earthEq * rng.range(0.86, 1.02))) * AU;
    if (o.habitable && aEarth > aMin * 1.05 && aEarth < aMax) {
      const anchor = aEarth;
      let nIn = 0;
      for (let a = anchor / ratio(); a > aMin && nIn < n - 1; a /= ratio()) nIn++;
      nIn = Math.min(nIn, Math.max(0, Math.round((n - 1) * rng.range(0.25, 0.6))));
      let a = anchor;
      const inner: number[] = [];
      for (let k = 0; k < nIn; k++) inner.unshift((a /= ratio()));
      slots.push(...inner, anchor);
      a = anchor;
      while (slots.length < n && a * 1.3 < aMax) slots.push((a *= ratio() * (a > snow ? 1.25 : 1)));
    } else {
      let a = aMin * rng.range(1.1, 2.5);
      while (slots.length < n && a < aMax) {
        slots.push(a);
        a *= ratio() * (a > snow ? 1.3 : 1);
      }
    }
  }

  // --- planets
  let habName: string | null = null;
  const earthFlux = effectiveFlux('runaway', Teff) / effectiveFlux('runaway', 5780);
  let anchorIdx = -1;
  if (o.habitable && slots.length) {
    // The slot closest to Earth-equivalent flux.
    let best = Infinity;
    slots.forEach((a, i) => {
      const S = Ltot / L_SUN / (a / AU) ** 2 / earthFlux;
      const d = Math.abs(Math.log(S));
      if (d < best) {
        best = d;
        anchorIdx = i;
      }
    });
    if (best > 0.5) anchorIdx = -1;
  }
  let giantsMade = 0;
  const letters = 'bcdefghijklmnop';
  const planets: Body[] = [];
  const made: { b: Body; a: number; anchor: boolean }[] = [];
  const bd = mSun < 0.08;
  slots.forEach((a, idx) => {
    const T = teq(Ltot, a);
    const pname = `${name.replace(/ A$/, '')} ${letters[idx]}`;
    const inHZ = a >= hz.inner && a <= hz.outer;
    const isAnchor = o.habitable && idx === anchorIdx;
    const locked = a < 0.3 * AU * Math.cbrt(mSun) * (preset === 'whitedwarf' ? 3 : 1);
    const seed = rng.int(1, 1e9);
    let b: Body;
    const beyondSnow = a > snow;
    const giantChance = bd ? 0.03 : small || preset === 'whitedwarf' ? 0.08 : beyondSnow ? (giantsMade === 0 ? clamp(0.25 + 0.6 * (mSun - 0.3), 0.15, 0.8) : 0.35) : idx === 0 && rng.chance(0.05) && mSun > 0.6 ? 1 : 0;
    if (!isAnchor && rng.chance(giantChance)) {
      // Gas or ice giant.
      giantsMade++;
      const ice = beyondSnow && (a > snow * 4 || rng.chance(0.35) || small);
      const m = ice ? logRange(rng, 8, small ? 18 : 30) * M_EARTH : logRange(rng, 0.1, bd ? 0.3 : small ? 0.5 : 3) * M_JUP;
      const ringed = rng.chance(ice ? 0.3 : 0.25);
      b = makeGiant({
        name: pname,
        mass: m,
        rotationHours: locked ? 24 : rng.range(9, 18),
        seed,
        ice,
        tidallyLocked: locked,
        rings: ringed ? { inner: 1.25, outer: rng.range(1.8, 2.6), opacity: rng.range(0.4, 0.9) } : undefined,
      });
      if (b.rings) {
        // Ring radii were given in planet radii.
        b.rings.inner *= b.radius;
        b.rings.outer *= b.radius;
      }
    } else {
      // Sunlight relative to Earth, half-credited for the extra warming of redder light.
      const Seff = Ltot / L_SUN / (a / AU) ** 2 / Math.sqrt(earthFlux);
      b = makeWorld(rng, pname, T, a, hz, isAnchor || (inHZ && rng.chance(0.4)), isAnchor, o, locked, seed, small, Seff);
      if (isAnchor) {
        b.name = rng.pick(HAB_NAMES);
        habName = b.name;
      }
    }
    made.push({ b, a, anchor: isAnchor });
  });

  // Dynamical spacing: neighbours at least K mutual Hill radii apart (K ≈ 8–10 keeps
  // multi-planet systems stable for billions of years). The habitable world stays put;
  // planets inside it are pulled inward, those outside pushed outward.
  const sep = (m1: number, m2: number) => {
    const giants = m1 > 10 * M_EARTH || m2 > 10 * M_EARTH;
    const x = (giants ? 10 : 8) * 0.5 * Math.cbrt((m1 + m2) / (3 * Mtot));
    return (1 + x) / (1 - Math.min(x, 0.9));
  };
  const pivot = Math.max(0, made.findIndex((m) => m.anchor));
  for (let k = pivot + 1; k < made.length; k++) made[k].a = Math.max(made[k].a, made[k - 1].a * sep(made[k - 1].b.mass, made[k].b.mass));
  for (let k = pivot - 1; k >= 0; k--) made[k].a = Math.min(made[k].a, made[k + 1].a / sep(made[k].b.mass, made[k + 1].b.mass));
  const keep = made.filter((m) => m.a >= aMin * 0.98 && m.a <= aMax * 1.5);

  for (const { b, a, anchor } of keep) {
    const e = anchor ? rng.range(0, 0.02) : Math.min(0.12, Math.abs(rng.gauss()) * 0.035);
    placeOnOrbit(b, host, { a, e, i: Math.abs(rng.gauss()) * 1.2, node: rng.range(0, 360), peri: rng.range(0, 360), M: rng.range(0, 360) });
    if (companion) {
      // Circumbinary: orbit the binary's barycentre.
      const bc = barycentreOf([star, companion]);
      placeOnOrbitAround(b, bc.pos, bc.vel, Mtot, a, e, rng);
    }
    if (b.tidallyLocked) setObliquity(b, host, 0);
    else setObliquity(b, host, rng.chance(0.1) ? rng.range(40, 100) : rng.range(0, 32), rng.range(0, 360));
    planets.push(b);
    bodies.push(b);
  }

  // --- moons
  if (o.moons) {
    for (const pl of planets) {
      const giant = pl.isGiant;
      const count = giant ? rng.int(1, 4) : rng.chance(pl.mass > 0.3 * M_EARTH ? 0.3 : 0.08) ? 1 : 0;
      // Hill sphere limit for stable moons.
      const aPl = pl.pos.distTo(host.pos);
      const hill = aPl * Math.cbrt(pl.mass / (3 * Mtot));
      let am = pl.radius * rng.range(4, 8);
      for (let k = 0; k < count; k++) {
        if (am > hill * 0.35) break;
        const icy = giant ? teq(Ltot, aPl) < 170 : false;
        const habMoon = giant && k === 0 && aPl >= hz.inner && aPl <= hz.outer && o.habitable === false && rng.chance(0.6);
        const mm = habMoon ? rng.range(0.15, 0.5) * M_EARTH : giant ? logRange(rng, 3e20, 1.5e23) : pl.mass * rng.range(0.005, 0.03);
        const mname = `${pl.name} ${['I', 'II', 'III', 'IV'][k]}`;
        const m = habMoon
          ? makeRocky({ name: mname, mass: mm, rotationHours: 30, atmosphere: { N2: rng.range(4e4, 1.2e5), CO2: 600 }, waterGEL: rng.range(300, 2500), biosphere: o.life, terrain: 'earthlike', seed: rng.int(1, 1e9), initialTemp: 285, tidallyLocked: true, color: '#5d93b0' })
          : icy && mm > 5e22 && rng.chance(0.35)
            ? makeRocky({ name: mname, mass: mm, composition: { iron: 0.1, rock: 0.45, ice: 0.45, gas: 0 }, rotationHours: 300, atmosphere: { N2: rng.range(5e4, 1.6e5), CH4: 6e3 }, waterGEL: 2e4, volatile: 'CH4', terrain: 'titanlike', seed: rng.int(1, 1e9), haze: 0.7, initialTemp: Math.max(60, teq(Ltot, aPl) * 0.9), tidallyLocked: true, color: '#d9a441' })
            : makeRocky({ name: mname, mass: mm, composition: icy ? { iron: 0.08, rock: 0.47, ice: 0.45, gas: 0 } : undefined, rotationHours: 200, terrain: icy ? rng.pick(['europalike', 'ganymedelike', 'callistolike'] as TerrainStyle[]) : rng.chance(0.15) && giant ? 'iolike' : 'moonlike', waterGEL: icy ? 5e4 : 0, seed: rng.int(1, 1e9), initialTemp: Math.max(40, teq(Ltot, aPl) * 0.9), internalHeat: 0.01, tidallyLocked: true, color: icy ? '#d9d2c0' : '#a8a39a' });
        if (habMoon) habName = habName ?? mname;
        placeOnOrbit(m, pl, { a: am, e: rng.range(0, 0.02), i: rng.range(0, 2), node: rng.range(0, 360), peri: 0, M: rng.range(0, 360) });
        setObliquity(m, pl, 0);
        bodies.push(m);
        am *= rng.range(1.6, 2.6);
      }
    }
  }

  // --- belt
  if (o.belt && slots.length > 1) {
    // Between the last world inside the snow line and the first one beyond it (or at ~2× snow line).
    let aBelt = snow * 1.0;
    for (let k = 0; k < slots.length - 1; k++) if (slots[k] < snow && slots[k + 1] >= snow) aBelt = Math.sqrt(slots[k] * slots[k + 1]);
    for (let k = 0; k < 8; k++) {
      const r = logRange(rng, 3e3, 2.5e5);
      const ast = makeSmallBody(`${name.replace(/ A$/, '')} belt ${k + 1}`, (4 / 3) * Math.PI * r ** 3 * 2500, r, rng.chance(0.3), rng.int(1, 1e9));
      placeOnOrbit(ast, host, { a: aBelt * rng.range(0.85, 1.2), e: rng.range(0, 0.15), i: rng.range(0, 10), node: rng.range(0, 360), peri: rng.range(0, 360), M: rng.range(0, 360) });
      bodies.push(ast);
    }
  }

  const habBody = bodies.find((b) => b.name === habName) ?? null;
  const focus = habBody?.name ?? planets.find((pl) => pl.world)?.name ?? star.name;
  const hzText = `habitable zone ${fmtAU(hz.inner)}–${fmtAU(hz.outer)}`;
  const summary = `${p.label} ${name}${companion ? ' + companion' : ''}, ${age.toFixed(age < 1 ? 2 : 1)} Gyr, ${bodies.length - 1 - (companion ? 1 : 0)} bodies; ${hzText}.${preset === 'browndwarf' ? ' The brown dwarf is cooling: its habitable zone will move inward over time.' : ''}`;
  return { bodies, focus, name, summary };
}

function fmtAU(m: number): string {
  const a = m / AU;
  return a < 0.1 ? `${(a * 1000).toFixed(a < 0.01 ? 2 : 1)} mAU` : `${a.toFixed(2)} AU`;
}

function barycentreOf(bs: Body[]) {
  let m = 0;
  const pos = { x: 0, y: 0, z: 0 };
  const vel = { x: 0, y: 0, z: 0 };
  for (const b of bs) {
    m += b.mass;
    pos.x += b.pos.x * b.mass;
    pos.y += b.pos.y * b.mass;
    pos.z += b.pos.z * b.mass;
    vel.x += b.vel.x * b.mass;
    vel.y += b.vel.y * b.mass;
    vel.z += b.vel.z * b.mass;
  }
  return { pos: { x: pos.x / m, y: pos.y / m, z: pos.z / m }, vel: { x: vel.x / m, y: vel.y / m, z: vel.z / m } };
}

/** Re-place `b` on a near-circular orbit of radius a around a point mass (circumbinary). */
function placeOnOrbitAround(b: Body, cpos: { x: number; y: number; z: number }, cvel: { x: number; y: number; z: number }, M: number, a: number, e: number, rng: Rng): void {
  const th = rng.range(0, Math.PI * 2);
  const r = a * (1 - e);
  const v = Math.sqrt((G * M * (1 + e)) / r);
  b.pos.set(cpos.x + r * Math.cos(th), cpos.y + r * Math.sin(th), cpos.z);
  b.vel.set(cvel.x - v * Math.sin(th), cvel.y + v * Math.cos(th), cvel.z);
}

/** A rocky or icy world shaped by its equilibrium temperature and size. */
function makeWorld(
  rng: Rng,
  name: string,
  T: number,
  a: number,
  hz: ReturnType<typeof habitableZone>,
  temperate: boolean,
  anchor: boolean,
  o: SystemOptions,
  locked: boolean,
  seed: number,
  small: boolean,
  Seff: number,
): Body {
  const mE = anchor ? rng.range(0.6, 1.6) : logRange(rng, small ? 0.08 : 0.05, small ? 1.8 : 6);
  const m = mE * M_EARTH;
  const rot = locked ? 24 : rng.range(10, 48) * (rng.chance(0.08) ? -1 : 1);
  const base = { name, mass: m, rotationHours: rot, seed, tidallyLocked: locked };
  const inner = a < hz.optimisticInner;
  const g = (9.81 * mE) / Math.pow(mE, 0.54); // R ∝ M^0.27 → g ∝ M^0.46
  const keepsAir = g > 4 || T < 250;
  if (T > 1000) return makeRocky({ ...base, atmosphere: mE > 2 ? { CO2: 2e4 } : {}, terrain: 'lavaworld', initialTemp: Math.min(2500, T * 1.05), color: '#ff6a2a' });
  if ((temperate || anchor) && !inner && T < 330) {
    // A temperate world: water, nitrogen and as much CO₂ as a carbonate–silicate thermostat
    // would leave for its sunlight: the warming needed to reach ~290 K (with feedbacks), at
    // ~3 K per doubling. Deserts (little vapour) and locked worlds (cold night sides) need more.
    const ocean = rng.chance(0.3);
    const desert = !ocean && rng.chance(0.2);
    const dT = Math.max(0, 288 * (1 - Math.pow(Seff, 0.25)) * 1.3 + 3);
    const co2 = clamp(40 * Math.pow(2, dT / 3) * (desert ? 3 : 1) * (locked ? 3 : 1), 30, 3e5);
    const life = o.life && (anchor || rng.chance(0.5));
    const N2 = rng.range(0.6, 1.6) * 1e5 * Math.pow(mE, 0.3);
    const atm: Record<string, number> = { N2, CO2: co2, Ar: N2 * 0.012 };
    if (life) atm.O2 = N2 * rng.range(0.15, 0.3);
    return makeRocky({
      ...base,
      atmosphere: atm,
      waterGEL: ocean ? rng.range(3500, 9000) : desert ? rng.range(40, 200) : rng.range(800, 3500),
      biosphere: life,
      terrain: ocean ? 'oceanic' : desert ? 'continental' : 'earthlike',
      initialTemp: 285,
      iceCapLat: 72,
      civilization: anchor && o.civilization !== 'none' ? o.civilization : null,
      color: ocean ? '#2f6fb3' : desert ? '#d9b06a' : '#4f86c6',
    });
  }
  if (T > 330 || (inner && T > 280)) {
    if (mE < 0.25 || !keepsAir) return makeRocky({ ...base, terrain: 'mercurylike', initialTemp: T, internalHeat: 0.02, color: '#9c9084' });
    // Runaway greenhouse: a Venus.
    return makeRocky({ ...base, rotationHours: locked ? 24 : -rng.range(500, 6000), atmosphere: { CO2: rng.range(3e6, 1e7) * Math.pow(mE, 0.5), N2: 2e5, SO2: 1000 }, waterGEL: 0.02, terrain: 'venuslike', initialTemp: 700, color: '#e8cf8f' });
  }
  if (T > 170) {
    if (mE < 0.3 || !keepsAir) return makeRocky({ ...base, atmosphere: { CO2: rng.range(300, 1500), N2: 30 }, waterGEL: rng.range(5, 60), terrain: 'marslike', dust: 0.3, initialTemp: T, iceCapLat: 75, color: '#c1440e' });
    // Cold but sizeable: thick CO₂ (+ some H₂) can still warm it.
    return makeRocky({ ...base, atmosphere: { CO2: rng.range(1e5, 6e5), N2: 5e4 }, waterGEL: rng.range(300, 3000), terrain: rng.pick(['continental', 'oceanic'] as TerrainStyle[]), initialTemp: 240, iceCapLat: 45, color: '#8aa0b0' });
  }
  if (T > 75 && mE > 0.05 && rng.chance(0.35)) {
    // Titan-like methane world.
    return makeRocky({ ...base, composition: { iron: 0.1, rock: 0.45, ice: 0.45, gas: 0 }, atmosphere: { N2: rng.range(8e4, 2e5), CH4: 5e3 }, waterGEL: 2e4, volatile: 'CH4', terrain: 'titanlike', haze: 0.7, initialTemp: Math.max(70, T), color: '#d9a441' });
  }
  return makeRocky({
    ...base,
    composition: { iron: 0.08, rock: 0.47, ice: 0.45, gas: 0 },
    atmosphere: mE > 0.05 ? { N2: rng.range(0.5, 50) } : {},
    waterGEL: 5e4,
    terrain: rng.pick(['europalike', 'plutolike', 'tritonlike', 'ganymedelike'] as TerrainStyle[]),
    initialTemp: Math.max(35, T),
    color: '#d9d2c0',
  });
}

/**
 * Nudge a world's CO₂ (geometric bisection, re-running the climate spin-up each time) until
 * its climate is temperate: mean surface temperature near `target` without a snowball. This
 * stands in for the carbonate–silicate thermostat that would have done the same over
 * geological time. Locked worlds aim lower (their night side drags the mean down).
 */
export function tuneTemperate(sim: { initBody(b: Body): void }, b: Body, target?: number): void {
  if (!b.world || !(b.climate instanceof TerrestrialClimate)) return;
  const goal = target ?? (b.tidallyLocked ? 279 : 289);
  let lo = 5,
    hi = 6e5;
  let co2 = b.world.atmosphere.CO2 ?? 40;
  for (let it = 0; it < 7; it++) {
    const c = b.climate as TerrestrialClimate;
    const T = c.stats.meanT;
    const frozen = c.stats.iceFrac > (b.tidallyLocked ? 0.6 : 0.35);
    if (Math.abs(T - goal) < 5 && !frozen) return;
    if (T < goal || frozen) lo = co2;
    else hi = co2;
    co2 = Math.sqrt(lo * hi);
    b.world.atmosphere.CO2 = co2;
    sim.initBody(b);
  }
}

/** Wrap a generated system as a loadable scenario. */
export function systemScenario(o: SystemOptions): Scenario & { summary: string } {
  const sc: Scenario & { summary: string } = {
    id: `custom-${o.seed}`,
    name: 'Custom system',
    description: '',
    summary: '',
    epochMs: null,
    focus: '',
    speed: 86400,
    build: () => {
      const g = generateSystem(o);
      sc.focus = g.focus;
      sc.name = g.name;
      sc.summary = g.summary;
      sc.description = g.summary;
      // Compact systems around small stars need slower time to follow their orbits.
      const host = g.bodies[0];
      const first = g.bodies.find((b) => !b.isStarLike);
      if (first) {
        const a = first.pos.distTo(host.pos);
        const P = 2 * Math.PI * Math.sqrt(a ** 3 / (G * host.mass));
        sc.speed = clamp(P / 60, 600, 86400);
      }
      return g.bodies;
    },
    afterLoad: (sim) => {
      if (!o.habitable) return;
      const b = sim.bodies.find((x) => x.name === sc.focus);
      if (b) tuneTemperate(sim, b);
    },
  };
  return sc;
}

export { M_SUN, R_EARTH, R_SUN };

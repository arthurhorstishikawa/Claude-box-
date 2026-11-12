import { AU, DAY, DEG, G, M_EARTH, M_JUP, M_SUN, R_EARTH, R_JUP, YEAR } from '../core/constants';
import { V3 } from '../core/vec3';
import { Body, resetBodyIds } from '../physics/body';
import { eclipticFromRaDec, frameFromPole, makeGiant, makeRocky, makeSmallBody, makeStar, placeOnOrbit, setObliquity } from './factory';
import { habitableZone } from '../stars/habitableZone';
import { systemScenario } from './generator';
import { TerrestrialClimate } from '../climate/terrestrial';
import type { Empires } from './empires';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Wall-clock epoch (ms since 1970) for calendar display, or null for a relative clock. */
  epochMs: number | null;
  focus: string;
  /** Suggested time speed (sim seconds per real second). */
  speed: number;
  build: () => Body[];
  /** Optional fix-ups once every body's climate has spun up (e.g. tuning a habitable world). */
  afterLoad?: (sim: { initBody(b: Body): void; bodies: Body[]; agency?: { empires: Empires } }) => void;
}

const EPOCH_TODAY = Date.UTC(2026, 10, 2, 0, 0, 0);
const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);

/** JPL mean elements at J2000 with mean-longitude rates (deg/century). */
const PLANETS = {
  Mercury: { a: 0.38709927, e: 0.20563593, i: 7.00497902, L: 252.2503235, Ld: 149472.67411175, w: 77.45779628, O: 48.33076593 },
  Venus: { a: 0.72333566, e: 0.00677672, i: 3.39467605, L: 181.9790995, Ld: 58517.81538729, w: 131.60246718, O: 76.67984255 },
  Earth: { a: 1.00000261, e: 0.01671123, i: -0.00001531, L: 100.46457166, Ld: 35999.37244981, w: 102.93768193, O: 0 },
  Mars: { a: 1.52371034, e: 0.0933941, i: 1.84969142, L: -4.55343205, Ld: 19140.30268499, w: -23.94362959, O: 49.55953891 },
  Jupiter: { a: 5.202887, e: 0.04838624, i: 1.30439695, L: 34.39644051, Ld: 3034.74612775, w: 14.72847983, O: 100.47390909 },
  Saturn: { a: 9.53667594, e: 0.05386179, i: 2.48599187, L: 49.95424423, Ld: 1222.49362201, w: 92.59887831, O: 113.66242448 },
  Uranus: { a: 19.18916464, e: 0.04725744, i: 0.77263783, L: 313.23810451, Ld: 428.48202785, w: 170.9542763, O: 74.01692503 },
  Neptune: { a: 30.06992276, e: 0.00859048, i: 1.77004347, L: -55.12002969, Ld: 218.45945325, w: 44.96476227, O: 131.78422574 },
  Pluto: { a: 39.48211675, e: 0.2488273, i: 17.14001206, L: 238.92903833, Ld: 145.20780515, w: 224.06891629, O: 110.30393684 },
};

function elementsAt(p: (typeof PLANETS)[keyof typeof PLANETS], T: number) {
  const L = p.L + p.Ld * T;
  const M = L - p.w;
  return { a: p.a * AU, e: p.e, i: p.i, node: p.O, peri: p.w - p.O, M };
}

/** Pole (IAU RA/Dec) and rotation period (hours, negative = retrograde). */
const POLES: Record<string, [number, number, number]> = {
  Sun: [286.13, 63.87, 609.12],
  Mercury: [281.0097, 61.4143, 1407.6],
  Venus: [272.76, 67.16, -5832.6],
  Earth: [0, 90, 23.9345],
  Moon: [269.9949, 66.5392, 655.728],
  Mars: [317.68143, 52.8865, 24.6229],
  Jupiter: [268.056595, 64.495303, 9.925],
  Saturn: [40.589, 83.537, 10.656],
  Uranus: [257.311, -15.175, -17.24],
  Neptune: [299.36, 43.46, 16.11],
  Pluto: [132.993, -6.163, -153.29],
  Titan: [39.4827, 83.4279, 382.69],
  Triton: [299.36, 41.17, -141.04],
};

function applyPole(b: Body, name: string) {
  const p = POLES[name];
  if (!p) return;
  b.setSpinAxis(eclipticFromRaDec(p[0], p[1]));
  b.rotationPeriod = p[2] * 3600;
}

export function sun(age = 4.6e9): Body {
  const s = makeStar({ name: 'Sun', mass: 1, age, L: 1, R: 1, rotationDays: 25.38 });
  applyPole(s, 'Sun');
  return s;
}

export function earthLike(name = 'Earth', seed = 42, civ: 'modern' | 'preindustrial' | null = 'modern'): Body {
  const e = makeRocky({
    name,
    mass: 5.9722e24,
    radius: 6.371e6,
    rotationHours: 23.9345,
    atmosphere: { N2: 78084, O2: 20946, Ar: 934, CO2: 43, CH4: 0.19 },
    waterGEL: 2650,
    biosphere: true,
    terrain: 'earthlike',
    seed,
    initialTemp: 287,
    iceCapLat: 72,
    internalHeat: 0.087,
    color: '#4f86c6',
    civilization: civ,
  });
  e.description = 'Ocean world with plate tectonics, a nitrogen–oxygen atmosphere and life.';
  return e;
}

function buildSolarSystem(withMoons = true): Body[] {
  resetBodyIds(1);
  const T = (EPOCH_TODAY - J2000) / (86400e3 * 36525);
  const S = sun();
  const bodies: Body[] = [S];
  const add = (b: Body, el: ReturnType<typeof elementsAt>, poleName?: string) => {
    placeOnOrbit(b, S, el);
    if (poleName) applyPole(b, poleName);
    bodies.push(b);
    return b;
  };
  const mercury = add(
    makeRocky({ name: 'Mercury', mass: 3.3011e23, radius: 2.4397e6, composition: { iron: 0.7, rock: 0.3, ice: 0, gas: 0 }, rotationHours: 1407.6, terrain: 'mercurylike', seed: 401, internalHeat: 0.02, initialTemp: 340, color: '#9c9084' }),
    elementsAt(PLANETS.Mercury, T),
    'Mercury',
  );
  mercury.description = 'Iron-rich, airless; 3:2 spin–orbit resonance gives 176-day solar days.';
  const venus = add(
    makeRocky({ name: 'Venus', mass: 4.8675e24, radius: 6.0518e6, rotationHours: -5832.6, atmosphere: { CO2: 8.88e6, N2: 3.2e5, SO2: 1400 }, waterGEL: 0.02, terrain: 'venuslike', seed: 402, internalHeat: 0.06, initialTemp: 735, color: '#e8cf8f' }),
    elementsAt(PLANETS.Venus, T),
    'Venus',
  );
  venus.description = '92 bar CO₂ and sulfuric-acid clouds: a runaway greenhouse.';
  const earth = add(earthLike('Earth', 42, 'modern'), elementsAt(PLANETS.Earth, T), 'Earth');
  const mars = add(
    makeRocky({ name: 'Mars', mass: 6.4171e23, radius: 3.3895e6, rotationHours: 24.6229, atmosphere: { CO2: 580, N2: 16, Ar: 11, O2: 1 }, waterGEL: 25, terrain: 'marslike', seed: 404, dust: 0.3, iceCapLat: 80, internalHeat: 0.02, initialTemp: 210, color: '#c1440e' }),
    elementsAt(PLANETS.Mars, T),
    'Mars',
  );
  mars.description = 'Thin CO₂ air, dust storms and seasonal polar frost caps.';
  const jupiter = add(
    makeGiant({ name: 'Jupiter', mass: 1.89813e27, radius: 6.9911e7, rotationHours: 9.925, palette: 'jupiter', seed: 405, tInt: 100, vortices: [{ lat: -22, lon: 60, size: 8.0e6, color: [0.78, 0.38, 0.26] }] }),
    elementsAt(PLANETS.Jupiter, T),
    'Jupiter',
  );
  const saturn = add(
    makeGiant({ name: 'Saturn', mass: 5.6834e26, radius: 5.8232e7, rotationHours: 10.656, palette: 'saturn', seed: 406, tInt: 77, rings: { inner: 7.45e7, outer: 1.4022e8, color: [0.86, 0.79, 0.66], opacity: 0.95, mass: 1.5e19 } }),
    elementsAt(PLANETS.Saturn, T),
    'Saturn',
  );
  const uranus = add(
    makeGiant({ name: 'Uranus', mass: 8.681e25, radius: 2.5362e7, rotationHours: -17.24, palette: 'uranus', seed: 407, tInt: 35, ice: true, rings: { inner: 4.18e7, outer: 5.12e7, color: [0.35, 0.36, 0.38], opacity: 0.35 } }),
    elementsAt(PLANETS.Uranus, T),
    'Uranus',
  );
  const neptune = add(
    makeGiant({ name: 'Neptune', mass: 1.02413e26, radius: 2.4622e7, rotationHours: 16.11, palette: 'neptune', seed: 408, tInt: 52, ice: true, vortices: [{ lat: -20, lon: -30, size: 6.5e6, color: [0.12, 0.17, 0.42] }] }),
    elementsAt(PLANETS.Neptune, T),
    'Neptune',
  );
  const pluto = add(
    makeRocky({ name: 'Pluto', mass: 1.303e22, radius: 1.1883e6, composition: { iron: 0.05, rock: 0.6, ice: 0.35, gas: 0 }, rotationHours: -153.29, atmosphere: { N2: 1.0, CH4: 0.005 }, terrain: 'plutolike', seed: 409, internalHeat: 0.003, initialTemp: 40, color: '#d8c3a5' }),
    elementsAt(PLANETS.Pluto, T),
    'Pluto',
  );
  // Earth's Moon (ecliptic elements at the epoch).
  const days = T * 36525;
  const moon = makeRocky({ name: 'Moon', mass: 7.342e22, radius: 1.7374e6, rotationHours: 655.728, terrain: 'moonlike', seed: 301, internalHeat: 0.02, initialTemp: 250, tidallyLocked: true, color: '#b8b5ae' });
  const Lm = 218.316 + 13.176396 * days;
  const Om = 125.044 - 0.0529539 * days;
  const wm = 83.353 + 0.111403 * days;
  placeOnOrbit(moon, earth, { a: 3.844e8, e: 0.0549, i: 5.145, node: Om, peri: wm - Om, M: Lm - wm });
  setObliquity(moon, earth, 6.68);
  moon.description = 'Tidally locked; its near side always faces its planet.';
  bodies.push(moon);
  if (withMoons) {
    // Galilean moons in Jupiter's equatorial plane, in the Laplace resonance.
    const jf = frameFromPole(jupiter.spinAxis);
    const gal: [string, number, number, number, number, string, number, number][] = [
      ['Io', 8.931938e22, 1.8216e6, 4.217e8, 0.0041, 'iolike', 0, 1.0],
      ['Europa', 4.799844e22, 1.5608e6, 6.71034e8, 0.009, 'europalike', 0, 100e3],
      ['Ganymede', 1.4819e23, 2.6341e6, 1.070412e9, 0.0013, 'ganymedelike', 90, 300e3],
      ['Callisto', 1.075938e23, 2.4103e6, 1.882709e9, 0.0074, 'callistolike', 230, 200e3],
    ];
    gal.forEach(([name, m, r, a, e, terrain, lon, water], idx) => {
      const icy = name !== 'Io';
      const b = makeRocky({
        name,
        mass: m,
        radius: r,
        composition: icy ? { iron: 0.1, rock: 0.45, ice: 0.45, gas: 0 } : { iron: 0.2, rock: 0.8, ice: 0, gas: 0 },
        rotationHours: 24,
        terrain: terrain as any,
        seed: 500 + idx,
        waterGEL: icy ? water : 0,
        initialTemp: icy ? 100 : 110,
        internalHeat: 0.01,
        tidallyLocked: true,
        forcedEcc: e,
        color: icy ? '#d9d2c0' : '#e8d36a',
      });
      placeOnOrbit(b, jupiter, { a, e, i: 0.05, node: 0, peri: 0, M: lon }, jf);
      b.setSpinAxis(jupiter.spinAxis);
      bodies.push(b);
    });
    const sf = frameFromPole(saturn.spinAxis);
    const titan = makeRocky({ name: 'Titan', mass: 1.3452e23, radius: 2.5747e6, composition: { iron: 0.1, rock: 0.45, ice: 0.45, gas: 0 }, rotationHours: 382.69, atmosphere: { N2: 1.42e5, H2: 150 }, waterGEL: 16, volatile: 'CH4', terrain: 'titanlike', seed: 601, haze: 0.8, initialTemp: 94, internalHeat: 0.005, tidallyLocked: true, color: '#d9a441' });
    placeOnOrbit(titan, saturn, { a: 1.22187e9, e: 0.0288, i: 0.35, node: 0, peri: 0, M: 140 }, sf);
    titan.setSpinAxis(saturn.spinAxis);
    titan.description = 'Thick nitrogen air, orange haze, methane rain and lakes.';
    bodies.push(titan);
    const nf = frameFromPole(neptune.spinAxis);
    const triton = makeRocky({ name: 'Triton', mass: 2.139e22, radius: 1.3534e6, composition: { iron: 0.05, rock: 0.65, ice: 0.3, gas: 0 }, rotationHours: -141.04, atmosphere: { N2: 1.4 }, terrain: 'tritonlike', seed: 701, initialTemp: 38, internalHeat: 0.005, tidallyLocked: true, color: '#d6c8c8' });
    placeOnOrbit(triton, neptune, { a: 3.54759e8, e: 0.000016, i: 156.885, node: 0, peri: 0, M: 200 }, nf);
    triton.setSpinAxis(V3.scaled(neptune.spinAxis, -1));
    bodies.push(triton);
    const charon = makeRocky({ name: 'Charon', mass: 1.586e21, radius: 6.06e5, composition: { iron: 0.05, rock: 0.55, ice: 0.4, gas: 0 }, rotationHours: 153.29, terrain: 'callistolike', seed: 801, initialTemp: 45, internalHeat: 0.002, tidallyLocked: true, color: '#b5ada5' });
    placeOnOrbit(charon, pluto, { a: 1.9591e7, e: 0.0002, i: 0.08, node: 0, peri: 0, M: 30 }, frameFromPole(pluto.spinAxis));
    bodies.push(charon);
  }
  void mars;
  void venus;
  void uranus;
  return bodies;
}

function buildEarthMoon(): Body[] {
  const all = buildSolarSystem(false);
  return all.filter((b) => ['Sun', 'Earth', 'Moon'].includes(b.name));
}

/** A star with planets on circular orbits given by (a [AU], body) pairs. */
function simpleSystem(star: Body, planets: [number, Body, number?][]): Body[] {
  const out = [star];
  planets.forEach(([a, p, M], idx) => {
    placeOnOrbit(p, star, { a: a * AU, e: 0.01, i: 0.3 * idx, node: 20 * idx, peri: 0, M: M ?? idx * 77 });
    if (p.tidallyLocked) setObliquity(p, star, 0);
    else setObliquity(p, star, 18 + idx * 5);
    out.push(p);
  });
  return out;
}

function buildTrappist(): Body[] {
  resetBodyIds(1);
  const star = makeStar({ name: 'TRAPPIST-1', mass: 0.0898, age: 7.6e9, L: 5.53e-4, R: 0.1192, rotationDays: 3.3 });
  const data: [string, number, number, number, Record<string, number>, number, string][] = [
    ['b', 1.374, 1.116, 0.01154, { CO2: 3e5 }, 0, 'lavaworld'],
    ['c', 1.308, 1.097, 0.0158, { CO2: 1e5, N2: 2e4 }, 0, 'venuslike'],
    ['d', 0.388, 0.788, 0.02227, { N2: 5e4, CO2: 5e3 }, 500, 'oceanic'],
    ['e', 0.692, 0.92, 0.02925, { N2: 8e4, CO2: 2e3, O2: 100 }, 2000, 'earthlike'],
    ['f', 1.039, 1.045, 0.03849, { N2: 8e4, CO2: 3e4 }, 3000, 'oceanic'],
    ['g', 1.321, 1.129, 0.04683, { N2: 1e5, CO2: 8e4 }, 3000, 'earthlike'],
    ['h', 0.326, 0.755, 0.06189, { N2: 2e4, CO2: 1e3 }, 500, 'tritonlike'],
  ];
  const planets: [number, Body, number][] = data.map(([n, m, r, a, atm, water, terrain], idx) => {
    const p = makeRocky({
      name: `TRAPPIST-1${n}`,
      mass: m * M_EARTH,
      radius: r * R_EARTH,
      rotationHours: 24,
      atmosphere: atm,
      waterGEL: water,
      terrain: terrain as any,
      seed: 1100 + idx,
      tidallyLocked: true,
      initialTemp: 250,
      color: ['#d6743b', '#d8a76a', '#7aa3c8', '#5f93b8', '#7eaed0', '#a3c3d8', '#d9d4cc'][idx],
    });
    return [a, p, idx * 51];
  });
  return simpleSystem(star, planets);
}

function buildProxima(): Body[] {
  resetBodyIds(1);
  const star = makeStar({ name: 'Proxima Centauri', mass: 0.1221, age: 4.85e9, L: 0.00155, R: 0.1542, rotationDays: 83 });
  const p = makeRocky({ name: 'Proxima b', mass: 1.07 * M_EARTH, radius: 1.03 * R_EARTH, rotationHours: 24, atmosphere: { N2: 9e4, CO2: 400 }, waterGEL: 1500, terrain: 'oceanic', seed: 1201, tidallyLocked: true, initialTemp: 240, color: '#6b9cc4' });
  p.description = 'Tidally locked: an "eyeball" world with a substellar ocean and ice elsewhere.';
  return simpleSystem(star, [[0.04857, p]]);
}

function buildTwinSuns(): Body[] {
  resetBodyIds(1);
  const a = makeStar({ name: 'Tatoo I', mass: 1.0, age: 3e9, rotationDays: 20 });
  const b = makeStar({ name: 'Tatoo II', mass: 0.75, age: 3e9, rotationDays: 30 });
  b.pos.set(0.18 * AU, 0, 0);
  const mu = G * (a.mass + b.mass);
  const v = Math.sqrt(mu / (0.18 * AU));
  // Velocities about the barycentre.
  b.vel.set(0, (v * a.mass) / (a.mass + b.mass), 0);
  a.vel.set(0, (-v * b.mass) / (a.mass + b.mass), 0);
  const world = makeRocky({ name: 'Dune Prime', mass: 0.9 * M_EARTH, radius: 0.97 * R_EARTH, rotationHours: 30, atmosphere: { N2: 8e4, O2: 1.5e4, CO2: 80 }, waterGEL: 400, biosphere: true, terrain: 'continental', seed: 1301, initialTemp: 290, color: '#d9b06a' });
  const barycentre = { mass: a.mass + b.mass, pos: new V3(), vel: new V3() } as unknown as Body;
  placeOnOrbit(world, barycentre, { a: 1.5 * AU, e: 0.02, i: 0.5, node: 0, peri: 0, M: 40 });
  setObliquity(world, a, 12);
  return [a, b, world];
}

function buildHotJupiter(): Body[] {
  resetBodyIds(1);
  const star = makeStar({ name: 'HD 209458', mass: 1.15, age: 4e9, L: 1.77, R: 1.2, rotationDays: 14 });
  const p = makeGiant({ name: 'HD 209458 b (Osiris)', mass: 0.69 * M_JUP, radius: 1.38 * R_JUP, rotationHours: 84.6, seed: 1401, tInt: 400, tidallyLocked: true });
  p.description = 'A hot Jupiter: 1400 K dayside, kilometre-per-second winds, glowing night side.';
  const lava = makeRocky({ name: '55 Cnc e analogue', mass: 8 * M_EARTH, radius: 1.88 * R_EARTH, rotationHours: 17.7, atmosphere: { CO2: 1e4 }, terrain: 'lavaworld', seed: 1402, tidallyLocked: true, initialTemp: 2000, color: '#ff6a2a' });
  return simpleSystem(star, [
    [0.0475, p],
    [0.0154, lava],
  ]);
}

function buildSnowball(): Body[] {
  resetBodyIds(1);
  const s = makeStar({ name: 'Young Sun', mass: 1, age: 3.9e9, L: 0.94, R: 0.97 });
  const e = earthLike('Snowball Earth', 2020, null);
  e.world!.initialTemp = 230;
  e.world!.iceCapLat = 0;
  e.world!.atmosphere = { N2: 78084, O2: 4000, Ar: 934, CO2: 30 };
  e.world!.biosphere = false;
  e.description = '700 million years ago: ice to the equator. Volcanic CO₂ must build up to escape.';
  return simpleSystem(s, [[1, e]]);
}

function buildEarlyMars(): Body[] {
  resetBodyIds(1);
  const s = makeStar({ name: 'Faint young Sun', mass: 1, age: 0.8e9 });
  const m = makeRocky({ name: 'Early Mars', mass: 6.4171e23, radius: 3.3895e6, rotationHours: 24.6229, atmosphere: { CO2: 1.0e5, N2: 3e3, H2: 3e3 }, waterGEL: 400, terrain: 'marslike', seed: 404, initialTemp: 250, color: '#b8693d' });
  m.description = 'Did a thick CO₂–H₂ greenhouse keep ancient Mars wet under a faint Sun?';
  return simpleSystem(s, [[1.524, m]]);
}

function buildRedGiantSun(): Body[] {
  const bodies = buildSolarSystem(false).filter((b) => ['Sun', 'Mercury', 'Venus', 'Earth', 'Moon', 'Mars', 'Jupiter', 'Saturn'].includes(b.name));
  const s = bodies[0];
  s.star!.age = 12.12e9 * YEAR;
  return bodies;
}

function buildFutureSun(): Body[] {
  const bodies = buildEarthMoon();
  bodies[0].star!.age = (4.6e9 + 1.0e9) * YEAR;
  return bodies;
}

function buildFlyby(): Body[] {
  const bodies = buildSolarSystem(false).filter((b) => !['Pluto'].includes(b.name));
  const intruder = makeStar({ name: 'Rogue star', mass: 0.6, age: 6e9, rotationDays: 30 });
  intruder.pos.set(-60 * AU, 2.5 * AU, 1 * AU);
  intruder.vel.set(25e3, 0, 0);
  bodies.push(intruder);
  return bodies;
}

function buildRogue(): Body[] {
  resetBodyIds(1);
  const p = makeRocky({ name: 'Rogue world', mass: 1.5 * M_EARTH, radius: 1.12 * R_EARTH, rotationHours: 20, atmosphere: { H2: 4e6, N2: 1e5 }, waterGEL: 3000, terrain: 'oceanic', seed: 1501, internalHeat: 0.15, initialTemp: 280, color: '#506f8a' });
  p.description = 'No star at all: a thick hydrogen blanket traps internal heat (Stevenson 1999).';
  return [p];
}

/**
 * A temperate world around a young brown dwarf. Brown dwarfs never ignite hydrogen fusion;
 * they glow from contraction heat and fade steadily (L ∝ age^−1.3), so their habitable zone
 * creeps inward — a world that is temperate today freezes within a few hundred million years.
 */
function buildEmber(): Body[] {
  resetBodyIds(1);
  const bd = makeStar({ name: 'Ember', mass: 0.065, age: 4.5e8, rotationDays: 0.15 });
  const hz = habitableZone(bd.star!.L, bd.star!.T);
  const mid = Math.sqrt(hz.inner * hz.outer);
  const cinder = makeRocky({ name: 'Cinder', mass: 0.45 * M_EARTH, rotationHours: 24, terrain: 'mercurylike', seed: 1701, initialTemp: 420, internalHeat: 0.05, tidallyLocked: true, color: '#9c9084' });
  const hearth = makeRocky({ name: 'Hearth', mass: 0.9 * M_EARTH, rotationHours: 24, atmosphere: { N2: 8.5e4, O2: 1.5e4, Ar: 900, CO2: 3.5e4 }, waterGEL: 1800, biosphere: true, terrain: 'earthlike', seed: 1702, initialTemp: 285, tidallyLocked: true, color: '#5a7f9a' });
  const ash = makeRocky({ name: 'Ash', mass: 0.6 * M_EARTH, composition: { iron: 0.1, rock: 0.5, ice: 0.4, gas: 0 }, rotationHours: 24, atmosphere: { N2: 3e4, CO2: 800 }, waterGEL: 3e4, terrain: 'europalike', seed: 1703, initialTemp: 190, tidallyLocked: true, color: '#d9d2c0' });
  placeOnOrbit(cinder, bd, { a: hz.inner * 0.55, e: 0.01, i: 0.3, node: 0, peri: 0, M: 40 });
  placeOnOrbit(hearth, bd, { a: mid * 0.8, e: 0.004, i: 0.1, node: 0, peri: 0, M: 160 });
  placeOnOrbit(ash, bd, { a: hz.outer * 1.5, e: 0.02, i: 0.5, node: 0, peri: 0, M: 290 });
  for (const p of [cinder, hearth, ash]) setObliquity(p, bd, 0);
  hearth.description = 'A tidally locked world warmed by a cooling brown dwarf: an eternal day side, near-black infrared-hungry plants, and a habitable zone that is slowly moving away.';
  return [bd, cinder, hearth, ash];
}

function buildEmpty(): Body[] {
  resetBodyIds(1);
  return [sun()];
}

function buildAlphaCen(): Body[] {
  resetBodyIds(1);
  const A = makeStar({ name: 'Alpha Centauri A', mass: 1.1, age: 5.3e9, L: 1.52, R: 1.22 });
  const B = makeStar({ name: 'Alpha Centauri B', mass: 0.907, age: 5.3e9, L: 0.5, R: 0.86 });
  const out = [A];
  placeOnOrbit(B, A, { a: 23.4 * AU, e: 0.52, i: 0, node: 0, peri: 0, M: 180 });
  out.push(B);
  const pa = makeRocky({ name: 'Pandora', mass: 1.2 * M_EARTH, radius: 1.06 * R_EARTH, rotationHours: 26, atmosphere: { N2: 9e4, O2: 2.2e4, CO2: 60 }, waterGEL: 2200, biosphere: true, terrain: 'earthlike', seed: 1601, initialTemp: 288, color: '#4f9a8a' });
  placeOnOrbit(pa, A, { a: 1.25 * AU, e: 0.01, i: 1, node: 0, peri: 0, M: 10 });
  setObliquity(pa, A, 20);
  out.push(pa);
  const pb = makeRocky({ name: 'Polyphemus', mass: 0.8 * M_EARTH, radius: 0.94 * R_EARTH, rotationHours: 31, atmosphere: { N2: 7e4, CO2: 900 }, waterGEL: 1000, terrain: 'continental', seed: 1602, initialTemp: 270, color: '#8c8a6a' });
  placeOnOrbit(pb, B, { a: 0.71 * AU, e: 0.02, i: 2, node: 0, peri: 0, M: 200 });
  setObliquity(pb, B, 10);
  out.push(pb);
  return out;
}

export const SCENARIOS: Scenario[] = [
  { id: 'solar', name: 'Solar System (today)', description: 'Sun, eight planets, Pluto and major moons on their real orbits for today’s date. Every surface is procedurally generated.', epochMs: EPOCH_TODAY, focus: 'Earth', speed: DAY, build: () => buildSolarSystem(true) },
  { id: 'earthmoon', name: 'Earth & Moon', description: 'Just the Earth–Moon system and the Sun: fast and detailed.', epochMs: EPOCH_TODAY, focus: 'Earth', speed: 6 * 3600, build: buildEarthMoon },
  { id: 'trappist', name: 'TRAPPIST-1', description: 'Seven tidally locked Earth-sized worlds around an ultracool red dwarf — note the dark plant pigments.', epochMs: null, focus: 'TRAPPIST-1e', speed: DAY, build: buildTrappist },
  { id: 'proxima', name: 'Proxima b eyeball', description: 'A tidally locked ocean planet: open water at the substellar point, ice everywhere else.', epochMs: null, focus: 'Proxima b', speed: DAY, build: buildProxima },
  { id: 'twins', name: 'Twin suns', description: 'A habitable desert world orbiting a close binary: double shadows, double sunsets.', epochMs: null, focus: 'Dune Prime', speed: DAY, build: buildTwinSuns },
  { id: 'alphacen', name: 'Alpha Centauri (hypothetical)', description: 'Two Sun-like stars, each with a hypothetical habitable planet.', epochMs: null, focus: 'Pandora', speed: DAY, build: buildAlphaCen },
  { id: 'hotjupiter', name: 'Hot Jupiter & lava world', description: 'A 1400 K gas giant and a molten super-Earth hugging their star.', epochMs: null, focus: 'HD 209458 b (Osiris)', speed: 3 * 3600, build: buildHotJupiter },
  { id: 'snowball', name: 'Snowball Earth', description: 'Ice from pole to equator. Speed up time and watch volcanic CO₂ build up (geology on).', epochMs: null, focus: 'Snowball Earth', speed: YEAR, build: buildSnowball },
  { id: 'earlymars', name: 'Early Mars', description: 'A thick CO₂/H₂ atmosphere, lakes and a faint young Sun.', epochMs: null, focus: 'Early Mars', speed: DAY * 5, build: buildEarlyMars },
  { id: 'futuresun', name: 'Earth in 1 billion years', description: 'The Sun is 10% brighter. Is Earth tipping into a moist greenhouse?', epochMs: null, focus: 'Earth', speed: YEAR, build: buildFutureSun },
  { id: 'redgiant', name: 'Red-giant Sun', description: 'The Sun swells toward the tip of the red-giant branch, swallowing the inner planets.', epochMs: null, focus: 'Earth', speed: 1e5 * YEAR, build: buildRedGiantSun },
  { id: 'flyby', name: 'Rogue star flyby', description: 'A 0.6 M☉ star plunges through the outer Solar System.', epochMs: EPOCH_TODAY, focus: 'Sun', speed: 30 * DAY, build: buildFlyby },
  { id: 'rogue', name: 'Starless rogue planet', description: 'A free-floating world kept warm by internal heat under thick hydrogen.', epochMs: null, focus: 'Rogue world', speed: DAY, build: buildRogue },
  { id: 'ember', name: 'Brown dwarf habitable zone', description: 'Hearth orbits a 65-Jupiter-mass brown dwarf every few days. Brown dwarfs cool forever: speed time up and watch the habitable zone slide inward and the world freeze.', epochMs: null, focus: 'Hearth', speed: 3 * 3600, build: buildEmber },
  { id: 'empty', name: 'Empty system', description: 'Just a Sun-like star. Build your own system with the toolbox.', epochMs: null, focus: 'Sun', speed: DAY, build: buildEmpty },
];

/** A modern civilization with a neighbouring star system within reach of colony ships. */
function neighborsScenario(): Scenario {
  const base = systemScenario({ seed: 2026, star: 'G', planets: 6, habitable: true, life: true, civilization: 'modern', moons: true, belt: false, secondLy: 0.5 });
  return {
    id: 'neighbors',
    name: 'Reaching the stars',
    description: 'An Earth-like world with a modern civilization, and another star system half a light-year away. Speed time up: the civilization faces its warming, goes carbon-free, terraforms a neighbouring planet and sends colony ships to the other star.',
    epochMs: null,
    get focus() {
      return base.focus;
    },
    get speed() {
      return base.speed;
    },
    build: () => base.build(),
    afterLoad: (sim) => base.afterLoad?.(sim),
  };
}
SCENARIOS.splice(SCENARIOS.length - 1, 0, neighborsScenario());

/** Two advanced civilizations in neighbouring star systems: expansion, contact and war. */
function rivalsScenario(): Scenario {
  const base = systemScenario({ seed: 1984, star: 'G', planets: 6, habitable: true, life: true, civilization: 'modern', moons: true, belt: false, secondLy: 0.3, secondCivilization: 'modern' });
  return {
    id: 'rivals',
    name: 'Rival empires',
    description:
      'Two star systems 0.3 light-years apart, each home to an advanced civilization on the verge of interstellar flight. Speed time up (a year per second or more): they terraform and settle their neighbours, send colony ships to each other’s systems, meet — and may go to war. Watch the Life tab and the news feed.',
    epochMs: null,
    get focus() {
      return base.focus;
    },
    speed: YEAR / 12,
    build: () => base.build(),
    afterLoad: (sim) => {
      base.afterLoad?.(sim);
      // Both civilizations are already spacefaring; one is more warlike than the other.
      const homes = sim.bodies.filter((b) => b.climate instanceof TerrestrialClimate && !!b.climate.civ);
      homes.forEach((b, i) => {
        const civ = (b.climate as TerrestrialClimate).civ!;
        civ.tech = 2.4;
        civ.era = 'clean';
        civ.excessCO2 = 0;
        civ.autoPolicy = true;
        const e = sim.agency?.empires.ensure(b, civ);
        if (e) e.aggression = i === 0 ? 0.55 : 0.8;
      });
    },
  };
}
SCENARIOS.splice(SCENARIOS.length - 1, 0, rivalsScenario());

export function findScenario(id: string): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

export const ASTEROID_DEFAULT = () => makeSmallBody('Asteroid', 4e15, 7e3, false, 42);
export { DEG, DAY };

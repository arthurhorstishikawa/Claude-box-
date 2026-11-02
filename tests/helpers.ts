import { DAY, YEAR } from '../src/core/constants';
import type { Illuminator } from '../src/climate/insolation';
import { TerrestrialClimate, type ClimateContext, type WorldInit } from '../src/climate/terrestrial';

export interface TestWorld {
  init: WorldInit;
  R: number;
  g: number;
  mass: number;
  flux: number;
  teff: number;
  rotation: number; // sidereal s (signed)
  solarDay: number; // synodic s (Infinity for locked)
  year: number;
  obliquityDeg: number;
  internal: number;
  locked?: boolean;
}

export function illum(w: TestWorld, solarLon: number, subLon = 0): Illuminator {
  const eps = (w.obliquityDeg * Math.PI) / 180;
  const dec = Math.asin(Math.sin(eps) * Math.sin(solarLon));
  return {
    dir: [Math.cos(dec) * Math.cos(subLon), Math.cos(dec) * Math.sin(subLon), Math.sin(dec)],
    flux: w.flux,
    meanFlux: w.flux,
    teff: w.teff,
    synodic: w.solarDay,
    orbitPeriod: w.year,
    obliquity: eps,
    xuvFrac: 3e-6,
  };
}

export function ctxFor(w: TestWorld, il: Illuminator[], time: number, extra: Partial<ClimateContext> = {}): ClimateContext {
  return {
    illum: il,
    g: w.g,
    R: w.R,
    mass: w.mass,
    omega: (2 * Math.PI) / w.rotation,
    synodicDay: w.solarDay,
    orbitPeriod: w.year,
    internalHeat: w.internal,
    geothermal: w.internal,
    time,
    realDt: 0.016,
    storms: false,
    geology: false,
    locked: !!w.locked,
    ...extra,
  };
}

/** Spin up with annual-mean steps, then run seasonally with daily-mean steps for `years`. */
export function spinUp(w: TestWorld, years = 3, res: 'low' | 'medium' = 'low', extra: Partial<ClimateContext> = {}): TerrestrialClimate {
  const c = new TerrestrialClimate(w.init, w.R, w.g, res);
  let t = 0;
  for (let n = 0; n < 40; n++) {
    const dt = Math.max(w.year, YEAR);
    c.step(dt, ctxFor(w, [illum(w, 0)], t, extra));
    t += dt;
  }
  const stepsPerYear = 48;
  for (let y = 0; y < years; y++) {
    for (let s = 0; s < stepsPerYear; s++) {
      const dt = w.year / stepsPerYear;
      const ls = ((s + 0.5) / stepsPerYear) * 2 * Math.PI;
      const dtUse = Math.max(dt, Math.abs(w.solarDay) * 0.8);
      c.step(Number.isFinite(w.solarDay) ? dtUse : dt, ctxFor(w, [illum(w, ls)], t, extra));
      t += dt;
    }
  }
  return c;
}

export const EARTH: TestWorld = {
  init: { atmosphere: { N2: 78084, O2: 20946, Ar: 934, CO2: 42, CH4: 0.19 }, waterGEL: 2650, volatile: 'H2O', biosphere: true, terrain: 'earthlike', terrainSeed: 42, iceCapLat: 72, initialTemp: 287 },
  R: 6.371e6, g: 9.81, mass: 5.972e24, flux: 1361, teff: 5772, rotation: 86164, solarDay: DAY, year: YEAR, obliquityDeg: 23.44, internal: 0.087,
};
export const MARS: TestWorld = {
  init: { atmosphere: { CO2: 580, N2: 16, Ar: 11, O2: 1 }, waterGEL: 25, volatile: 'H2O', biosphere: false, terrain: 'marslike', terrainSeed: 7, iceCapLat: 80, dust: 0.3, initialTemp: 210 },
  R: 3.3895e6, g: 3.71, mass: 6.417e23, flux: 586, teff: 5772, rotation: 88642, solarDay: 88775, year: 686.98 * DAY, obliquityDeg: 25.19, internal: 0.02,
};
export const VENUS: TestWorld = {
  init: { atmosphere: { CO2: 8.88e6, N2: 3.2e5, SO2: 1400 }, waterGEL: 0.02, volatile: 'H2O', biosphere: false, terrain: 'venuslike', terrainSeed: 3, initialTemp: 735 },
  R: 6.0518e6, g: 8.87, mass: 4.867e24, flux: 2601, teff: 5772, rotation: -243.02 * DAY, solarDay: -116.75 * DAY, year: 224.7 * DAY, obliquityDeg: 2.64, internal: 0.06,
};
export const TITAN: TestWorld = {
  init: { atmosphere: { N2: 1.42e5, H2: 150 }, waterGEL: 16, volatile: 'CH4', biosphere: false, terrain: 'titanlike', terrainSeed: 11, haze: 0.8, initialTemp: 94 },
  R: 2.5747e6, g: 1.352, mass: 1.3452e23, flux: 15.0, teff: 5772, rotation: 15.945 * DAY, solarDay: 15.945 * DAY, year: 29.46 * YEAR, obliquityDeg: 26.7, internal: 0.005,
};
export const MOON: TestWorld = {
  init: { atmosphere: {}, waterGEL: 0, volatile: 'H2O', biosphere: false, terrain: 'moonlike', terrainSeed: 5, initialTemp: 220 },
  R: 1.7374e6, g: 1.62, mass: 7.342e22, flux: 1361, teff: 5772, rotation: 27.32 * DAY, solarDay: 29.53 * DAY, year: YEAR, obliquityDeg: 1.54, internal: 0.02,
};

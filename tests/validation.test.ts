import { describe, expect, it } from 'vitest';
import { DAY, G, YEAR } from '../src/core/constants';
import { V3 } from '../src/core/vec3';
import { orbitFromState } from '../src/physics/orbits';
import { GasGiantClimate } from '../src/climate/gasGiant';
import { TerrestrialClimate } from '../src/climate/terrestrial';
import { findScenario } from '../src/sim/scenarios';
import { Simulation } from '../src/sim/simulation';
import { ctxFor, EARTH, illum, spinUp } from './helpers';

/**
 * Validation against the real Solar System. Tolerances reflect what a model of this
 * complexity can honestly claim; the reference value is given with each check.
 */
describe('validation: Solar System', () => {
  const sim = new Simulation();
  sim.settings.civilizations = false;
  sim.loadScenario(findScenario('solar'));
  const body = (n: string) => sim.bodies.find((b) => b.name === n)!;
  const T = (n: string) => (body(n).climate as TerrestrialClimate).stats;
  const G_ = (n: string) => (body(n).climate as GasGiantClimate).stats;
  const within = (v: number, ref: number, tol: number, what: string) => expect(Math.abs(v - ref), `${what}: model ${v.toFixed(3)} vs real ${ref}`).toBeLessThanOrEqual(tol);

  it('Earth: temperature, albedo, greenhouse, clouds, rain, ice', () => {
    const s = T('Earth');
    within(s.meanT, 288, 4, 'mean surface temperature (K)');
    within(s.albedo, 0.3, 0.03, 'Bond albedo');
    within(s.greenhouse, 33, 6, 'greenhouse effect (K)');
    within(s.cloudFrac, 0.65, 0.12, 'cloud fraction');
    within(s.precip, 2.7, 0.8, 'precipitation (mm/day)');
    within(s.iceFrac, 0.1, 0.07, 'snow and ice cover');
  });

  it('other rocky worlds', () => {
    within(T('Venus').meanT, 737, 30, 'Venus surface temperature (K)');
    within(T('Venus').albedo, 0.76, 0.05, 'Venus Bond albedo');
    within(T('Mars').meanT, 210, 12, 'Mars mean temperature (K)');
    within(T('Mars').albedo, 0.25, 0.04, 'Mars Bond albedo');
    within(T('Titan').meanT, 93.7, 4, 'Titan surface temperature (K)');
    within(T('Moon').albedo, 0.11, 0.03, 'Moon Bond albedo');
    expect(T('Moon').maxT).toBeGreaterThan(350); // lunar noon ~390 K
    expect(T('Moon').minT).toBeLessThan(110); // lunar night ~95 K
    expect(T('Mercury').maxT).toBeGreaterThan(600); // sub-solar ~700 K
    // The three icy Galilean moons differ: bright Europa is the coldest, dark Callisto the warmest.
    within(T('Europa').albedo, 0.67, 0.08, 'Europa Bond albedo');
    within(T('Callisto').albedo, 0.22, 0.06, 'Callisto Bond albedo');
    expect(T('Europa').meanT).toBeLessThan(T('Ganymede').meanT);
    expect(T('Ganymede').meanT).toBeLessThan(T('Callisto').meanT);
  });

  it('giant planets', () => {
    within(G_('Jupiter').Teff, 124.4, 5, 'Jupiter effective temperature (K)');
    within(G_('Jupiter').T1bar, 165, 8, 'Jupiter 1-bar temperature (K)');
    within(G_('Saturn').Teff, 95, 5, 'Saturn effective temperature (K)');
    within(G_('Uranus').Teff, 59.1, 4, 'Uranus effective temperature (K)');
    within(G_('Neptune').Teff, 59.3, 4, 'Neptune effective temperature (K)');
  });

  it('tides: Io is volcanic, the Moon recedes, the axis precesses', () => {
    sim.speed = DAY;
    for (let i = 0; i < 60; i++) sim.update(1 / 30);
    within(body('Io').tidalHeat, 2.3, 1.2, "Io's tidal heat flux (W/m²)");
    expect(body('Europa').tidalHeat).toBeLessThan(0.5);
    within(body('Earth').precessionPeriod / (1000 * YEAR), 25.8, 5, "Earth's axial precession period (kyr)");
    // Lunar recession: measured 3.8 cm/yr today, ~2 cm/yr averaged over geological time.
    const earth = body('Earth'),
      moon = body('Moon');
    const a = () => orbitFromState(V3.sub(moon.pos, earth.pos), V3.sub(moon.vel, earth.vel), G * (earth.mass + moon.mass), 0).a;
    const day0 = earth.rotationPeriod;
    sim.speed = 1e6 * YEAR;
    let a0 = 0,
      a1 = 0;
    for (let i = 0; i < 30; i++) sim.update(1 / 30);
    a0 = a();
    const t0 = sim.time;
    for (let i = 0; i < 300; i++) sim.update(1 / 30);
    a1 = a();
    const cmPerYr = ((a1 - a0) / ((sim.time - t0) / YEAR)) * 100;
    within(cmPerYr, 2.5, 1.5, 'lunar recession (cm/yr)');
    expect(earth.rotationPeriod).toBeGreaterThan(day0); // the day lengthens
  });
});

describe('validation: the climate does not depend on the time step', () => {
  it('Earth agrees between 12-hour weather steps and week-long seasonal steps', () => {
    const run = (dt: number, years: number) => {
      const c = spinUp(EARTH, 6);
      let t = 0,
        sum = 0,
        n = 0;
      const steps = Math.round((years * YEAR) / dt);
      for (let i = 0; i < steps; i++) {
        c.step(dt, ctxFor(EARTH, [illum(EARTH, ((t / YEAR) % 1) * 2 * Math.PI, -((t / DAY) % 1) * 2 * Math.PI)], t));
        t += dt;
        if (i >= steps / 2) {
          sum += c.stats.meanT;
          n++;
        }
      }
      return sum / n;
    };
    const weather = run(DAY / 2, 4);
    const seasonal = run(YEAR / 48, 4);
    expect(Math.abs(weather - seasonal), `weather ${weather.toFixed(1)} K vs seasonal ${seasonal.toFixed(1)} K`).toBeLessThan(3);
  });

  const advance = (c: ReturnType<typeof spinUp>, t0: number, years: number, dtOf: (i: number) => number) => {
    let t = t0,
      i = 0,
      sum = 0,
      n = 0;
    while (t < t0 + years * YEAR) {
      const dt = dtOf(i++);
      c.step(dt, ctxFor(EARTH, [illum(EARTH, ((t / YEAR) % 1) * 2 * Math.PI, -((t / DAY) % 1) * 2 * Math.PI)], t));
      t += dt;
      if (t > t0 + (years - 3) * YEAR) {
        sum += c.stats.meanT * dt;
        n += dt;
      }
    }
    return { t, T: sum / n };
  };

  it('switching to the fast band model continues from the same climate', () => {
    const c = spinUp(EARTH, 6);
    const a = advance(c, 0, 25, () => YEAR / 30);
    const b = advance(c, a.t, 300, () => YEAR);
    expect(c.mode).toBe('simple');
    expect(Math.abs(b.T - a.T), `seasonal ${a.T.toFixed(1)} K → band model ${b.T.toFixed(1)} K`).toBeLessThan(1.5);
  });

  it('uneven step lengths (background worlds at high speed) do not freeze Earth', () => {
    const c = spinUp(EARTH, 6);
    const a = advance(c, 0, 25, () => YEAR / 30);
    // Steps from 12 to 98 days in a shuffled order: straddles the seasonal / band-model boundary.
    const b = advance(c, a.t, 200, (i) => 12.2 * (1 + ((i * 7919) % 8)) * DAY);
    expect(c.stats.iceFrac).toBeLessThan(0.25);
    expect(Math.abs(b.T - a.T), `even steps ${a.T.toFixed(1)} K vs uneven ${b.T.toFixed(1)} K`).toBeLessThan(3);
  });
});

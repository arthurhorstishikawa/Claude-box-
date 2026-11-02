import { describe, expect, it } from 'vitest';
import { YEAR } from '../src/core/constants';
import { generateTerrain } from '../src/climate/terrain';
import { TerrestrialClimate } from '../src/climate/terrestrial';
import { findScenario } from '../src/sim/scenarios';
import { Simulation } from '../src/sim/simulation';
import { ctxFor, EARTH, illum, spinUp } from './helpers';

describe('new world dynamics', () => {
  it("precesses Earth's axis in roughly 26 000 years", () => {
    const sim = new Simulation();
    sim.loadScenario(findScenario('earthmoon'));
    sim.update(1 / 30);
    const e = sim.bodies.find((b) => b.name === 'Earth')!;
    const kyr = e.precessionPeriod / (1000 * YEAR);
    expect(kyr).toBeGreaterThan(15);
    expect(kyr).toBeLessThan(40);
  });

  it('runs wind-driven ocean gyres', () => {
    const c = spinUp(EARTH, 1);
    let vmax = 0;
    for (let k = 0; k < c.grid.N; k++) vmax = Math.max(vmax, Math.abs(c.vo[k]));
    expect(vmax).toBeGreaterThan(0.02);
    expect(c.stats.meanT).toBeGreaterThan(278);
  });

  it('cools after a large eruption', () => {
    const a = spinUp(EARTH, 2);
    const b = spinUp(EARTH, 2);
    b.eruption(0.2, 1, 7);
    let t = 0;
    for (let s = 0; s < 24; s++) {
      const dt = YEAR / 24;
      const ls = ((s + 0.5) / 24) * 2 * Math.PI;
      a.step(dt, ctxFor(EARTH, [illum(EARTH, ls)], t));
      b.step(dt, ctxFor(EARTH, [illum(EARTH, ls)], t));
      t += dt;
    }
    expect(a.stats.meanT - b.stats.meanT).toBeGreaterThan(0.3);
  });

  it('evolves microbes into an oxygenated, living world over a few billion years', () => {
    const w = { ...EARTH, init: { ...EARTH.init, biosphere: false, atmosphere: { N2: 80000, CO2: 2000, Ar: 900 } } };
    const c = spinUp(w, 1);
    expect(c.lifeStage).toBe(0);
    c.lifeStage = 1;
    let t = 0;
    // Geology on: volcanic CO₂ thaws the snowball that oxygenation can trigger (as on Earth).
    for (let n = 0; n < 700; n++) {
      const dt = 5e6 * YEAR;
      c.step(dt, ctxFor(w, [illum(w, 0)], t, { geology: true }));
      t += dt;
    }
    expect(c.lifeStage).toBeGreaterThanOrEqual(3);
    expect((c.bulk.pp.O2 ?? 0) / c.P).toBeGreaterThan(0.05);
  });

  it('drifts continents with plate motion', () => {
    const a = generateTerrain('earthlike', 9, 128, 64, 0);
    const b = generateTerrain('earthlike', 9, 128, 64, 150);
    let diff = 0,
      landA = 0,
      landB = 0;
    for (let k = 0; k < a.elev.length; k++) {
      if ((a.elev[k] > 0) !== (b.elev[k] > 0)) diff++;
      if (a.elev[k] > 0) landA++;
      if (b.elev[k] > 0) landB++;
    }
    expect(diff / a.elev.length).toBeGreaterThan(0.1);
    expect(Math.abs(landA - landB) / a.elev.length).toBeLessThan(0.15);
  });
});
void TerrestrialClimate;

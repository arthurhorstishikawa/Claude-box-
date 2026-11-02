import { describe, expect, it } from 'vitest';
import { DAY, YEAR } from '../src/core/constants';
import { V3 } from '../src/core/vec3';
import { TerrestrialClimate } from '../src/climate/terrestrial';
import { makeSmallBody } from '../src/sim/factory';
import { findScenario } from '../src/sim/scenarios';
import { loadSim, serializeSim } from '../src/sim/save';
import { Simulation } from '../src/sim/simulation';

function earthMoon() {
  const sim = new Simulation();
  sim.loadScenario(findScenario('earthmoon'));
  return sim;
}

describe('simulation', () => {
  it('loads Earth near 288 K with a modern civilization', () => {
    const sim = earthMoon();
    const earth = sim.bodies.find((b) => b.name === 'Earth')!;
    const c = earth.climate as TerrestrialClimate;
    expect(c.stats.meanT).toBeGreaterThan(280);
    expect(c.stats.meanT).toBeLessThan(296);
    sim.speed = 30 * DAY;
    for (let i = 0; i < 60; i++) sim.update(1 / 30);
    expect(c.civ).not.toBeNull();
    expect(c.civ!.totalPop).toBeGreaterThan(1e9);
    expect(c.civ!.emissions).toBeGreaterThan(0);
  });

  it('carves a crater where an asteroid hits', () => {
    const sim = earthMoon();
    const moon = sim.bodies.find((b) => b.name === 'Moon')!;
    const c = moon.climate as TerrestrialClimate;
    const rock = makeSmallBody('Impactor', 4e16, 1.5e4, false, 9);
    const dir = new V3(1, 0.2, 0.1).normalize();
    rock.pos.copy(moon.pos).addScaled(dir, moon.radius + 2e5);
    rock.vel.copy(moon.vel).addScaled(dir, -2e4);
    sim.addBody(rock);
    let hits = 0;
    sim.events.on('impact', () => hits++);
    sim.speed = 60;
    for (let i = 0; i < 60 && hits === 0; i++) sim.update(1 / 30);
    expect(hits).toBe(1);
    expect(c.craters.length).toBe(1);
    expect(c.craters[0].diameter).toBeGreaterThan(5e4);
    expect(sim.bodies.includes(rock)).toBe(false);
  });

  it('round-trips a save', () => {
    const sim = earthMoon();
    sim.speed = YEAR / 10;
    for (let i = 0; i < 10; i++) sim.update(1 / 30);
    const json = serializeSim(sim);
    const sim2 = new Simulation();
    loadSim(sim2, json);
    expect(sim2.bodies.length).toBe(sim.bodies.length);
    const e1 = sim.bodies.find((b) => b.name === 'Earth')!;
    const e2 = sim2.bodies.find((b) => b.name === 'Earth')!;
    expect(e2.pos.distTo(e1.pos)).toBeLessThan(1);
    expect(Math.abs((e2.climate as TerrestrialClimate).stats.meanT - (e1.climate as TerrestrialClimate).stats.meanT)).toBeLessThan(15);
  });
});

import { describe, expect, it } from 'vitest';
import { AU, DAY, L_SUN, YEAR } from '../src/core/constants';
import { TerrestrialClimate } from '../src/climate/terrestrial';
import { habitableZone } from '../src/stars/habitableZone';
import { generateSystem, randomPlanet, systemScenario, type StarPreset } from '../src/sim/generator';
import { findScenario } from '../src/sim/scenarios';
import { Simulation } from '../src/sim/simulation';

describe('brown dwarfs', () => {
  it('have a habitable zone that shrinks as they cool', () => {
    const sim = new Simulation();
    sim.loadScenario(findScenario('ember'));
    const bd = sim.bodies.find((b) => b.name === 'Ember')!;
    expect(bd.kind).toBe('brownDwarf');
    const hz0 = habitableZone(bd.star!.L, bd.star!.T);
    expect(hz0.inner / AU).toBeGreaterThan(0.005);
    expect(hz0.outer / AU).toBeLessThan(0.05);
    const L0 = bd.star!.L;
    bd.star!.age += 3e8 * YEAR;
    sim.bodyChanged(bd);
    sim.update(0); // refresh
    expect(bd.star!.L).toBeLessThan(L0 * 0.75);
  });

  it('keep Hearth temperate on its day side', () => {
    const sim = new Simulation();
    sim.loadScenario(findScenario('ember'));
    const hearth = sim.bodies.find((b) => b.name === 'Hearth')!;
    const c = hearth.climate as TerrestrialClimate;
    console.log(`Hearth: mean ${c.stats.meanT.toFixed(1)} K, ice ${(c.stats.iceFrac * 100).toFixed(0)}%, flux ${(sim.illuminators(hearth)[0].meanFlux).toFixed(0)} W/m²`);
    expect(c.stats.meanT).toBeGreaterThan(245);
    expect(c.stats.meanT).toBeLessThan(310);
    expect(c.stats.maxT).toBeGreaterThan(275);
  });
});

describe('system generator', () => {
  const presets: StarPreset[] = ['G', 'K', 'M', 'ultracool', 'browndwarf', 'F', 'A', 'whitedwarf', 'binary', 'random'];
  it('builds stable, varied systems with a habitable world when asked', () => {
    for (const star of presets)
      for (let seed = 1; seed <= 4; seed++) {
        const g = generateSystem({ seed, star, planets: -1, habitable: true, life: true, civilization: 'none', moons: true, belt: true });
        expect(g.bodies.length).toBeGreaterThan(1);
        const host = g.bodies[0];
        expect(host.star).toBeTruthy();
        // No body starts inside another.
        for (let i = 0; i < g.bodies.length; i++)
          for (let j = i + 1; j < g.bodies.length; j++) {
            const a = g.bodies[i],
              b = g.bodies[j];
            expect(a.pos.distTo(b.pos)).toBeGreaterThan(a.radius + b.radius);
          }
        const focus = g.bodies.find((b) => b.name === g.focus)!;
        expect(focus).toBeTruthy();
        if (star !== 'whitedwarf' && star !== 'random') {
          const L = g.bodies.filter((b) => b.star).reduce((s, b) => s + (b.star!.L ?? 0), 0);
          const hz = habitableZone(L, host.star!.T);
          const a = focus.pos.distTo(host.pos);
          expect(focus.world, `${star}/${seed}: focus ${g.focus} is a world`).toBeTruthy();
          expect(a, `${star}/${seed}`).toBeGreaterThan(hz.optimisticInner * 0.9);
          expect(a, `${star}/${seed}`).toBeLessThan(hz.optimisticOuter * 1.1);
        }
        void L_SUN;
      }
  });

  it('spaces planets for long-term stability and survives a few hundred orbits', () => {
    for (const star of ['browndwarf', 'M', 'G', 'binary'] as StarPreset[])
      for (const seed of [11, 12, 13]) {
        const sim = new Simulation();
        const sc = systemScenario({ seed, star, planets: 7, habitable: true, life: false, civilization: 'none', moons: false, belt: false });
        sim.loadScenario(sc);
        const n0 = sim.bodies.length;
        let impacts = 0;
        sim.events.on('impact', () => impacts++);
        sim.events.on('merge', () => impacts++);
        // ~300 orbits of the innermost planet.
        const host = sim.bodies[0];
        const inner = sim.bodies.find((b) => !b.isStarLike)!;
        const P = 2 * Math.PI * Math.sqrt(inner.pos.distTo(host.pos) ** 3 / (6.674e-11 * host.mass));
        sim.speed = (P * 300) / 60;
        for (let i = 0; i < 60; i++) sim.update(1);
        expect(impacts, `${star}/${seed}`).toBe(0);
        expect(sim.bodies.length, `${star}/${seed}`).toBe(n0);
      }
  });

  it('loads as a scenario and runs', () => {
    const sim = new Simulation();
    const sc = systemScenario({ seed: 7, star: 'K', planets: 5, habitable: true, life: true, civilization: 'preindustrial', moons: true, belt: false });
    sim.loadScenario(sc);
    expect(sim.focus()?.name).toBe(sc.focus);
    sim.speed = DAY;
    for (let i = 0; i < 20; i++) sim.update(1 / 30);
    const f = sim.focus()!;
    expect(f.climate).toBeInstanceOf(TerrestrialClimate);
    const c = f.climate as TerrestrialClimate;
    console.log(`${sc.name}: ${sc.summary} → ${f.name} ${c.stats.meanT.toFixed(1)} K`);
    expect(c.stats.meanT).toBeGreaterThan(230);
    expect(c.stats.meanT).toBeLessThan(330);
  });
});

describe('random planet generator', () => {
  it('adds rocky and gas planets on stable orbits around an existing star', () => {
    const sim = new Simulation();
    sim.loadScenario(findScenario('solar'));
    const sun = sim.bodies.find((b) => b.name === 'Sun')!;
    for (const kind of ['rocky', 'gas'] as const)
      for (let seed = 1; seed <= 6; seed++) {
        const existing = sim.bodies.filter((b) => b !== sun && !b.isStarLike && sim.primaryOf(b) === sun).map((b) => ({ a: b.pos.distTo(sun.pos), m: b.mass }));
        const p = randomPlanet(kind, sun, existing, seed);
        if (!p) continue; // the system can fill up
        expect(kind === 'gas' ? p.isGiant : !!p.world).toBe(true);
        const a = p.pos.distTo(sun.pos);
        for (const e of existing) expect(Math.abs(Math.log(a / e.a))).toBeGreaterThan(0.05);
        sim.addBody(p);
      }
  });
});

describe('advanced civilizations', () => {
  it('adopt climate policy, terraform a neighbour and send a colony ship to another star', () => {
    const sim = new Simulation();
    sim.loadScenario(findScenario('neighbors'));
    expect(sim.bodies.filter((b) => b.star).length).toBe(2);
    const msgs: string[] = [];
    sim.events.on('notify', (n) => msgs.push(n.msg));
    sim.speed = 100 * YEAR;
    for (let i = 0; i < 30 * 16 && !msgs.some((m) => /colony ship/.test(m)); i++) sim.update(1 / 30);
    expect(msgs.some((m) => /carbon-free/.test(m))).toBe(true);
    expect(msgs.some((m) => /begun terraforming/.test(m))).toBe(true);
    expect(msgs.some((m) => /launched a colony ship/.test(m))).toBe(true);
  });
});

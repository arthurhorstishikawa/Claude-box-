import { describe, expect, it } from 'vitest';
import { YEAR } from '../src/core/constants';
import { TerrestrialClimate } from '../src/climate/terrestrial';
import { findScenario } from '../src/sim/scenarios';
import { Simulation } from '../src/sim/simulation';

describe('empires', () => {
  it('rival civilizations expand, meet, go to war and make peace', () => {
    const sim = new Simulation();
    sim.settings.climateQuality = 'low';
    const news: string[] = [];
    sim.events.on('notify', (n) => news.push(n.msg));
    const falls = new Map<string, number>();
    let flips = 0;
    sim.events.on('notify', (n) => {
      const m = n.msg.match(/🏴 (.*) has fallen to/);
      if (!m) return;
      if (falls.has(m[1]) && sim.time - falls.get(m[1])! < 100 * YEAR) flips++;
      falls.set(m[1], sim.time);
    });
    sim.loadScenario(findScenario('rivals'));
    const book = sim.agency.empires;
    const homes = sim.bodies.filter((b) => b.climate instanceof TerrestrialClimate && b.climate.civ);
    expect(homes.length).toBe(2);
    // Each home world is populated and flies its own flag.
    const ids = homes.map((b) => (b.climate as TerrestrialClimate).civ!.empire);
    expect(new Set(ids).size).toBe(2);
    sim.speed = 5 * YEAR;
    let war = false,
      peace = false;
    for (let i = 0; i < 30 * 160 && !(war && peace); i++) {
      sim.update(1 / 30);
      war ||= news.some((m) => m.includes('declared war'));
      peace ||= war && news.some((m) => m.includes('Peace between'));
    }
    const text = news.join('\n');
    expect(text, text).toContain('First contact');
    expect(war, text).toBe(true);
    expect(peace, text).toBe(true);
    // The war was fought: stations raided, fleets sent or worlds taken.
    expect(/destroyed the .*terraforming stations|war fleet|has fallen to/.test(text), text).toBe(true);
    for (const b of homes) expect((b.climate as TerrestrialClimate).civ!.totalPop).toBeGreaterThan(1e8);
    // Conquered worlds are held: no world changes hands twice within a century.
    expect(flips, text).toBe(0);
    expect(book.list.filter((e) => e.alive).length).toBeGreaterThanOrEqual(2);
  }, 240e3);

  it('save and load keep empires, relations and ownership', () => {
    const sim = new Simulation();
    sim.settings.climateQuality = 'low';
    sim.loadScenario(findScenario('rivals'));
    const [a, b] = sim.agency.empires.list;
    sim.agency.empires.declareWar(a, b);
    const saved = JSON.parse(JSON.stringify(sim.agency.serialize()));
    sim.agency.reset();
    sim.agency.restore(saved);
    const [a2, b2] = sim.agency.empires.list;
    expect(a2.name).toBe(a.name);
    expect(a2.relations[b2.id].war).toBe(true);
    // One shared relation object per pair.
    expect(a2.relations[b2.id]).toBe(b2.relations[a2.id]);
  });
});

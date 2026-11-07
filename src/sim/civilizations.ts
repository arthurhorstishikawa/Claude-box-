import { AU, YEAR } from '../core/constants';
import { clamp } from '../core/math';
import type { Body } from '../physics/body';
import { TerrestrialClimate } from '../climate/terrestrial';

const C_LIGHT = 2.998e8;
/** Colony-ship cruise speed (fraction of light speed). */
export const SHIP_SPEED = 0.03;

export interface Terraform {
  target: number;
  by: number;
  started: number;
  /** Name of the civilization doing it (kept if the home world is lost). */
  owner: string;
}

export interface Voyage {
  from: number;
  fromStar: number;
  toStar: number;
  depart: number;
  arrive: number;
  owner: string;
  /** Departure point (the home star's position at launch, physics frame). */
  origin: { x: number; y: number; z: number };
}

/** What the agency needs from the simulation. */
export interface CivHost {
  bodies: Body[];
  time: number;
  primaryOf(b: Body): Body | null;
  getBody(id: number | null): Body | null;
  notify(msg: string, level: 'info' | 'warn' | 'danger' | 'success', bodyId?: number): void;
}

const climateOf = (b: Body | null): TerrestrialClimate | null => (b && b.climate instanceof TerrestrialClimate ? b.climate : null);

/**
 * What advanced civilizations do with their technology:
 *  - keep their home world temperate with orbital sunshades or mirrors as their star changes;
 *  - terraform the most promising world of their system — thicken its air, warm or cool it,
 *    import water with comets, then add oxygen and seed life — and settle it when habitable;
 *  - evacuate to colonies if their home world becomes uninhabitable;
 *  - eventually send colony ships to other star systems (at 3% of light speed).
 * Rates are deliberately those of an extremely capable civilization: centuries, not aeons.
 */
export class CivAgency {
  projects: Terraform[] = [];
  voyages: Voyage[] = [];
  /** Star systems colony ships have already reached. */
  reached: number[] = [];
  private clock = new Map<number, number>();

  constructor(private host: CivHost) {}

  reset(): void {
    this.projects = [];
    this.voyages = [];
    this.reached = [];
    this.clock.clear();
  }

  starOf(b: Body | null): Body | null {
    for (let x = b, n = 0; x && n < 8; x = this.host.primaryOf(x), n++) if (x.star) return x;
    return null;
  }

  /** Called after each climate step of a world with a civilization. */
  act(home: Body, c: TerrestrialClimate, dt: number): void {
    const civ = c.civ;
    if (!civ || dt <= 0) return;
    const yr = dt / YEAR;
    const spacefaring = civ.era === 'clean' && civ.tech >= 2.1;
    if (!spacefaring) return;
    const skill = clamp((civ.tech - 2) * 4, 0.3, 3);
    // 1. Home climate maintenance with sunshades (too warm) or mirrors (too cold).
    const T = c.stats.meanT;
    if (T > 296) home.insolationFactor = Math.max(0.3, home.insolationFactor * Math.exp(-0.0004 * skill * yr * clamp((T - 292) / 10, 0, 3)));
    else if (T < 280 && c.oceanMass() > 0) home.insolationFactor = Math.min(1.6, home.insolationFactor * Math.exp(0.0004 * skill * yr * clamp((284 - T) / 10, 0, 3)));
    // 2. Evacuation if the home world is failing anyway.
    if (c.stats.humanHabitable < 0.03 && civ.totalPop > 1e5) {
      const dest = this.bestColony(home);
      if (dest) {
        this.settle(dest, civ.name, Math.min(civ.totalPop * 0.2, 1e9), home);
        civ.pop.fill(0);
        civ.totalPop = 0;
        civ.era = 'collapsed';
        this.host.notify(`${home.name} has become uninhabitable — its people have evacuated to ${dest.name}.`, 'danger', dest.id);
      }
    }
    // 3. Start a terraforming project (one at a time per civilization), every few centuries.
    const t0 = this.clock.get(home.id) ?? -Infinity;
    if (this.host.time - t0 > 300 * YEAR && !this.projects.some((p) => p.by === home.id)) {
      this.clock.set(home.id, this.host.time);
      const habitable = this.bestColony(home);
      if (habitable && !climateOf(habitable)?.civ) this.settle(habitable, civ.name, 1e6, home);
      else {
        const target = this.bestTerraformTarget(this.starOf(home), home);
        if (target) {
          this.projects.push({ target: target.id, by: home.id, started: this.host.time, owner: civ.name });
          this.host.notify(`${civ.name === 'Global civilization' ? home.name : civ.name} has begun terraforming ${target.name}.`, 'info', target.id);
        }
      }
    }
    // 4. Interstellar colony ships once the technology allows.
    if (civ.tech >= 2.45 && !this.voyages.some((v) => v.from === home.id)) {
      const lastShip = this.clock.get(-home.id) ?? -Infinity;
      if (this.host.time - lastShip > 500 * YEAR) this.launch(home, civ.name);
    }
  }

  /** Advance terraforming projects and voyages (every simulation step). */
  update(dt: number): void {
    const yr = dt / YEAR;
    if (yr <= 0) return;
    for (const p of [...this.projects]) {
      const target = this.host.getBody(p.target);
      const c = climateOf(target);
      if (!target || !c) {
        this.projects.splice(this.projects.indexOf(p), 1);
        continue;
      }
      if (this.terraformStep(target, c, yr)) {
        this.projects.splice(this.projects.indexOf(p), 1);
        const took = (this.host.time - p.started) / YEAR;
        const who = p.owner === 'Global civilization' ? this.host.getBody(p.by)?.name ?? 'its builders' : p.owner;
        this.host.notify(`${target.name} is now habitable — terraformed by ${who} in ${took < 1e4 ? Math.round(took) + ' years' : (took / 1e3).toFixed(0) + ' thousand years'}. A colony has been founded.`, 'success', target.id);
        this.settle(target, p.owner, 1e6, this.host.getBody(p.by));
      }
    }
    for (const v of [...this.voyages]) {
      if (this.host.time < v.arrive) continue;
      this.voyages.splice(this.voyages.indexOf(v), 1);
      this.arrive(v);
    }
  }

  /**
   * One step of terraforming. Order: atmosphere pressure, temperature, water, then oxygen and
   * life. Returns true once the world is habitable.
   */
  private terraformStep(b: Body, c: TerrestrialClimate, yr: number): boolean {
    const pp = c.bulk?.pp ?? ({} as Record<string, number>);
    const T = c.stats.meanT;
    const P = c.P;
    const need = (have: number, want: number, rate: number) => Math.max(0, Math.min(want - have, rate * yr));
    // Thicken the air with nitrogen (ammonia-rich comets, mined volatiles).
    if (P < 7e4) c.addGasPressure('N2', need(P, 8e4, 400));
    // Warm a cold world: CO₂ and super-greenhouse gases, plus orbital mirrors.
    if (T < 278) {
      c.addGasPressure('CO2', need(pp.CO2 ?? 0, 2e4, 150));
      c.addGasPressure('CFC', need(pp.CFC ?? 0, 2, 0.01));
      b.insolationFactor = Math.min(1.8, b.insolationFactor * Math.exp(0.0003 * yr));
    }
    // Cool a hot world: sunshade and draw CO₂ down (and, for Venuses, sequester the excess air).
    if (T > 305) {
      b.insolationFactor = Math.max(0.25, b.insolationFactor * Math.exp(-0.0005 * yr));
      if ((pp.CO2 ?? 0) > 2000) c.addGasPressure('CO2', -Math.min((pp.CO2 ?? 0) - 1000, 0.002 * yr * (pp.CO2 ?? 0) + 200 * yr));
      if ((pp.SO2 ?? 0) > 0) c.addGasPressure('SO2', -Math.min(pp.SO2 ?? 0, 5 * yr));
    }
    // Water: steer icy comets in (≈ a few metres of global ocean per year).
    const waterGEL = c.waterTotal / (c.vol.rhoLiquid * 4 * Math.PI * b.radius * b.radius);
    if (c.vol.id === 'H2O' && waterGEL < 800 && T > 250) c.addVolatile(Math.min(800 - waterGEL, 3 * yr));
    // Oxygen and life once the world is warm and wet.
    const warm = T > 270 && T < 308 && P > 5e4;
    if (warm && c.oceanMass() > 0) {
      c.addGasPressure('O2', need(pp.O2 ?? 0, 2.1e4, 300));
      if (c.lifeStage < 4) {
        c.lifeStage = 4;
        c.biosphere = true;
      }
    }
    return warm && c.breathable() && c.oceanMass() > 0;
  }

  /** Best already-habitable world of the same system without people. */
  private bestColony(home: Body): Body | null {
    const sun = this.starOf(home);
    let best: Body | null = null,
      score = -Infinity;
    for (const b of this.host.bodies) {
      const c = climateOf(b);
      if (b === home || !c || c.civ || this.starOf(b) !== sun) continue;
      const s = c.stats.humanHabitable;
      if (s > 0.05 && s > score) {
        score = s;
        best = b;
      }
    }
    return best;
  }

  /** The most promising world to terraform around `star`: rocky, big enough, not too hot or cold. */
  private bestTerraformTarget(star: Body | null, exclude: Body | null): Body | null {
    if (!star) return null;
    let best: Body | null = null,
      score = -Infinity;
    for (const b of this.host.bodies) {
      const c = climateOf(b);
      if (!c || b === exclude || c.civ || this.starOf(b) !== star || this.projects.some((p) => p.target === b.id)) continue;
      const mE = b.mass / 5.972e24;
      if (mE < 0.03 || mE > 8 || c.stats.meanT > 1000 || c.stats.meanT < 40) continue;
      // Prefer worlds that need the least work: close to 288 K, Earth-like gravity.
      const s = -Math.abs(Math.log(Math.max(c.stats.meanT, 1) / 288)) * 3 - Math.abs(Math.log(mE)) * 0.4 + (c.oceanMass() > 0 ? 0.5 : 0);
      if (s > score) {
        score = s;
        best = b;
      }
    }
    return best;
  }

  /** Found (or reinforce) a colony on a world. */
  private settle(b: Body, owner: string, people: number, from: Body | null): void {
    const c = climateOf(b);
    if (!c) return;
    if (!c.civ) {
      c.seedCivilization('emergent');
      c.civ!.tech = 2.1;
      c.civ!.era = 'clean';
      c.civ!.name = owner === 'Global civilization' && from ? `Colony of ${from.name}` : `${owner} colony`;
      c.civ!.seedPopulation = people;
      if (from) this.host.notify(`Colonists from ${from.name} have settled ${b.name}!`, 'success', b.id);
    } else c.civ.seedPopulation += people;
  }

  /** Launch a colony ship toward the nearest other star system. */
  private launch(home: Body, owner: string): void {
    const sun = this.starOf(home);
    if (!sun) return;
    const visited = new Set([...this.voyages.map((v) => v.toStar), ...this.reached]);
    let best: Body | null = null,
      dmin = Infinity;
    for (const s of this.host.bodies) {
      if (!s.star || s === sun || visited.has(s.id) || s.kind === 'blackHole' || s.kind === 'neutronStar') continue;
      const d = s.pos.distTo(sun.pos);
      // Another system: far beyond the home system's planets (not a close binary companion).
      if (d < 2000 * AU) continue;
      // Skip systems where this civilization already lives.
      if (this.host.bodies.some((b) => climateOf(b)?.civ && this.starOf(b) === s)) continue;
      if (d < dmin) {
        dmin = d;
        best = s;
      }
    }
    this.clock.set(-home.id, this.host.time);
    if (!best) return;
    const travel = dmin / (SHIP_SPEED * C_LIGHT);
    this.voyages.push({ from: home.id, fromStar: sun.id, toStar: best.id, depart: this.host.time, arrive: this.host.time + travel, owner, origin: { x: sun.pos.x, y: sun.pos.y, z: sun.pos.z } });
    const ly = dmin / 9.4607e15;
    this.host.notify(`🚀 ${home.name} has launched a colony ship to ${best.name}, ${ly < 0.1 ? (dmin / AU).toFixed(0) + ' AU' : ly.toFixed(2) + ' light-years'} away. Arrival in ${Math.round(travel / YEAR)} years.`, 'success', home.id);
  }

  private arrive(v: Voyage): void {
    const star = this.host.getBody(v.toStar);
    if (!star) return;
    if (!this.reached.includes(star.id)) this.reached.push(star.id);
    const home = this.host.getBody(v.from);
    // A ready-made home if there is one, otherwise begin terraforming the best candidate.
    let dest: Body | null = null,
      score = -Infinity;
    for (const b of this.host.bodies) {
      const c = climateOf(b);
      if (!c || c.civ || this.starOf(b) !== star) continue;
      if (c.stats.humanHabitable > score) {
        score = c.stats.humanHabitable;
        dest = b;
      }
    }
    if (dest && score > 0.05) {
      this.settle(dest, v.owner, 1e5, home);
      this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name} and settled ${dest.name}!`, 'success', dest.id);
      return;
    }
    const target = this.bestTerraformTarget(star, null);
    if (target) {
      this.projects.push({ target: target.id, by: home?.id ?? -1, started: this.host.time, owner: v.owner });
      this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name}. Living in orbit, the settlers have begun terraforming ${target.name}.`, 'success', target.id);
    } else this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name}; with no world to settle, its people live in orbital habitats.`, 'info', star.id);
  }

  serialize(): unknown {
    return { projects: this.projects, voyages: this.voyages, reached: this.reached };
  }

  restore(o: any): void {
    this.projects = o?.projects ?? [];
    this.voyages = o?.voyages ?? [];
    this.reached = o?.reached ?? [];
  }
}

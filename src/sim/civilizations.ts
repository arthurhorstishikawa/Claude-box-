import { AU, YEAR } from '../core/constants';
import { clamp } from '../core/math';
import type { Body } from '../physics/body';
import { TerrestrialClimate } from '../climate/terrestrial';
import { Empires, type Empire } from './empires';

const C_LIGHT = 2.998e8;
/** Colony-ship cruise speed (fraction of light speed). */
export const SHIP_SPEED = 0.03;

export interface Terraform {
  target: number;
  by: number;
  started: number;
  /** Name of the civilization doing it (kept if the home world is lost). */
  owner: string;
  /** Empire that will own the new world. */
  empire?: number;
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
  /** A colony ship (default) or a war fleet. */
  kind?: 'colony' | 'fleet';
  empire?: number;
  /** War fleets: the empire they are sent against, and their fighting strength. */
  enemy?: number;
  strength?: number;
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
  /** Worlds whose terraforming was abandoned (not tried again). */
  failed: number[] = [];
  private clock = new Map<number, number>();
  /** Empires, diplomacy and war between civilizations. */
  empires: Empires;

  constructor(private host: CivHost) {
    const self = this;
    this.empires = new Empires({
      get bodies() {
        return host.bodies;
      },
      get time() {
        return host.time;
      },
      getBody: (id) => host.getBody(id),
      starOf: (b) => self.starOf(b),
      notify: (m, l, id) => host.notify(m, l, id),
      launchFleet: (from, target, e, enemy, strength) => self.launchFleet(from, target, e, enemy, strength),
      fleetsOf: (id) => self.voyages.filter((v) => v.kind === 'fleet' && v.empire === id).map((v) => ({ toStar: v.toStar, enemy: v.enemy ?? 0 })),
      projectsOf: (id) => self.projects.filter((p) => p.empire === id).map((p) => ({ target: p.target, star: self.starOf(host.getBody(p.target))?.id ?? null })),
      cancelProject: (target) => {
        self.projects = self.projects.filter((p) => p.target !== target);
      },
    });
  }

  reset(): void {
    this.projects = [];
    this.voyages = [];
    this.reached = [];
    this.failed = [];
    this.clock.clear();
    this.empires.reset();
  }

  empireOf(b: Body | null): Empire | undefined {
    const civ = climateOf(b)?.civ;
    return civ ? this.empires.get(civ.empire) : undefined;
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
    const empire = this.empires.ensure(home, civ);
    const spacefaring = civ.era === 'clean' && civ.tech >= 2.1;
    if (!spacefaring) return;
    const skill = clamp((civ.tech - 2) * 4, 0.3, 3);
    // 1. Keep the world temperate: sunshades when too warm, mirrors when too cold (the same
    // steering that terraformed it), and draw CO₂ back down if it becomes unbreathable.
    const T = c.stats.meanT;
    if (T > 295 || T < 281) home.insolationFactor = clamp(home.insolationFactor * Math.exp(clamp(-0.0005 * skill * yr * clamp((T - 288) / 10, -3, 3), -0.3, 0.3)), 0.1, 3);
    const co2 = c.bulk?.pp.CO2 ?? 0;
    if (co2 > 2500) c.addGasPressure('CO2', -Math.min(co2 - 1500, (0.004 * co2 + 200) * yr));
    // 2. Evacuation if the home world is failing anyway.
    if (c.stats.humanHabitable < 0.03 && civ.totalPop > 1e5) {
      const dest = this.bestColony(home);
      if (dest) {
        this.settle(dest, civ.name, Math.min(civ.totalPop * 0.2, 1e9), home, empire.id);
        civ.pop.fill(0);
        civ.totalPop = 0;
        civ.era = 'collapsed';
        this.host.notify(`${home.name} has become uninhabitable — its people have evacuated to ${dest.name}.`, 'danger', dest.id);
      }
    }
    // 3. Expand: settle or terraform a world of the system (one project at a time per world).
    const t0 = this.clock.get(home.id) ?? -Infinity;
    if (this.host.time - t0 > 200 * YEAR && !this.projects.some((p) => p.by === home.id)) {
      this.clock.set(home.id, this.host.time);
      const habitable = this.bestColony(home);
      if (habitable && !climateOf(habitable)?.civ) this.settle(habitable, civ.name, 1e6, home, empire.id);
      else {
        const target = this.bestTerraformTarget(this.starOf(home), home);
        if (target) {
          this.projects.push({ target: target.id, by: home.id, started: this.host.time, owner: civ.name, empire: empire.id });
          this.empires.settled(empire, target);
          this.host.notify(`The ${empire.name} has begun terraforming ${target.name}.`, 'info', target.id);
        }
      }
    }
    // 4. Interstellar colony ships once the technology allows (colonies send their own, too).
    if (civ.tech >= 2.45 && !this.voyages.some((v) => v.from === home.id && v.kind !== 'fleet')) {
      const lastShip = this.clock.get(-home.id) ?? -Infinity;
      if (this.host.time - lastShip > 300 * YEAR) this.launch(home, civ.name, empire);
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
      if ((this.host.time - p.started) / YEAR > 3000) {
        // Some worlds defeat even a star-faring civilization.
        this.projects.splice(this.projects.indexOf(p), 1);
        this.failed.push(target.id);
        this.host.notify(`Terraforming ${target.name} has been abandoned after 3000 years: it is too ${c.stats.meanT < 270 ? 'cold' : c.stats.meanT > 310 ? 'hot' : 'hostile'} to tame.`, 'warn', target.id);
        continue;
      }
      if (this.terraformStep(target, c, yr)) {
        this.projects.splice(this.projects.indexOf(p), 1);
        const took = (this.host.time - p.started) / YEAR;
        const who = p.owner === 'Global civilization' ? this.host.getBody(p.by)?.name ?? 'its builders' : p.owner;
        this.host.notify(`${target.name} is now habitable — terraformed by ${who} in ${took < 1e4 ? Math.round(took) + ' years' : (took / 1e3).toFixed(0) + ' thousand years'}. A colony has been founded.`, 'success', target.id);
        this.settle(target, p.owner, 1e6, this.host.getBody(p.by), p.empire);
      }
    }
    for (const v of [...this.voyages]) {
      if (this.host.time < v.arrive) continue;
      this.voyages.splice(this.voyages.indexOf(v), 1);
      if (v.kind === 'fleet') this.empires.fleetArrived(v.empire ?? 0, v.enemy ?? 0, v.toStar, v.strength ?? 0);
      else this.arrive(v);
    }
    this.empires.update(dt);
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
    // Temperature, steered toward ~288 K: orbital mirrors (up to 3× sunlight) or sunshades (down
    // to a tenth), adjusted gradually so the climate does not overshoot.
    const err = T - 288;
    b.insolationFactor = clamp(b.insolationFactor * Math.exp(clamp(-0.0005 * yr * clamp(err / 10, -3, 3), -0.3, 0.3)), 0.1, 3);
    if (err < -8) {
      // Engineered greenhouse gases warm without poisoning the air; CO₂ only up to what people can breathe.
      c.addGasPressure('CFC', need(pp.CFC ?? 0, 5, 0.01));
      c.addGasPressure('CO2', need(pp.CO2 ?? 0, 2000, 50));
    }
    if (err > 12) {
      if ((pp.CFC ?? 0) > 0) c.addGasPressure('CFC', -Math.min(pp.CFC ?? 0, 0.02 * yr));
      if ((pp.SO2 ?? 0) > 0) c.addGasPressure('SO2', -Math.min(pp.SO2 ?? 0, 5 * yr));
    }
    // Draw excess CO₂ down to breathable levels (and sequester a Venus's crushing air).
    if ((pp.CO2 ?? 0) > 2500 && err > -15) c.addGasPressure('CO2', -Math.min((pp.CO2 ?? 0) - 1500, 0.004 * yr * (pp.CO2 ?? 0) + 200 * yr));
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
      if (!c || b === exclude || c.civ || this.starOf(b) !== star || this.projects.some((p) => p.target === b.id) || this.failed.includes(b.id)) continue;
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
  private settle(b: Body, owner: string, people: number, from: Body | null, empireId?: number): void {
    const c = climateOf(b);
    if (!c) return;
    const empire = this.empires.get(empireId) ?? this.empireOf(from);
    if (!c.civ) {
      c.seedCivilization('emergent');
      const civ = c.civ!;
      // Settlers bring their technology with them.
      civ.tech = Math.max(2.1, (climateOf(from)?.civ?.tech ?? 2.15) - 0.05);
      civ.era = 'clean';
      civ.founded = this.host.time;
      civ.name = empire ? `${empire.name} colony` : owner === 'Global civilization' && from ? `Colony of ${from.name}` : `${owner} colony`;
      civ.seedPopulation = people;
      if (empire) civ.empire = empire.id;
      if (from) this.host.notify(`Colonists from ${from.name} have settled ${b.name}!`, 'success', b.id);
      if (empire) this.empires.settled(empire, b);
    } else c.civ.seedPopulation += people;
  }

  /** Send a war fleet toward the star system of `target`. */
  private launchFleet(from: Body, target: Body, empire: Empire, enemy: Empire, strength: number): boolean {
    const a = this.starOf(from),
      b = this.starOf(target);
    if (!a || !b || a === b) return false;
    const d = a.pos.distTo(b.pos);
    const travel = d / (SHIP_SPEED * C_LIGHT);
    this.voyages.push({ from: from.id, fromStar: a.id, toStar: b.id, depart: this.host.time, arrive: this.host.time + travel, owner: empire.name, origin: { x: a.pos.x, y: a.pos.y, z: a.pos.z }, kind: 'fleet', empire: empire.id, enemy: enemy.id, strength });
    this.host.notify(`🚀⚔ The ${empire.name} has sent a war fleet from ${from.name} against the ${enemy.name} at ${b.name}. Arrival in ${Math.round(travel / YEAR)} years.`, 'danger', from.id);
    return true;
  }

  /** Launch a colony ship toward the nearest star system this empire has not settled. */
  private launch(home: Body, owner: string, empire: Empire): void {
    const sun = this.starOf(home);
    if (!sun) return;
    const heading = new Set(this.voyages.filter((v) => v.empire === empire.id && v.kind !== 'fleet').map((v) => v.toStar));
    let best: Body | null = null,
      dmin = Infinity,
      score = Infinity;
    for (const s of this.host.bodies) {
      if (!s.star || s === sun || heading.has(s.id) || s.kind === 'blackHole' || s.kind === 'neutronStar') continue;
      const d = s.pos.distTo(sun.pos);
      // Another system: far beyond the home system's planets (not a close binary companion).
      if (d < 2000 * AU) continue;
      // Skip systems where this empire already lives; prefer ones nobody has claimed.
      const civs = this.host.bodies.filter((b) => climateOf(b)?.civ && this.starOf(b) === s);
      if (civs.some((b) => climateOf(b)!.civ!.empire === empire.id)) continue;
      // Only where there is a world to settle or terraform.
      const free = this.host.bodies.some((b) => !climateOf(b)?.civ && (climateOf(b)?.stats.humanHabitable ?? 0) > 0.05 && this.starOf(b) === s);
      if (!free && !this.bestTerraformTarget(s, null)) continue;
      const sc = d * (civs.length ? 3 : 1);
      if (sc < score) {
        score = sc;
        dmin = d;
        best = s;
      }
    }
    this.clock.set(-home.id, this.host.time);
    if (!best) return;
    const travel = dmin / (SHIP_SPEED * C_LIGHT);
    this.voyages.push({ from: home.id, fromStar: sun.id, toStar: best.id, depart: this.host.time, arrive: this.host.time + travel, owner, origin: { x: sun.pos.x, y: sun.pos.y, z: sun.pos.z }, kind: 'colony', empire: empire.id });
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
      this.settle(dest, v.owner, 1e5, home, v.empire);
      this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name} and settled ${dest.name}!`, 'success', dest.id);
      return;
    }
    const target = this.bestTerraformTarget(star, null);
    if (target) {
      this.projects.push({ target: target.id, by: home?.id ?? -1, started: this.host.time, owner: v.owner, empire: v.empire });
      const emp = this.empires.get(v.empire);
      if (emp) this.empires.settled(emp, target);
      this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name}. Living in orbit, the settlers have begun terraforming ${target.name}.`, 'success', target.id);
    } else this.host.notify(`The colony ship from ${home?.name ?? v.owner} reached ${star.name}; with no world to settle, its people live in orbital habitats.`, 'info', star.id);
  }

  serialize(): unknown {
    return { projects: this.projects, voyages: this.voyages, reached: this.reached, failed: this.failed, empires: this.empires.serialize() };
  }

  restore(o: any): void {
    this.projects = o?.projects ?? [];
    this.voyages = o?.voyages ?? [];
    this.reached = o?.reached ?? [];
    this.failed = o?.failed ?? [];
    this.empires.restore(o?.empires);
  }
}

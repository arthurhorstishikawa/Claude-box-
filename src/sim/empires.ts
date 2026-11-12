import { AU, YEAR } from '../core/constants';
import { clamp } from '../core/math';
import { Rng } from '../core/rng';
import type { Body } from '../physics/body';
import type { Civilization } from '../climate/civilization';
import { TerrestrialClimate } from '../climate/terrestrial';

/** Diplomatic state between two empires. */
export interface Relation {
  /** 0 = friendly, 1 = about to fight. */
  tension: number;
  war: boolean;
  /** When the current war (or peace) began. */
  since: number;
}

export interface Empire {
  id: number;
  name: string;
  /** Flag colour (0xRRGGBB). */
  color: number;
  founded: number;
  /** Body id of the capital world. */
  capital: number;
  /** Temperament, 0 (peaceful) … 1 (warlike). */
  aggression: number;
  /** War-weariness; grows with losses, ends wars. */
  exhaustion: number;
  /** Keyed by the other empire's id. */
  relations: Record<string, Relation>;
  alive: boolean;
  conquests: number;
}

/** A world held by an empire. */
export interface Holding {
  body: Body;
  c: TerrestrialClimate;
  civ: Civilization;
  star: Body | null;
  empire: Empire;
  strength: number;
}

/** What the empire book needs from the rest of the simulation. */
export interface EmpireHost {
  bodies: Body[];
  readonly time: number;
  getBody(id: number | null): Body | null;
  starOf(b: Body | null): Body | null;
  notify(msg: string, level: 'info' | 'warn' | 'danger' | 'success', bodyId?: number): void;
  /** Send a war fleet from `from` toward the star of `target`. Returns false if none can go. */
  launchFleet(from: Body, target: Body, empire: Empire, enemy: Empire, strength: number): boolean;
  /** War fleets of `empire` currently under way. */
  fleetsOf(empire: number): { toStar: number; enemy: number }[];
  /** Terraforming projects of `empire` (settlers living in orbit) and their star. */
  projectsOf(empire: number): { target: number; star: number | null }[];
  cancelProject(target: number): void;
}

/** "A Lumen …" / "An Ilios …" */
const an = (name: string) => (/^[aeiou]/i.test(name) ? 'An ' : 'A ') + name;

const COLORS = [0x5ab0ff, 0xff7a59, 0x7ddc6f, 0xf2c14e, 0xc58cff, 0x4fd1c5, 0xff6fae, 0xb8c2cc, 0xe0a458, 0x8aa4ff];
const TITLES = ['Federation', 'Union', 'Republic', 'Concord', 'Hegemony', 'Dominion', 'Commonwealth', 'Directorate', 'Compact', 'Empire'];
const WARLIKE = new Set(['Hegemony', 'Dominion', 'Directorate', 'Empire']);

/**
 * Empires: every civilization belongs to one. Colonies keep their founders' flag; colonies in
 * other star systems may break away. Empires that live in the same star system compete for it,
 * and tension between them grows (faster for warlike empires and when one plants colonies in
 * the other's system). Past a threshold they go to war: worlds in the same system bombard each
 * other (casualties, dust that cools the climate, occasional devastating strikes), a much
 * stronger side invades and conquers the weaker world, and interstellar empires send war fleets
 * to enemy systems. Losses breed war-weariness, which eventually brings peace.
 */
export class Empires {
  list: Empire[] = [];
  private nextId = 1;
  private rng = new Rng(4242);
  private quietUntil = new Map<string, number>();

  constructor(private host: EmpireHost) {}

  reset(): void {
    this.list = [];
    this.nextId = 1;
    this.quietUntil.clear();
  }

  get(id: number | undefined | null): Empire | undefined {
    return id ? this.list.find((e) => e.id === id) : undefined;
  }

  /** Military and economic weight of a world: people × what their technology can do. */
  static strength(civ: Civilization): number {
    const t = civ.tech;
    const f = t < 1 ? 0.2 : t < 2 ? 0.5 + 0.5 * (t - 1) : 1 + 6 * (t - 2);
    return civ.era === 'collapsed' ? 0 : civ.totalPop * f;
  }

  /** The empire a civilization belongs to, founding a new one if it has none. */
  ensure(b: Body, civ: Civilization): Empire {
    const e = this.get(civ.empire);
    if (e && e.alive) return e;
    const created = this.create(b.name, b.id);
    civ.empire = created.id;
    return created;
  }

  create(place: string, capital: number, aggression?: number): Empire {
    const title = TITLES[this.rng.int(0, TITLES.length - 1)];
    const used = new Set(this.list.map((e) => e.color));
    const color = COLORS.find((c) => !used.has(c)) ?? COLORS[this.nextId % COLORS.length];
    const e: Empire = {
      id: this.nextId++,
      name: `${place} ${title}`,
      color,
      founded: this.host.time,
      capital,
      aggression: aggression ?? clamp(this.rng.range(0.15, 0.75) + (WARLIKE.has(title) ? 0.2 : 0), 0, 1),
      exhaustion: 0,
      relations: {},
      alive: true,
      conquests: 0,
    };
    this.list.push(e);
    return e;
  }

  relation(a: Empire, b: Empire): Relation {
    let r = a.relations[b.id];
    if (!r) {
      r = { tension: 0.15, war: false, since: this.host.time };
      a.relations[b.id] = r;
      b.relations[a.id] = r;
      this.host.notify(`🛰 First contact: the ${a.name} and the ${b.name} have met.`, 'info', this.host.getBody(a.capital)?.id);
    }
    return r;
  }

  /** All worlds currently held by living civilizations, with their empires. */
  holdings(): Holding[] {
    const out: Holding[] = [];
    for (const b of this.host.bodies) {
      const c = b.climate instanceof TerrestrialClimate ? b.climate : null;
      const civ = c?.civ;
      if (!c || !civ || civ.era === 'collapsed' || civ.totalPop + civ.seedPopulation < 1e3) continue;
      const empire = this.ensure(b, civ);
      out.push({ body: b, c, civ, star: this.host.starOf(b), empire, strength: Empires.strength(civ) + civ.seedPopulation });
    }
    return out;
  }

  /** Someone settled (or began terraforming) a world: other empires in that system resent it. */
  settled(empire: Empire, b: Body): void {
    const star = this.host.starOf(b);
    const seen = new Set<Empire>();
    for (const h of this.holdings()) {
      if (h.empire === empire || h.star !== star || seen.has(h.empire)) continue;
      seen.add(h.empire);
      const r = this.relation(empire, h.empire);
      if (!r.war) r.tension = Math.min(1, r.tension + 0.15);
    }
  }

  /** Declare war (from the UI or by the empires themselves). */
  declareWar(a: Empire, b: Empire, reason = ''): void {
    const r = this.relation(a, b);
    if (r.war) return;
    r.war = true;
    r.since = this.host.time;
    r.tension = 1;
    this.host.notify(`⚔ War! The ${a.name} has declared war on the ${b.name}${reason}.`, 'danger', this.host.getBody(b.capital)?.id);
  }

  makePeace(a: Empire, b: Empire, reason = ''): void {
    const r = a.relations[b.id];
    if (!r || !r.war) return;
    r.war = false;
    r.since = this.host.time;
    r.tension = 0.3;
    this.quietUntil.set(this.key(a, b), this.host.time + 150 * YEAR);
    this.host.notify(`🕊 Peace between the ${a.name} and the ${b.name}${reason}.`, 'success', this.host.getBody(a.capital)?.id);
  }

  private key(a: Empire, b: Empire): string {
    return a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    // Long steps (fast time) are split so wars still unfold step by step.
    const n = Math.min(200, Math.ceil(dt / (5 * YEAR)));
    for (let i = 0; i < n; i++) this.step(dt / n);
  }

  private step(dt: number): void {
    const yr = dt / YEAR;
    const hs = this.holdings();
    const byEmpire = new Map<Empire, Holding[]>();
    for (const h of hs) {
      const l = byEmpire.get(h.empire) ?? [];
      l.push(h);
      byEmpire.set(h.empire, l);
    }
    // Fallen empires; capitals that were lost.
    for (const e of this.list) {
      if (!e.alive) continue;
      const mine = byEmpire.get(e);
      if (!mine || mine.length === 0) {
        e.alive = false;
        for (const r of Object.values(e.relations)) r.war = false;
        this.host.notify(`The ${e.name} has fallen.`, 'danger');
        continue;
      }
      if (!mine.some((h) => h.body.id === e.capital)) {
        const cap = mine.reduce((a, b) => (b.strength > a.strength ? b : a));
        e.capital = cap.body.id;
        this.host.notify(`The ${e.name} has moved its capital to ${cap.body.name}.`, 'warn', cap.body.id);
      }
      e.exhaustion = Math.max(0, e.exhaustion - 0.02 * yr * (this.atWar(e) ? 0 : 1)) + (this.atWar(e) ? 0.004 * yr : 0);
    }
    this.independence(hs, byEmpire, yr);
    // Presence: worlds an empire holds, plus systems where its settlers live in orbit while
    // they terraform. Empires present in the same star system know each other.
    const presence = new Map<Empire, Set<number>>();
    for (const e of this.list) {
      if (!e.alive) continue;
      const set = new Set<number>();
      for (const h of byEmpire.get(e) ?? []) if (h.star) set.add(h.star.id);
      for (const p of this.host.projectsOf(e.id)) if (p.star !== null) set.add(p.star);
      presence.set(e, set);
    }
    const alive = this.list.filter((e) => e.alive);
    for (let i = 0; i < alive.length; i++)
      for (let j = i + 1; j < alive.length; j++) {
        const a = presence.get(alive[i])!,
          b = presence.get(alive[j])!;
        if ([...a].some((x) => b.has(x))) this.relation(alive[i], alive[j]);
      }
    // Relations.
    const live = this.list.filter((e) => e.alive);
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const A = live[i],
          B = live[j];
        const r = A.relations[B.id];
        if (!r) continue;
        const hA = byEmpire.get(A) ?? [],
          hB = byEmpire.get(B) ?? [];
        const pA = presence.get(A)!,
          pB = presence.get(B)!;
        const shared = [...pA].some((x) => pB.has(x));
        const spaceA = Math.max(0, ...hA.map((h) => h.civ.tech)),
          spaceB = Math.max(0, ...hB.map((h) => h.civ.tech));
        if (!r.war) {
          // Rivalry over a shared system, temperament, and slow diplomacy pulling the other way.
          const drift = 0.0015 * (A.aggression + B.aggression) + (shared ? 0.004 : 0) - 0.003;
          r.tension = clamp(r.tension + drift * yr, 0, 1);
          const canFight = (shared && Math.max(spaceA, spaceB) >= 2.1) || Math.max(spaceA, spaceB) >= 2.45;
          const quiet = (this.quietUntil.get(this.key(A, B)) ?? -Infinity) > this.host.time;
          if (r.tension > 0.85 && canFight && !quiet) {
            const [att, def] = A.aggression >= B.aggression ? [A, B] : [B, A];
            this.declareWar(att, def, shared ? ' over their shared star system' : '');
          }
        } else this.war(A, B, hA, hB, r, yr);
      }
  }

  atWar(e: Empire): boolean {
    return Object.values(e.relations).some((r) => r.war);
  }

  enemies(e: Empire): Empire[] {
    return this.list.filter((o) => o.alive && o !== e && e.relations[o.id]?.war);
  }

  private war(A: Empire, B: Empire, hA: Holding[], hB: Holding[], r: Relation, yr: number): void {
    const popA0 = hA.reduce((s, h) => s + h.civ.totalPop, 0),
      popB0 = hB.reduce((s, h) => s + h.civ.totalPop, 0);
    // Battles in every star system both sides live in.
    for (const [att, defs, attE, defE] of [
      [hA, hB, A, B],
      [hB, hA, B, A],
    ] as [Holding[], Holding[], Empire, Empire][]) {
      for (const d of defs) {
        const local = att.filter((a) => a.star && a.star === d.star && a.civ.tech >= 2);
        if (!local.length || d.civ.totalPop <= 0) continue;
        const S = local.reduce((s, a) => s + a.strength, 0);
        const ratio = S / (S + d.strength + 1);
        // Bombardment: casualties, and dust from strikes that dims the sky.
        const kill = 1 - Math.exp(-0.02 * yr * ratio * (0.5 + attE.aggression));
        this.casualties(d, kill);
        d.c.aerosol = Math.max(d.c.aerosol, Math.min(0.3, 0.6 * kill / Math.max(yr, 0.1)));
        if (this.rng.chance(Math.min(0.5, 0.003 * yr * attE.aggression * ratio))) {
          d.civ.nuclearWar();
          this.host.notify(`💥 The ${attE.name} has devastated ${d.body.name} with an all-out strike.`, 'danger', d.body.id);
        }
        // Invasion: a far stronger, spacefaring force takes the world.
        if (S > 4 * d.strength && Math.max(...local.map((a) => a.civ.tech)) >= 2.1 && this.rng.chance(Math.min(1, 0.05 * yr))) this.conquer(d, attE, defE);
      }
    }
    // Settlers terraforming in orbit are easy targets for armed worlds of the same system.
    for (const [att, attE, defE] of [
      [hA, A, B],
      [hB, B, A],
    ] as [Holding[], Empire, Empire][]) {
      for (const p of this.host.projectsOf(defE.id)) {
        if (p.star === null || !att.some((a) => a.star?.id === p.star && a.civ.tech >= 2)) continue;
        if (!this.rng.chance(Math.min(1, 0.03 * yr))) continue;
        this.host.cancelProject(p.target);
        defE.exhaustion += 0.15;
        this.host.notify(`⚔ The ${attE.name} destroyed the ${defE.name}'s terraforming stations at ${this.host.getBody(p.target)?.name ?? 'a world'}.`, 'danger', p.target);
      }
    }
    // Interstellar war fleets toward enemy systems out of reach at home.
    for (const [att, defs, attE, defE] of [
      [hA, hB, A, B],
      [hB, hA, B, A],
    ] as [Holding[], Holding[], Empire, Empire][]) {
      const base = att.filter((h) => h.civ.tech >= 2.45).sort((a, b) => b.strength - a.strength)[0];
      if (!base || this.host.fleetsOf(attE.id).some((f) => f.enemy === defE.id)) continue;
      const targets = defs.filter((d) => d.star && d.star !== base.star && !att.some((a) => a.star === d.star));
      if (!targets.length || !this.rng.chance(Math.min(1, 0.02 * yr))) continue;
      const t = targets.sort((a, b) => a.strength - b.strength)[0];
      if (this.host.launchFleet(base.body, t.body, attE, defE, 0.3 * base.strength)) base.civ.pop.forEach((_, k, p) => (p[k] *= 0.97));
    }
    // War-weariness from losses; peace when both are tired or one is beaten.
    const popA1 = hA.reduce((s, h) => s + h.civ.totalPop, 0),
      popB1 = hB.reduce((s, h) => s + h.civ.totalPop, 0);
    A.exhaustion += popA0 > 0 ? (3 * Math.max(0, popA0 - popA1)) / popA0 : 0;
    B.exhaustion += popB0 > 0 ? (3 * Math.max(0, popB0 - popB1)) / popB0 : 0;
    const long = this.host.time - r.since > 400 * YEAR;
    if ((A.exhaustion > 0.8 && B.exhaustion > 0.8) || A.exhaustion > 1.6 || B.exhaustion > 1.6 || long) {
      const loser = A.exhaustion > B.exhaustion ? A : B;
      this.makePeace(A, B, long ? ' after centuries of stalemate' : ` — the exhausted ${loser.name} sued for peace`);
    }
  }

  private casualties(h: Holding, f: number): void {
    if (f <= 0) return;
    const p = h.civ.pop;
    for (let k = 0; k < p.length; k++) p[k] *= 1 - f;
    h.civ.totalPop *= 1 - f;
  }

  /** A world changes hands. */
  conquer(d: Holding, by: Empire, from: Empire): void {
    this.casualties(d, 0.2);
    d.civ.empire = by.id;
    d.civ.name = `${by.name} province`;
    // The conquerors bring their technology.
    d.civ.tech = Math.max(d.civ.tech, 2.05);
    if (d.civ.era !== 'clean') d.civ.era = 'clean';
    by.conquests++;
    from.exhaustion += 0.3;
    this.host.notify(`🏴 ${d.body.name} has fallen to the ${by.name}.`, 'danger', d.body.id);
  }

  /** A war fleet reached its target system. */
  fleetArrived(attackerId: number, enemyId: number, toStar: number, strength: number): void {
    const A = this.get(attackerId),
      B = this.get(enemyId);
    const star = this.host.getBody(toStar);
    if (!A || !B || !star) return;
    const targets = this.holdings().filter((h) => h.empire === B && h.star === star);
    if (!A.relations[B.id]?.war || !targets.length) {
      this.host.notify(`The ${A.name} war fleet reached ${star.name}, but there was no enemy left to fight.`, 'info', star.id);
      return;
    }
    const t = targets.sort((a, b) => a.strength - b.strength)[0];
    if (strength > 1.5 * t.strength) {
      this.host.notify(`🚀⚔ ${an(A.name)} invasion fleet has arrived at ${star.name}.`, 'danger', t.body.id);
      this.conquer(t, A, B);
    } else {
      const kill = Math.min(0.6, (0.5 * strength) / Math.max(t.strength, 1));
      this.casualties(t, kill);
      t.c.aerosol = Math.max(t.c.aerosol, 0.2 * kill);
      B.exhaustion += kill;
      this.host.notify(`⚔ ${an(A.name)} fleet attacked ${t.body.name} (${Math.round(kill * 100)}% losses) but was destroyed by its defenders.`, 'danger', t.body.id);
    }
  }

  /** Colonies far from their capital may go their own way. */
  private independence(hs: Holding[], byEmpire: Map<Empire, Holding[]>, yr: number): void {
    for (const h of hs) {
      const e = h.empire;
      if (h.body.id === e.capital || h.civ.totalPop < 1e7) continue;
      const cap = this.host.getBody(e.capital);
      const capStar = this.host.starOf(cap);
      if (!capStar || !h.star || h.star === capStar || h.star.pos.distTo(capStar.pos) < 2000 * AU) continue;
      if (this.host.time - h.civ.founded < 300 * YEAR) continue;
      // Light-years of separation: messages take years, interests drift apart.
      if (!this.rng.chance(Math.min(0.5, 0.0015 * yr))) continue;
      const n = this.create(h.body.name, h.body.id);
      h.civ.empire = n.id;
      h.civ.name = n.name;
      const r = this.relation(n, e);
      r.tension = 0.45 + 0.3 * e.aggression;
      this.host.notify(`🏳 ${h.body.name} has declared independence from the ${e.name}: the ${n.name} is born.`, 'warn', h.body.id);
      void byEmpire;
      return; // one at a time
    }
  }

  serialize(): unknown {
    return { list: this.list, nextId: this.nextId };
  }

  restore(o: any): void {
    this.list = Array.isArray(o?.list) ? o.list : [];
    this.nextId = o?.nextId ?? this.list.reduce((m, e) => Math.max(m, e.id + 1), 1);
    // Both empires of a pair share one relation object (JSON made two copies).
    for (const a of this.list)
      for (const [id, r] of Object.entries(a.relations)) {
        const b = this.get(Number(id));
        if (b && a.id < b.id) b.relations[a.id] = r;
      }
  }
}

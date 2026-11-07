import { V3 } from '../core/vec3';
import { Body, bumpBodyId, type WorldSpec } from '../physics/body';
import { GasGiantClimate } from '../climate/gasGiant';
import { TerrestrialClimate } from '../climate/terrestrial';
import type { Simulation } from './simulation';

const SAVE_VERSION = 1;

/** Serialise the whole universe (bodies, climates, clock, settings) to plain JSON. */
export function serializeSim(sim: Simulation): string {
  const bodies = sim.bodies.map((b) => ({
    id: b.id,
    name: b.name,
    mass: b.mass,
    radius: b.radius,
    radiusAnchor: b.radiusAnchor,
    pos: b.pos.toArray(),
    vel: b.vel.toArray(),
    composition: b.composition,
    spinAxis: b.spinAxis.toArray(),
    primeRef: b.primeRef.toArray(),
    rotationPeriod: b.rotationPeriod,
    rotationAngle: b.rotationAngle,
    tidallyLocked: b.tidallyLocked,
    lockProgress: b.lockProgress,
    star: b.star ? { ...b.star, snapshot: null } : null,
    world: b.world,
    giant: b.giant,
    rings: b.rings,
    internalHeat: b.internalHeat,
    impactHeat: b.impactHeat,
    insolationFactor: b.insolationFactor,
    forcedEcc: b.forcedEcc,
    age: b.age,
    color: b.color,
    description: b.description,
    climate: b.climate ? b.climate.serialize() : null,
  }));
  return JSON.stringify({
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    time: sim.time,
    epochMs: sim.epochMs,
    speed: sim.speed,
    focusId: sim.focusId,
    scenarioId: sim.scenarioId,
    settings: sim.settings,
    agency: sim.agency.serialize(),
    bodies,
  });
}

/** Restore a universe saved by serializeSim. */
export function loadSim(sim: Simulation, json: string): void {
  const o = JSON.parse(json);
  if (!o || !Array.isArray(o.bodies)) throw new Error('Not a saved system file');
  sim.bodies = [];
  sim.time = o.time ?? 0;
  sim.epochMs = o.epochMs ?? null;
  sim.speed = o.speed ?? sim.speed;
  sim.scenarioId = o.scenarioId ?? 'custom';
  Object.assign(sim.settings, o.settings ?? {});
  let maxId = 0;
  for (const s of o.bodies) {
    const b = new Body(s.name, s.mass, s.radius);
    (b as any).id = s.id;
    maxId = Math.max(maxId, s.id);
    b.radiusAnchor = s.radiusAnchor ?? null;
    b.pos = V3.from(s.pos);
    b.vel = V3.from(s.vel);
    b.composition = s.composition;
    b.spinAxis = V3.from(s.spinAxis);
    b.primeRef = V3.from(s.primeRef);
    b.rotationPeriod = s.rotationPeriod;
    b.rotationAngle = s.rotationAngle;
    b.tidallyLocked = s.tidallyLocked;
    b.lockProgress = s.lockProgress ?? 0;
    b.star = s.star;
    b.world = s.world as WorldSpec | null;
    b.giant = s.giant;
    b.rings = s.rings;
    b.internalHeat = s.internalHeat;
    b.impactHeat = s.impactHeat ?? 0;
    b.insolationFactor = s.insolationFactor ?? 1;
    b.forcedEcc = s.forcedEcc ?? 0;
    b.age = s.age ?? b.age;
    b.color = s.color ?? b.color;
    b.description = s.description ?? '';
    sim.bodies.push(b);
    (b as any).__savedClimate = s.climate;
  }
  bumpBodyId(maxId + 1);
  sim.focusId = o.focusId ?? sim.bodies[0]?.id ?? null;
  sim.refreshPrimaries();
  for (const b of sim.bodies) {
    const saved = (b as any).__savedClimate;
    delete (b as any).__savedClimate;
    sim.initBody(b);
    if (saved && b.climate instanceof TerrestrialClimate) b.climate.restore(saved);
    if (saved && b.climate instanceof GasGiantClimate) b.climate.restore(saved);
  }
  sim.agency.restore(o.agency);
  sim.events.emit('reset', undefined);
}

const SLOT_PREFIX = 'aeolus.save.';

export function listSlots(): { name: string; savedAt: string }[] {
  const out: { name: string; savedAt: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(SLOT_PREFIX)) continue;
      try {
        const meta = JSON.parse(localStorage.getItem(k) ?? '{}');
        out.push({ name: k.slice(SLOT_PREFIX.length), savedAt: meta.savedAt ?? '' });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* storage unavailable */
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function saveSlot(sim: Simulation, name: string): boolean {
  try {
    localStorage.setItem(SLOT_PREFIX + name, serializeSim(sim));
    return true;
  } catch {
    return false;
  }
}

export function loadSlot(sim: Simulation, name: string): boolean {
  try {
    const s = localStorage.getItem(SLOT_PREFIX + name);
    if (!s) return false;
    loadSim(sim, s);
    return true;
  } catch {
    return false;
  }
}

export function deleteSlot(name: string): void {
  try {
    localStorage.removeItem(SLOT_PREFIX + name);
  } catch {
    /* ignore */
  }
}

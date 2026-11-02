import { describe, expect, it } from 'vitest';
import { AU, DAY, G, M_EARTH, M_SUN, R_EARTH, R_SUN, YEAR } from '../src/core/constants';
import { V3 } from '../src/core/vec3';
import { Body } from '../src/physics/body';
import { classifyBody, radiusFromMass } from '../src/physics/classify';
import { KeplerSystem, NBody } from '../src/physics/gravity';
import { orbitFromState, orbitPeriod, orbitState } from '../src/physics/orbits';

function sunEarth() {
  const sun = new Body('Sun', M_SUN, R_SUN);
  const earth = new Body('Earth', M_EARTH, R_EARTH);
  earth.pos.set(AU, 0, 0);
  earth.vel.set(0, Math.sqrt((G * (M_SUN + M_EARTH)) / AU), 0);
  return [sun, earth];
}

describe('orbits', () => {
  it('round-trips state vectors through orbital elements', () => {
    const r = new V3(1.1 * AU, 0.2 * AU, 0.01 * AU);
    const v = new V3(-3e3, 2.8e4, 500);
    const mu = G * M_SUN;
    const o = orbitFromState(r, v, mu, 0);
    const r2 = new V3();
    const v2 = new V3();
    orbitState(o, 0, r2, v2);
    expect(r2.distTo(r) / r.len()).toBeLessThan(1e-9);
    expect(v2.distTo(v) / v.len()).toBeLessThan(1e-9);
  });

  it('gives Earth a one-year period', () => {
    const [, earth] = sunEarth();
    const o = orbitFromState(earth.pos, earth.vel, G * (M_SUN + M_EARTH), 0);
    expect(orbitPeriod(o) / YEAR).toBeCloseTo(1.0, 2);
  });
});

describe('N-body integrator', () => {
  it('conserves energy and closes Earth\'s orbit after a year', () => {
    const bodies = sunEarth();
    const nb = new NBody();
    nb.load(bodies);
    const energy = () => {
      nb.store(bodies);
      const [s, e] = bodies;
      const v2 = (b: Body) => b.vel.len2();
      return 0.5 * s.mass * v2(s) + 0.5 * e.mass * v2(e) - (G * s.mass * e.mass) / s.pos.distTo(e.pos);
    };
    const e0 = energy();
    let t = 0;
    while (t < YEAR) t += nb.integrate(YEAR - t, 100000).advanced;
    const e1 = energy();
    expect(Math.abs((e1 - e0) / e0)).toBeLessThan(1e-4);
    nb.store(bodies);
    const rel = V3.sub(bodies[1].pos, bodies[0].pos);
    expect(rel.distTo(new V3(AU, 0, 0)) / AU).toBeLessThan(0.01);
  });

  it('detects collisions', () => {
    const a = new Body('a', M_EARTH, R_EARTH);
    const b = new Body('b', M_EARTH, R_EARTH);
    b.pos.set(5 * R_EARTH, 0, 0);
    b.vel.set(-1e4, 0, 0);
    const nb = new NBody();
    nb.load([a, b]);
    const res = nb.integrate(DAY, 100000);
    expect(res.collision).not.toBeNull();
  });
});

describe('Kepler mode', () => {
  it('propagates analytically and follows adiabatic mass loss', () => {
    const bodies = sunEarth();
    const ks = new KeplerSystem();
    ks.build(bodies, 0);
    ks.propagate(0.5 * YEAR);
    const rel = V3.sub(bodies[1].pos, bodies[0].pos);
    expect(rel.x / AU).toBeCloseTo(-1, 2);
    bodies[0].mass *= 0.5;
    ks.adjustMasses(0.5 * YEAR);
    ks.propagate(0.75 * YEAR);
    const r = V3.sub(bodies[1].pos, bodies[0].pos).len();
    expect(r / AU).toBeCloseTo(2, 1);
  });
});

describe('classification', () => {
  it('classifies bodies by mass and composition', () => {
    const jup = new Body('J', 1.9e27, 7e7);
    jup.composition = { iron: 0.02, rock: 0.04, ice: 0.04, gas: 0.9 };
    expect(classifyBody(jup)).toBe('gasGiant');
    const bd = new Body('BD', 30 * 1.9e27, 7e7);
    bd.composition = jup.composition;
    expect(classifyBody(bd)).toBe('brownDwarf');
    expect(classifyBody(new Body('E', M_EARTH, R_EARTH))).toBe('terrestrial');
    expect(classifyBody(new Body('A', 1e18, 1e5))).toBe('smallBody');
  });
  it('produces sensible radii', () => {
    const c = { iron: 0.32, rock: 0.68, ice: 0, gas: 0 };
    expect(radiusFromMass('terrestrial', M_EARTH, c) / R_EARTH).toBeCloseTo(1, 1);
    expect(radiusFromMass('gasGiant', 1.898e27, c) / 6.99e7).toBeGreaterThan(0.9);
  });
});

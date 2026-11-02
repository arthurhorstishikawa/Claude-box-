import { describe, expect, it } from 'vitest';
import { applyCrater, cloneTerrain, craterScaling, generateTerrain } from '../src/climate/terrain';
import { LatLonGrid } from '../src/climate/grid';
import { EARTH, MARS, MOON, TITAN, VENUS, spinUp } from './helpers';

describe('implicit transport', () => {
  it('conserves heat with variable capacity at extreme diffusivity', () => {
    const g = new LatLonGrid(24, 48);
    const X = new Float64Array(g.N);
    const C = new Float64Array(g.N);
    for (let k = 0; k < g.N; k++) {
      X[k] = 100 + 50 * Math.sin(k);
      C[k] = 1e8 * (1 + 0.5 * Math.sin(k * 1.3));
    }
    const tot = () => {
      let s = 0;
      for (let k = 0; k < g.N; k++) s += X[k] * C[k] * g.cellArea[Math.floor(k / g.nLon)];
      return s;
    };
    const before = tot();
    g.diffuse(X, C, 1e16, 2.5e6, 1e9);
    expect(Math.abs(tot() / before - 1)).toBeLessThan(1e-9);
  });
});

describe('climate calibration', () => {
  it('keeps Earth temperate with oceans, ice caps and rain', () => {
    const c = spinUp(EARTH, 2);
    expect(c.stats.meanT).toBeGreaterThan(280);
    expect(c.stats.meanT).toBeLessThan(298);
    expect(c.stats.albedo).toBeGreaterThan(0.24);
    expect(c.stats.albedo).toBeLessThan(0.36);
    expect(c.stats.precip).toBeGreaterThan(1.5);
    expect(c.stats.iceFrac).toBeGreaterThan(0.02);
    expect(c.stats.oceanFrac).toBeGreaterThan(0.55);
  });
  it('bakes Venus under its CO₂ blanket', () => {
    const c = spinUp(VENUS, 1);
    expect(c.stats.meanT).toBeGreaterThan(650);
    expect(c.stats.meanT).toBeLessThan(800);
  });
  it('leaves Mars cold and thin with polar caps', () => {
    const c = spinUp(MARS, 1);
    expect(c.stats.meanT).toBeGreaterThan(185);
    expect(c.stats.meanT).toBeLessThan(225);
    expect(c.stats.P).toBeGreaterThan(150);
  });
  it('keeps Titan near 90 K with a thick N₂ atmosphere and methane lakes', () => {
    const c = spinUp(TITAN, 1);
    expect(c.stats.meanT).toBeGreaterThan(80);
    expect(c.stats.meanT).toBeLessThan(100);
    expect(c.stats.P).toBeGreaterThan(1.2e5);
  });
  it('runs away when Earth is moved inside Venus\' orbit', () => {
    const c = spinUp({ ...EARTH, flux: 1361 * 1.6 }, 1);
    expect(c.stats.meanT).toBeGreaterThan(330);
  });
  it('freezes into a snowball when the Sun dims', () => {
    const c = spinUp({ ...EARTH, flux: 1361 * 0.8, init: { ...EARTH.init, initialTemp: 250 } }, 1);
    expect(c.stats.iceFrac).toBeGreaterThan(0.7);
  });
  it('gives the airless Moon no weather', () => {
    const c = spinUp(MOON, 1);
    expect(c.stats.P).toBeLessThan(1);
    expect(c.stats.precip).toBe(0);
  });
});

describe('terrain & craters', () => {
  it('is deterministic per seed', () => {
    const a = generateTerrain('earthlike', 99, 128, 64);
    const b = generateTerrain('earthlike', 99, 128, 64);
    expect(a.elev[1234]).toBe(b.elev[1234]);
  });
  it('carves craters scaled by impact energy', () => {
    const small = craterScaling(100, 2e4, 3000, 2700, 9.81);
    const big = craterScaling(1e4, 2e4, 3000, 2700, 9.81);
    expect(big.diameter).toBeGreaterThan(50 * small.diameter);
    expect(big.diameter / 1e3).toBeGreaterThan(80);
    const t = cloneTerrain(generateTerrain('moonlike', 3, 256, 128));
    const centre = t.elev[64 * 256 + 128];
    applyCrater(t, { lat: 0, lon: 0, diameter: 400e3, depth: 4e3, time: 0 }, 1.737e6);
    expect(t.elev[64 * 256 + 128]).toBeLessThan(centre - 1000);
  });
});

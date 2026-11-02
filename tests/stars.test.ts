import { describe, expect, it } from 'vitest';
import { AU, L_SUN } from '../src/core/constants';
import { blackbodyRGB, spectralFractions } from '../src/stars/blackbody';
import { habitableZone } from '../src/stars/habitableZone';
import { evolveStar, msLifetime, spectralClass } from '../src/stars/stellar';

describe('stellar evolution', () => {
  it('reproduces the present-day Sun within ~10%', () => {
    const s = evolveStar(1, 4.57e9);
    expect(s.phase).toBe('MS');
    expect(s.L).toBeGreaterThan(0.9);
    expect(s.L).toBeLessThan(1.1);
    expect(s.T).toBeGreaterThan(5400);
    expect(s.T).toBeLessThan(6100);
  });
  it('has a faint young Sun', () => {
    expect(evolveStar(1, 0).L).toBeLessThan(0.75);
  });
  it('turns the Sun into a red giant and then a white dwarf', () => {
    const t = msLifetime(1);
    const giant = evolveStar(1, t * 1.139);
    expect(giant.phase).toBe('RGB');
    expect(giant.R).toBeGreaterThan(50);
    const wd = evolveStar(1, t * 1.5);
    expect(wd.phase).toBe('WD');
    expect(wd.m).toBeLessThan(0.6);
  });
  it('makes massive stars explode', () => {
    const t = msLifetime(20);
    expect(evolveStar(20, t * 1.2).phase).toBe('NS');
    expect(evolveStar(40, msLifetime(40) * 1.2).phase).toBe('BH');
  });
  it('labels the Sun as G2V-ish', () => {
    expect(spectralClass(5772, 'MS')).toMatch(/^G\d V$/);
  });
});

describe('blackbody', () => {
  it('colours hot stars blue and cool stars red', () => {
    const [r1, , b1] = blackbodyRGB(3000);
    const [r2, , b2] = blackbodyRGB(20000);
    expect(r1).toBeGreaterThan(b1);
    expect(b2).toBeGreaterThan(r2);
  });
  it('puts less visible light in M-dwarf spectra', () => {
    expect(spectralFractions(3000).vis).toBeLessThan(spectralFractions(5772).vis);
  });
});

describe('habitable zone', () => {
  it('places the Sun\'s conservative HZ around 0.95–1.7 AU', () => {
    const hz = habitableZone(L_SUN, 5772);
    expect(hz.inner / AU).toBeGreaterThan(0.9);
    expect(hz.inner / AU).toBeLessThan(1.0);
    expect(hz.outer / AU).toBeGreaterThan(1.6);
    expect(hz.outer / AU).toBeLessThan(1.8);
  });
});

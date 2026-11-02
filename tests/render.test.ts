import { describe, expect, it } from 'vitest';
import { V3 } from '../src/core/vec3';
import { parentNode, patchNode, selectPatches } from '../src/render/terrain';

describe('terrain level of detail', () => {
  it('keeps the patch count bounded when standing on a planet', () => {
    // Landed 2.5 km above Earth's datum on 600 m ground, and high up on a Mars volcano.
    const earth = selectPatches(6.371e6, new V3(6.371e6 + 2500, 0, 0), 17, 2.3, 11000, () => 600);
    const mars = selectPatches(3.3895e6, new V3(3.3895e6 + 5000, 0, 0), 17, 2.3, 23000, () => 4500);
    expect(earth.length).toBeLessThan(3000);
    expect(mars.length).toBeLessThan(3000);
    // ...with detail matched to height: ~2 km up is fine at depth ≥ 14; standing on the
    // ground reaches the deepest level.
    expect(Math.max(...earth.map((n) => n.depth))).toBeGreaterThanOrEqual(14);
    const ground = selectPatches(6.371e6, new V3(6.371e6 + 620, 0, 0), 17, 2.3, 11000, () => 600);
    expect(Math.max(...ground.map((n) => n.depth))).toBe(17);
    expect(ground.length).toBeLessThan(3000);
  });

  it('addresses parents consistently', () => {
    const n = patchNode(2, 5, 13, 22, 1e6, 0);
    const p = parentNode(n, 1e6, 0)!;
    expect(p.depth).toBe(4);
    expect(p.ix).toBe(6);
    expect(p.iy).toBe(11);
    // The child lies inside its parent.
    expect(n.x0).toBeGreaterThanOrEqual(p.x0);
    expect(n.x0 + n.size).toBeLessThanOrEqual(p.x0 + p.size + 1e-12);
  });
});

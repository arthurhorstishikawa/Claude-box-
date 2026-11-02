import { clamp } from '../core/math';

/**
 * Colour of photosynthetic life adapted to its host star (after Kiang et al. 2007,
 * "Spectral signatures of photosynthesis"): pigments absorb where surface photon flux peaks.
 * Hotter F stars → blue-absorbing, yellow/orange foliage; Sun-like G → green;
 * K → olive / red-shifted; M dwarfs → absorb the whole visible band, near-black purple.
 * Returns linear RGB reflectance (0..1).
 */
export function plantPigment(teff: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [2600, [0.035, 0.025, 0.045]],
    [3500, [0.06, 0.035, 0.06]],
    [4300, [0.16, 0.12, 0.04]],
    [5000, [0.11, 0.16, 0.035]],
    [5800, [0.045, 0.14, 0.03]],
    [6500, [0.3, 0.22, 0.03]],
    [7500, [0.45, 0.22, 0.05]],
    [10000, [0.4, 0.12, 0.06]],
  ];
  const t = clamp(teff, stops[0][0], stops[stops.length - 1][0]);
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1];
}

/** Broadband albedo of vegetation for a host star (dark M-dwarf plants absorb more). */
export function plantAlbedo(teff: number): number {
  const [r, g, b] = plantPigment(teff);
  // Leaves are bright in the near-IR ("red edge") except where pigments extend into it (M dwarfs).
  const vis = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const nir = clamp((teff - 2600) / 2500, 0.15, 1) * 0.35;
  return clamp(0.5 * vis + 0.5 * nir, 0.04, 0.25);
}

export function pigmentName(teff: number): string {
  if (teff < 3900) return 'near-black purple (M-dwarf light)';
  if (teff < 5000) return 'olive / red-shifted (K-star light)';
  if (teff < 6200) return 'green (Sun-like light)';
  return 'yellow-orange (F-star light)';
}

import { AU, L_SUN } from '../core/constants';
import { clamp } from '../core/math';

// Kopparapu et al. (2013, with erratum) effective-flux coefficients.
const COEFFS = {
  recentVenus: [1.7753, 1.4316e-4, 2.9875e-9, -7.5702e-12, -1.1635e-15],
  runaway: [1.0512, 1.3242e-4, 1.5418e-8, -7.9895e-12, -1.8328e-15],
  maxGreenhouse: [0.3438, 5.8942e-5, 1.6558e-9, -3.0045e-12, -5.2983e-16],
  earlyMars: [0.3179, 5.4513e-5, 1.5313e-9, -2.7786e-12, -4.8997e-16],
} as const;

export interface HabitableZone {
  /** Optimistic inner edge (recent Venus), m. */
  optimisticInner: number;
  /** Conservative inner edge (runaway greenhouse), m. */
  inner: number;
  /** Conservative outer edge (maximum greenhouse), m. */
  outer: number;
  /** Optimistic outer edge (early Mars), m. */
  optimisticOuter: number;
}

export function effectiveFlux(kind: keyof typeof COEFFS, teff: number): number {
  const [s, a, b, c, d] = COEFFS[kind];
  const t = clamp(teff, 2600, 7200) - 5780;
  return s + a * t + b * t * t + c * t * t * t + d * t * t * t * t;
}

/** Habitable-zone distances for a star of luminosity L (W) and effective temperature T. */
export function habitableZone(L: number, teff: number): HabitableZone {
  const l = L / L_SUN;
  const d = (k: keyof typeof COEFFS) => Math.sqrt(l / effectiveFlux(k, teff)) * AU;
  return {
    optimisticInner: d('recentVenus'),
    inner: d('runaway'),
    outer: d('maxGreenhouse'),
    optimisticOuter: d('earlyMars'),
  };
}

/** Frost (snow) line distance — where water ice condenses in a protoplanetary disk. */
export function frostLine(L: number): number {
  return 2.7 * Math.sqrt(L / L_SUN) * AU;
}

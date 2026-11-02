import { DAY, G, C_LIGHT, L_SUN, M_SUN, R_SUN, SIGMA, T_SUN } from '../core/constants';
import { clamp, lerp, logLerp } from '../core/math';

/**
 * Simplified single-star evolution. All tracks are analytic so stars can be aged
 * by billions of years per second. Units inside are solar (Msun, Lsun, Rsun, yr).
 */
export type StarPhase =
  | 'MS'
  | 'SG'
  | 'RGB'
  | 'HB'
  | 'AGB'
  | 'PN'
  | 'WD'
  | 'SGB'
  | 'RSG'
  | 'WR'
  | 'SN'
  | 'NS'
  | 'BH'
  | 'BD';

export type RemnantType = 'WD' | 'NS' | 'BH';

export const PHASE_LABEL: Record<StarPhase, string> = {
  MS: 'Main-sequence star',
  SG: 'Subgiant',
  RGB: 'Red giant',
  HB: 'Helium-burning giant',
  AGB: 'Asymptotic-giant-branch star',
  PN: 'Planetary-nebula nucleus',
  WD: 'White dwarf',
  SGB: 'Blue supergiant',
  RSG: 'Red supergiant',
  WR: 'Wolf–Rayet star',
  SN: 'Supernova',
  NS: 'Neutron star',
  BH: 'Black hole',
  BD: 'Brown dwarf',
};

export interface StarSnapshot {
  phase: StarPhase;
  /** Luminosity in Lsun. */
  L: number;
  /** Radius in Rsun. */
  R: number;
  /** Effective temperature, K. */
  T: number;
  /** Current mass in Msun (after winds / supernova). */
  m: number;
  remnant: RemnantType | null;
}

const teff = (L: number, R: number) => T_SUN * Math.pow(L / (R * R), 0.25);
const radiusFrom = (L: number, T: number) => Math.sqrt(L) * (T_SUN / T) * (T_SUN / T);

/** Mid-main-sequence mass–luminosity relation. */
export function lumMid(m: number): number {
  if (m < 0.43) return 0.23 * Math.pow(m, 2.3);
  if (m < 2) return Math.pow(m, 4);
  if (m < 55) return 1.4 * Math.pow(m, 3.5);
  return 32000 * m;
}
export function radMid(m: number): number {
  return m < 1 ? Math.pow(m, 0.8) : Math.pow(m, 0.57);
}
/** Main-sequence lifetime in years. */
export function msLifetime(m: number): number {
  return m <= 10 ? 1e10 * Math.pow(m, -2.5) : 3.162e7 * Math.pow(m / 10, -1);
}

export const SN_DURATION_YR = 1.5;
const PN_DURATION = 3e4;

/** White dwarf radius (Rsun) via a Nauenberg-style relation. */
export function whiteDwarfRadius(m: number): number {
  const x = Math.min(0.98, m / 1.44);
  return 0.0126 * Math.pow(Math.max(0.1, m) / 0.6, -1 / 3) * Math.sqrt(Math.max(0.04, 1 - Math.pow(x, 4 / 3)));
}

export function whiteDwarf(m: number, coolYr: number): StarSnapshot {
  const T = 1e5 * Math.pow(1 + Math.max(0, coolYr) / 1e6, -0.35);
  const R = whiteDwarfRadius(m);
  return { phase: 'WD', L: R * R * Math.pow(T / T_SUN, 4), R, T, m, remnant: 'WD' };
}

export function neutronStar(m: number, coolYr: number): StarSnapshot {
  const R = 12e3 / R_SUN;
  const T = 2e6 * Math.pow(1 + Math.max(0, coolYr) / 1e4, -0.3);
  return { phase: 'NS', L: R * R * Math.pow(T / T_SUN, 4), R, T, m, remnant: 'NS' };
}

export function blackHoleRadius(massKg: number): number {
  return (2 * G * massKg) / (C_LIGHT * C_LIGHT);
}

/** Supernova light curve (Lsun) t years after explosion. */
export function supernovaLuminosity(tYr: number, typeIa = false): number {
  const td = (tYr * 365.25 * DAY) / DAY;
  const peak = typeIa ? 5e9 : 1e9;
  if (td < 0) return 0;
  if (td < 10) return peak * (0.1 + 0.9 * (td / 10));
  const plateau = typeIa ? 20 : 80;
  if (td < plateau) return peak;
  return peak * Math.exp(-(td - plateau) / 35);
}

/** Brown dwarfs and giant planets: radiative cooling with age (Burrows-like scaling). */
export function brownDwarf(m: number, ageYr: number): StarSnapshot {
  const age = Math.max(1e6, ageYr);
  const L = 3e-5 * Math.pow(m / 0.05, 2.64) * Math.pow(age / 1e9, -1.3);
  const R = 0.1 * Math.pow(age / 1e9, -0.08);
  return { phase: 'BD', L, R, T: teff(L, R), m, remnant: null };
}

/**
 * Evolve a star of initial mass mi (Msun) to the given age (yr).
 */
export function evolveStar(mi: number, ageYr: number): StarSnapshot {
  const age = Math.max(0, ageYr);
  const tMS = msLifetime(mi);
  const LZ = lumMid(mi) / 1.455;
  const RZ = radMid(mi) / 1.15;
  if (age < tMS) {
    const tau = age / tMS;
    const L = (LZ * 1.4) / (1.4 - 0.875 * tau);
    const R = RZ * (1 + 0.6 * tau * tau);
    return { phase: 'MS', L, R, T: teff(L, R), m: mi, remnant: null };
  }
  const LT = LZ * 2.667;
  const RT = RZ * 1.6;
  const TT = teff(LT, RT);
  let t = age - tMS;

  if (mi < 8) {
    const tSG = tMS * (mi <= 2 ? 0.08 : 0.03);
    const tRGB = tMS * (mi <= 2.2 ? 0.06 : 0.02);
    const tHB = tMS * (0.012 + 0.1 * clamp((mi - 1.5) / 3, 0, 1));
    const tAGB = Math.max(1e5, tMS * 0.002);
    const Lb = LT * 1.5;
    const Rb = RT * 2.0;
    const Tb = teff(Lb, Rb);
    const Ltip = mi <= 2 ? 2500 : mi < 2.5 ? logLerp(2500, 3 * Lb, (mi - 2) / 0.5) : 3 * Lb;
    const Ttip = mi <= 2 ? 3100 : lerp(3100, 4200, clamp((mi - 2) / 3, 0, 1));
    const LHB = Math.max(50, 1.2 * Lb);
    const THB = mi <= 2 ? 4800 : lerp(4800, 7000, clamp((mi - 2) / 4, 0, 1));
    const LAGB = Math.max(5000, 20 * LHB);
    const TAGB = 2900;
    const mWD = Math.min(1.35, 0.109 * mi + 0.394);
    const dmRGB = mi <= 2 ? Math.min(0.28, 0.3 * mi) : 0.1 * mi;
    const mHB = Math.max(mWD + 0.02, mi - dmRGB);

    if (t < tSG) {
      const x = t / tSG;
      const L = logLerp(LT, Lb, x);
      const T = logLerp(TT, Tb, x);
      return { phase: 'SG', L, R: radiusFrom(L, T), T, m: mi, remnant: null };
    }
    t -= tSG;
    if (t < tRGB) {
      const x = t / tRGB;
      const s = x * x * x;
      const L = logLerp(Lb, Ltip, s);
      const T = logLerp(Tb, Ttip, s);
      const m = mi - (mi - mHB) * s;
      return { phase: 'RGB', L, R: radiusFrom(L, T), T, m, remnant: null };
    }
    t -= tRGB;
    if (t < tHB) {
      const x = t / tHB;
      const L = LHB * (1 + 0.6 * x);
      const T = THB * (1 - 0.08 * x);
      return { phase: 'HB', L, R: radiusFrom(L, T), T, m: mHB, remnant: null };
    }
    t -= tHB;
    if (t < tAGB) {
      const x = t / tAGB;
      const s = x * x;
      const L = logLerp(LHB * 1.6, LAGB, s);
      const T = logLerp(Math.min(THB * 0.92, 4200), TAGB, Math.sqrt(x));
      const m = mHB - (mHB - mWD) * Math.pow(x, 4);
      return { phase: 'AGB', L, R: radiusFrom(L, T), T, m, remnant: null };
    }
    t -= tAGB;
    if (t < PN_DURATION) {
      const x = t / PN_DURATION;
      const T = logLerp(TAGB, 1e5, Math.min(1, x * 1.6));
      const L = LAGB * (1 - 0.85 * x * x);
      return { phase: 'PN', L, R: radiusFrom(L, T), T, m: mWD, remnant: null };
    }
    t -= PN_DURATION;
    return whiteDwarf(mWD, t);
  }

  // Massive stars: supergiant phases, then core collapse.
  const tSGB = 0.1 * tMS;
  const mPre = mi < 40 ? mi * (1 - 0.3 * clamp((mi - 8) / 20, 0, 1)) : mi * 0.4;
  if (t < tSGB) {
    const x = t / tSGB;
    const L = LT * 1.2;
    const m = mi - (mi - mPre) * x;
    if (mi >= 40) {
      const T = logLerp(TT, 60000, x);
      return { phase: 'WR', L, R: radiusFrom(L, T), T, m, remnant: null };
    }
    if (x < 0.1) {
      const T = logLerp(TT, 3600, x / 0.1);
      return { phase: 'SGB', L, R: radiusFrom(L, T), T, m, remnant: null };
    }
    const T = 3600;
    return { phase: 'RSG', L, R: radiusFrom(L, T), T, m, remnant: null };
  }
  t -= tSGB;
  const remnant: RemnantType = mi < 25 ? 'NS' : 'BH';
  const mRem = remnant === 'NS' ? 1.4 : clamp(mPre * 0.5, 3, 60);
  if (t < SN_DURATION_YR) {
    const L = supernovaLuminosity(t);
    const R = remnant === 'NS' ? 12e3 / R_SUN : blackHoleRadius(mRem * M_SUN) / R_SUN;
    return { phase: 'SN', L, R, T: 12000, m: mRem, remnant };
  }
  t -= SN_DURATION_YR;
  if (remnant === 'NS') return neutronStar(mRem, t);
  return { phase: 'BH', L: 0, R: blackHoleRadius(mRem * M_SUN) / R_SUN, T: 0, m: mRem, remnant: 'BH' };
}

/** Age (yr) at which each phase starts — used by UI "skip to" buttons. */
export function phaseStartAges(mi: number): Partial<Record<StarPhase, number>> {
  const tMS = msLifetime(mi);
  const out: Partial<Record<StarPhase, number>> = { MS: 0 };
  if (mi < 8) {
    const tSG = tMS * (mi <= 2 ? 0.08 : 0.03);
    const tRGB = tMS * (mi <= 2.2 ? 0.06 : 0.02);
    const tHB = tMS * (0.012 + 0.1 * clamp((mi - 1.5) / 3, 0, 1));
    const tAGB = Math.max(1e5, tMS * 0.002);
    out.SG = tMS;
    out.RGB = tMS + tSG;
    out.HB = tMS + tSG + tRGB;
    out.AGB = tMS + tSG + tRGB + tHB;
    out.PN = tMS + tSG + tRGB + tHB + tAGB;
    out.WD = tMS + tSG + tRGB + tHB + tAGB + PN_DURATION;
  } else {
    const tSGB = 0.1 * tMS;
    if (mi >= 40) out.WR = tMS;
    else {
      out.SGB = tMS;
      out.RSG = tMS + 0.01 * tMS;
    }
    out.SN = tMS + tSGB;
  }
  return out;
}

const CLASSES: [string, number, number][] = [
  ['O', 30000, 60000],
  ['B', 10000, 30000],
  ['A', 7500, 10000],
  ['F', 6000, 7500],
  ['G', 5200, 6000],
  ['K', 3700, 5200],
  ['M', 2400, 3700],
  ['L', 1300, 2400],
  ['T', 550, 1300],
  ['Y', 200, 550],
];

export function spectralClass(T: number, phase: StarPhase): string {
  if (phase === 'WD') return T > 12000 ? 'DA' : T > 7000 ? 'DA/DB' : 'DC';
  if (phase === 'NS') return 'Pulsar';
  if (phase === 'BH') return 'Black hole';
  if (phase === 'SN') return 'Supernova';
  if (phase === 'WR') return 'WN';
  let s = 'Y';
  for (const [c, lo, hi] of CLASSES) {
    if (T >= lo) {
      const sub = clamp(Math.floor((10 * (hi - T)) / (hi - lo)), 0, 9);
      s = `${c}${sub}`;
      break;
    }
  }
  const lum =
    phase === 'MS' ? ' V' : phase === 'SG' ? ' IV' : phase === 'RGB' || phase === 'HB' || phase === 'AGB' ? ' III' : phase === 'SGB' || phase === 'RSG' ? ' Ia' : '';
  return s + lum;
}

/** Fraction of bolometric luminosity emitted as X-ray/EUV (drives atmospheric escape). */
export function xuvFraction(ageYr: number, mSun: number, phase: StarPhase): number {
  if (phase === 'WD') return 0.05;
  if (phase === 'NS') return 0.9;
  if (phase === 'SN') return 0.05;
  if (phase === 'BD') return 1e-5;
  const tSat = mSun < 0.6 ? 1e9 : 1e8;
  const sat = 3.2e-4;
  if (ageYr <= tSat) return sat;
  return sat * Math.pow(ageYr / tSat, -1.23);
}

export const toSI = { L: (l: number) => l * L_SUN, R: (r: number) => r * R_SUN, M: (m: number) => m * M_SUN };

/** Stefan–Boltzmann effective temperature from SI luminosity and radius. */
export function teffSI(L: number, R: number): number {
  return Math.pow(L / (4 * Math.PI * R * R * SIGMA), 0.25);
}

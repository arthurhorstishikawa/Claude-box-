import { G_EARTH, R_GAS } from '../core/constants';

export type GasId = 'N2' | 'O2' | 'Ar' | 'CO2' | 'CH4' | 'H2' | 'He' | 'SO2' | 'NH3' | 'CFC';

export interface GasProps {
  id: GasId;
  name: string;
  formula: string;
  /** kg/mol */
  molar: number;
  /** Specific heat J/(kg K). */
  cp: number;
  /** Rayleigh cross-section per molecule relative to N2. */
  rayleigh: number;
  /** Condensation (sublimation) curve: reference T0 (K), P0 (Pa), latent heat (J/mol). */
  condense?: { T0: number; P0: number; Lmol: number };
  color: string;
  description: string;
}

export const GASES: Record<GasId, GasProps> = {
  N2: { id: 'N2', name: 'Nitrogen', formula: 'N₂', molar: 0.028014, cp: 1040, rayleigh: 1, condense: { T0: 63.15, P0: 12_500, Lmol: 6900 }, color: '#7f9cff', description: 'Inert bulk gas; pressure-broadens other absorbers.' },
  O2: { id: 'O2', name: 'Oxygen', formula: 'O₂', molar: 0.031998, cp: 918, rayleigh: 0.86, color: '#7fe0ff', description: 'Breathable; made by photosynthesis.' },
  Ar: { id: 'Ar', name: 'Argon', formula: 'Ar', molar: 0.039948, cp: 520, rayleigh: 0.89, color: '#c9a0ff', description: 'Noble gas, radiatively inert.' },
  CO2: { id: 'CO2', name: 'Carbon dioxide', formula: 'CO₂', molar: 0.04401, cp: 840, rayleigh: 2.45, condense: { T0: 194.7, P0: 101_325, Lmol: 25_200 }, color: '#ffb066', description: 'Main long-lived greenhouse gas; freezes into polar caps when cold.' },
  CH4: { id: 'CH4', name: 'Methane', formula: 'CH₄', molar: 0.01604, cp: 2220, rayleigh: 2.3, color: '#9cff8a', description: 'Strong greenhouse gas; forms organic haze at high abundance.' },
  H2: { id: 'H2', name: 'Hydrogen', formula: 'H₂', molar: 0.002016, cp: 14_300, rayleigh: 0.22, color: '#ffffff', description: 'Collision-induced absorption makes thick H₂ a powerful greenhouse gas; escapes easily.' },
  He: { id: 'He', name: 'Helium', formula: 'He', molar: 0.004003, cp: 5193, rayleigh: 0.064, color: '#ffe0f0', description: 'Light and inert; escapes from small worlds.' },
  SO2: { id: 'SO2', name: 'Sulfur dioxide', formula: 'SO₂', molar: 0.06407, cp: 640, rayleigh: 3, color: '#f4ff6a', description: 'Volcanic gas; forms reflective sulfuric-acid clouds in thick hot atmospheres.' },
  NH3: { id: 'NH3', name: 'Ammonia', formula: 'NH₃', molar: 0.017031, cp: 2175, rayleigh: 1.9, color: '#ff8ad8', description: 'Potent greenhouse gas, quickly photolysed.' },
  CFC: { id: 'CFC', name: 'Engineered greenhouse gas', formula: 'PFC/SF₆', molar: 0.146, cp: 665, rayleigh: 6, color: '#ff5d5d', description: 'Super-greenhouse gases proposed for terraforming; thousands of times stronger than CO₂.' },
};

export const GAS_ORDER: GasId[] = ['N2', 'O2', 'CO2', 'Ar', 'CH4', 'H2', 'He', 'SO2', 'NH3', 'CFC'];

/** Saturation (frost) vapour pressure from a Clausius–Clapeyron fit. */
export function gasSaturation(g: GasProps, T: number): number {
  const c = g.condense;
  if (!c) return Infinity;
  return c.P0 * Math.exp((-c.Lmol / R_GAS) * (1 / T - 1 / c.T0));
}

/** Frost point for partial pressure p. */
export function gasFrostPoint(g: GasProps, p: number): number {
  const c = g.condense;
  if (!c || p <= 0) return 0;
  return 1 / (1 / c.T0 - (Math.log(p / c.P0) * R_GAS) / c.Lmol);
}

// ---------------------------------------------------------------- condensable "volatile" (hydrology)

export interface VolatileProps {
  id: 'H2O' | 'CH4';
  name: string;
  molar: number;
  Rv: number;
  Lvap: number;
  Lfus: number;
  Lsub: number;
  Tmelt: number;
  /** Freezing point of the ocean (salty water: 271.35 K). */
  TfreezeOcean: number;
  rhoLiquid: number;
  rhoIce: number;
  cpLiquid: number;
  Tcrit: number;
  esat: (T: number) => number;
}

const esatWater = (T: number) => {
  const c = T - 273.15;
  if (T >= 273.15) {
    const tc = Math.min(c, 400);
    return 610.94 * Math.exp((17.625 * tc) / (tc + 243.04));
  }
  return 611.15 * Math.exp((22.452 * c) / (T - 0.61));
};

const esatMethane = (T: number) => 11_700 * Math.exp(-985 * (1 / T - 1 / 90.7));

export const VOLATILES: Record<'H2O' | 'CH4', VolatileProps> = {
  H2O: {
    id: 'H2O',
    name: 'Water',
    molar: 0.018015,
    Rv: 461.5,
    Lvap: 2.5e6,
    Lfus: 3.34e5,
    Lsub: 2.834e6,
    Tmelt: 273.15,
    TfreezeOcean: 271.35,
    rhoLiquid: 1000,
    rhoIce: 917,
    cpLiquid: 4186,
    Tcrit: 647,
    esat: esatWater,
  },
  CH4: {
    id: 'CH4',
    name: 'Methane',
    molar: 0.01604,
    Rv: 518.3,
    Lvap: 5.1e5,
    Lfus: 5.86e4,
    Lsub: 5.69e5,
    // Titan's seas are CH4–C2H6–N2 mixtures that stay liquid well below pure methane's 90.7 K.
    Tmelt: 82,
    TfreezeOcean: 82,
    rhoLiquid: 422,
    rhoIce: 494,
    cpLiquid: 3480,
    Tcrit: 190.6,
    esat: esatMethane,
  },
};

// ---------------------------------------------------------------- radiation

export interface BulkAtmosphere {
  /** Partial pressures (Pa) of non-condensing gases. */
  pp: Record<GasId, number>;
  pDry: number;
  /** Mean molar mass (kg/mol) of the dry air. */
  molar: number;
  cp: number;
  /** Mass-weighted Rayleigh efficiency relative to Earth air (per unit column mass). */
  rayleighPerMass: number;
}

export function emptyPartials(): Record<GasId, number> {
  return { N2: 0, O2: 0, Ar: 0, CO2: 0, CH4: 0, H2: 0, He: 0, SO2: 0, NH3: 0, CFC: 0 };
}

/** Convert gas masses (kg) to bulk properties for a planet of radius R and gravity g. */
export function bulkFromMasses(masses: Record<GasId, number>, R: number, g: number): BulkAtmosphere {
  const area = 4 * Math.PI * R * R;
  const pp = emptyPartials();
  let mTot = 0;
  let moles = 0;
  let cpSum = 0;
  let ray = 0;
  for (const id of GAS_ORDER) {
    const m = Math.max(0, masses[id] || 0);
    if (m <= 0) continue;
    mTot += m;
    const n = m / GASES[id].molar;
    moles += n;
    cpSum += m * GASES[id].cp;
    ray += n * GASES[id].rayleigh;
  }
  const pDry = (mTot * g) / area;
  const molar = moles > 0 ? mTot / moles : 0.029;
  for (const id of GAS_ORDER) {
    const m = Math.max(0, masses[id] || 0);
    if (m <= 0 || moles <= 0) continue;
    // Partial pressure by mole fraction.
    pp[id] = pDry * (m / GASES[id].molar / moles);
  }
  // Rayleigh optical depth ∝ molecules per area × cross-section; normalise to Earth air per unit mass.
  const earthAirPerKg = 1 / 0.02897;
  const rayleighPerMass = mTot > 0 ? ray / mTot / earthAirPerKg : 1;
  return { pp, pDry, molar, cp: mTot > 0 ? cpSum / mTot : 1004, rayleighPerMass };
}

/**
 * Gray infrared optical depth of the non-condensing gases (calibrated so that Earth, Venus,
 * Mars and Titan come out near their observed surface temperatures).
 */
export function dryOpticalDepth(pp: Record<GasId, number>, P: number, g: number): number {
  const gr = G_EARTH / Math.max(0.05, g);
  const pb = Math.max(P, 1) / 1e5;
  let tau = 0;
  if (pp.CO2 > 0) tau += 7.8e-4 * Math.pow(pp.CO2, 0.4075) * Math.pow(Math.max(P, 1), 0.3512);
  if (pp.CH4 > 0) tau += 0.012 * Math.sqrt(pp.CH4) * Math.pow(pb, 0.4);
  if (pp.NH3 > 0) tau += 0.03 * Math.sqrt(pp.NH3) * Math.pow(pb, 0.4);
  if (pp.SO2 > 0) tau += 0.01 * Math.sqrt(pp.SO2) * Math.pow(pb, 0.3);
  if (pp.CFC > 0) tau += 2.0 * Math.sqrt(pp.CFC);
  // Collision-induced absorption.
  tau += 0.06 * (pp.N2 / 1e5) * (pp.N2 / 1e5) * gr;
  tau += 0.4 * (pp.H2 / 1e5) * (pp.N2 / 1e5) * gr;
  tau += 0.3 * (pp.H2 / 1e5) * (pp.H2 / 1e5) * gr;
  return tau;
}

/** Infrared optical depth of the condensable vapour column w (kg/m²). */
export function vapourOpticalDepth(vol: 'H2O' | 'CH4', w: number, P: number, g: number): number {
  if (w <= 0) return 0;
  const pb = Math.max(P, 1) / 1e5;
  if (vol === 'H2O') return 0.197 * Math.pow(w, 0.25) * Math.pow(pb, 0.35);
  // Methane vapour: convert column to partial pressure.
  return 0.008 * Math.sqrt(w * g) * Math.pow(pb, 0.4);
}

/** Broadband Rayleigh optical depth (Earth ≈ 0.1). */
export function rayleighDepth(bulk: BulkAtmosphere, Ptot: number, g: number, spectralFactor: number): number {
  return 0.1 * (Ptot / 1e5) * (G_EARTH / Math.max(0.05, g)) * bulk.rayleighPerMass * spectralFactor;
}

/** Simpson–Nakajima limit on outgoing radiation from a moist atmosphere (W/m²). */
export function moistOLRLimit(g: number, vol: 'H2O' | 'CH4'): number {
  if (vol === 'CH4') return 30; // methane analogue at Titan-like temperatures
  return 282 * Math.pow(Math.max(0.05, g) / G_EARTH, 0.1);
}

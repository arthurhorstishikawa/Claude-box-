// Physical constants (SI) and astronomical reference values.
export const G = 6.6743e-11;
export const SIGMA = 5.670374419e-8; // Stefan–Boltzmann
export const KB = 1.380649e-23;
export const C_LIGHT = 299_792_458;
export const H_PLANCK = 6.62607015e-34;
export const R_GAS = 8.314462618; // J/(mol K)
export const AMU = 1.6605390666e-27;

export const AU = 1.495978707e11;
export const LY = 9.4607e15;
export const M_SUN = 1.98847e30;
export const R_SUN = 6.957e8;
export const L_SUN = 3.828e26;
export const T_SUN = 5772;
export const M_EARTH = 5.9722e24;
export const R_EARTH = 6.371e6;
export const M_JUP = 1.89813e27;
export const R_JUP = 6.9911e7;
export const M_MOON = 7.342e22;

export const SEC = 1;
export const MINUTE = 60;
export const HOUR = 3600;
export const DAY = 86_400;
export const YEAR = 365.25 * DAY;
export const KYR = 1e3 * YEAR;
export const MYR = 1e6 * YEAR;
export const GYR = 1e9 * YEAR;

export const G_EARTH = 9.80665;
export const S_EARTH = L_SUN / (4 * Math.PI * AU * AU); // ≈ 1361 W/m²
export const P_EARTH = 101_325;

export const DEG = Math.PI / 180;
export const TWO_PI = Math.PI * 2;

/** Water / ice. */
export const T_FREEZE = 273.15;
export const T_SEAWATER_FREEZE = 271.35;
export const L_VAP_WATER = 2.5e6;
export const L_FUS_WATER = 3.34e5;
export const L_SUB_WATER = 2.834e6;
export const RHO_WATER = 1000;
export const RHO_ICE = 917;
export const CP_WATER = 4186;
export const RV_WATER = 461.5;

/** Mass thresholds. */
export const M_DEUTERIUM = 13 * M_JUP; // brown dwarf threshold
export const M_HBURN = 0.075 * M_SUN; // hydrogen fusion threshold
export const M_CHANDRA = 1.44 * M_SUN;
export const M_TOV = 2.3 * M_SUN; // neutron star maximum

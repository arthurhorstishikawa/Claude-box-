export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => (x - a) / (b - a);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Wrap angle to (-π, π]. */
export const wrapPi = (a: number) => {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
};
/** Wrap angle to [0, 2π). */
export const wrap2Pi = (a: number) => {
  a %= 2 * Math.PI;
  return a < 0 ? a + 2 * Math.PI : a;
};
export const logLerp = (a: number, b: number, t: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
export const sq = (x: number) => x * x;
export const cube = (x: number) => x * x * x;
/** Smooth minimum of two positive values (p-norm style). */
export const softMin = (a: number, b: number, p = 8) => Math.pow(Math.pow(a, -p) + Math.pow(b, -p), -1 / p);
export const sign = (x: number) => (x < 0 ? -1 : 1);
/** Exponential relaxation factor for a step dt with timescale tau. */
export const relax = (dt: number, tau: number) => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));

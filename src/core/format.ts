import { AU, DAY, GYR, HOUR, KYR, M_EARTH, M_JUP, M_SUN, MINUTE, MYR, R_EARTH, R_JUP, R_SUN, YEAR } from './constants';

export type TempUnit = 'C' | 'K' | 'F';
export const displaySettings = { temp: 'C' as TempUnit };

const fix = (x: number, d: number) => {
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(d);
};

export function sig(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return '—';
  if (x === 0) return '0';
  const a = Math.abs(x);
  if (a >= 1e6 || a < 1e-3) return x.toExponential(Math.max(0, digits - 1)).replace('e+', 'e');
  const d = Math.max(0, digits - 1 - Math.floor(Math.log10(a)));
  return x.toFixed(Math.min(d, 6));
}

export function fmtTemp(k: number, unit: TempUnit = displaySettings.temp): string {
  if (!Number.isFinite(k)) return '—';
  if (unit === 'K') return `${fix(k, k < 100 ? 1 : 0)} K`;
  if (unit === 'F') return `${fix((k - 273.15) * 1.8 + 32, 0)} °F`;
  return `${fix(k - 273.15, Math.abs(k - 273.15) < 100 ? 1 : 0)} °C`;
}

export function tempValue(k: number, unit: TempUnit = displaySettings.temp): number {
  if (unit === 'K') return k;
  if (unit === 'F') return (k - 273.15) * 1.8 + 32;
  return k - 273.15;
}

export function fmtDistance(m: number): string {
  const a = Math.abs(m);
  if (a >= 0.05 * AU) return `${sig(m / AU, 3)} AU`;
  if (a >= 1e3) return `${sig(m / 1e3, 4)} km`;
  return `${sig(m, 3)} m`;
}

export function fmtRadius(m: number): string {
  if (m >= 0.1 * R_SUN) return `${sig(m / R_SUN, 3)} R☉`;
  if (m >= 2.5 * R_EARTH) return `${sig(m / R_JUP, 3)} R♃ (${sig(m / 1e3, 3)} km)`;
  if (m >= 0.05 * R_EARTH) return `${sig(m / R_EARTH, 3)} R⊕ (${sig(m / 1e3, 4)} km)`;
  return `${sig(m / 1e3, 3)} km`;
}

export function fmtMass(kg: number): string {
  if (kg >= 0.01 * M_SUN) return `${sig(kg / M_SUN, 3)} M☉`;
  if (kg >= 0.05 * M_JUP) return `${sig(kg / M_JUP, 3)} M♃`;
  if (kg >= 1e-4 * M_EARTH) return `${sig(kg / M_EARTH, 3)} M⊕`;
  return `${sig(kg, 3)} kg`;
}

export function fmtDuration(s: number, short = false): string {
  const a = Math.abs(s);
  const sgn = s < 0 ? '-' : '';
  if (a < MINUTE) return `${sgn}${sig(a, 2)} s`;
  if (a < HOUR) return `${sgn}${sig(a / MINUTE, 3)} ${short ? 'min' : 'min'}`;
  if (a < DAY) return `${sgn}${sig(a / HOUR, 3)} h`;
  if (a < YEAR) return `${sgn}${sig(a / DAY, 3)} d`;
  if (a < KYR) return `${sgn}${sig(a / YEAR, 3)} yr`;
  if (a < MYR) return `${sgn}${sig(a / KYR, 3)} kyr`;
  if (a < GYR) return `${sgn}${sig(a / MYR, 3)} Myr`;
  return `${sgn}${sig(a / GYR, 3)} Gyr`;
}

export function fmtRate(simSecondsPerSecond: number): string {
  if (simSecondsPerSecond <= 0) return 'paused';
  if (simSecondsPerSecond < 1.5) return 'real time';
  return `${fmtDuration(simSecondsPerSecond, true)} / s`;
}

export function fmtPressure(pa: number): string {
  if (pa <= 0 || !Number.isFinite(pa)) return '0';
  if (pa >= 1e4) return `${sig(pa / 1e5, 3)} bar`;
  if (pa >= 1) return `${sig(pa / 100, 3)} hPa`;
  return `${sig(pa * 1e3, 3)} mPa`;
}

export function fmtPct(x: number, d = 0): string {
  return `${fix(x * 100, d)}%`;
}

export function fmtPpm(frac: number): string {
  if (frac >= 0.01) return `${sig(frac * 100, 3)}%`;
  if (frac >= 1e-6) return `${sig(frac * 1e6, 3)} ppm`;
  return `${sig(frac * 1e9, 3)} ppb`;
}

export function fmtPower(w: number): string {
  return `${sig(w, 3)} W/m²`;
}

/** Calendar-style date relative to an epoch (ms since 1970) for scenarios with real dates. */
export function fmtDate(epochMs: number | null, simSeconds: number): string {
  if (epochMs !== null && Math.abs(simSeconds) < 5000 * YEAR) {
    const d = new Date(epochMs + simSeconds * 1000);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getUTCFullYear();
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
    }
  }
  const a = Math.abs(simSeconds);
  if (a < YEAR) return `Day ${(simSeconds / DAY).toFixed(1)}`;
  return `Year ${sig(simSeconds / YEAR, 6)}`;
}

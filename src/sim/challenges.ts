import { YEAR } from '../core/constants';
import { fmtDuration, fmtPct, fmtPressure, fmtTemp } from '../core/format';
import type { Body } from '../physics/body';
import { TerrestrialClimate } from '../climate/terrestrial';
import type { Simulation } from './simulation';

export interface ChallengeCheck {
  ok: boolean;
  /** 0..1 progress toward the goal condition (for the HUD bar). */
  progress: number;
  status: string;
}

export interface Challenge {
  id: string;
  name: string;
  description: string;
  scenario: string;
  target: string;
  /** How long (s of sim time) the goal must hold continuously. */
  hold: number;
  hints: string[];
  setup?: (sim: Simulation) => void;
  check: (sim: Simulation, body: Body) => ChallengeCheck;
}

const climate = (b: Body) => (b.climate instanceof TerrestrialClimate ? b.climate : null);

export const CHALLENGES: Challenge[] = [
  {
    id: 'terraform-mars',
    name: 'Terraform Mars',
    description: 'Make at least 30% of Mars habitable for liquid water with ≥ 0.25 bar of air, and keep it that way for 10 years.',
    scenario: 'solar',
    target: 'Mars',
    hold: 10 * YEAR,
    hints: ['Add CO₂ and N₂ in the Atmosphere tab', 'Engineered greenhouse gases are thousands of times stronger than CO₂', 'An orbital mirror (insolation > 100%) adds sunlight', 'Comets bring water — or add it directly'],
    check: (_s, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: 'Mars is gone!' };
      const hab = c.stats.habitable;
      const p = c.stats.P;
      const ok = hab >= 0.3 && p >= 2.5e4;
      return { ok, progress: Math.min(1, Math.min(hab / 0.3, p / 2.5e4)), status: `Habitable ${fmtPct(hab)} · ${fmtPressure(p)} · ${fmtTemp(c.stats.meanT)}` };
    },
  },
  {
    id: 'cool-venus',
    name: 'Cool Venus',
    description: 'Bring Venus’s mean surface temperature below 60 °C and hold it for 20 years.',
    scenario: 'solar',
    target: 'Venus',
    hold: 20 * YEAR,
    hints: ['Most of the heat is trapped by 92 bar of CO₂ — remove it', 'A sunshade (insolation < 100%) cuts the energy input', 'Removing SO₂ dissolves the bright sulfuric clouds (which actually cool Venus!)'],
    check: (_s, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: 'Venus is gone!' };
      const t = c.stats.meanT;
      return { ok: t < 333, progress: Math.max(0, Math.min(1, (735 - t) / (735 - 333))), status: `Surface ${fmtTemp(t)} · ${fmtPressure(c.stats.P)}` };
    },
  },
  {
    id: 'thaw-snowball',
    name: 'Escape Snowball Earth',
    description: 'Get the ice cover below 40% with open oceans, and keep it there for a century.',
    scenario: 'snowball',
    target: 'Snowball Earth',
    hold: 100 * YEAR,
    hints: ['Volcanoes keep adding CO₂ while ice stops weathering — speed time up with Geology on', 'Dark dust or soot lowers the albedo', 'Brighten the young Sun?'],
    check: (_s, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: '—' };
      const ice = c.stats.iceFrac;
      return { ok: ice < 0.4, progress: Math.max(0, Math.min(1, (1 - ice) / 0.6)), status: `Ice ${fmtPct(ice)} · CO₂ ${fmtPressure(c.stats.pp.CO2 ?? 0)} · ${fmtTemp(c.stats.meanT)}` };
    },
  },
  {
    id: 'two-degrees',
    name: 'Stay below +2 °C',
    description: 'Keep Earth within +2 °C of its starting temperature for 150 years while its civilization keeps over a billion people.',
    scenario: 'earthmoon',
    target: 'Earth',
    hold: 150 * YEAR,
    hints: ['Push the clean-energy transition (Life tab)', 'Capture carbon by removing CO₂', 'A small sunshade offsets warming — but not ocean acidification'],
    setup: (sim) => {
      const e = sim.bodies.find((b) => b.name === 'Earth');
      const c = e && climate(e);
      if (c) (sim as any).challengeBaseline = c.stats.meanT;
    },
    check: (sim, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: '—' };
      const base = (sim as any).challengeBaseline ?? c.stats.meanT;
      const dT = c.stats.meanT - base;
      const pop = c.civ?.totalPop ?? 0;
      const ok = dT < 2 && pop > 1e9;
      return { ok, progress: ok ? 1 : 0, status: `ΔT ${dT >= 0 ? '+' : ''}${dT.toFixed(2)} K · population ${(pop / 1e9).toFixed(2)} billion` };
    },
  },
  {
    id: 'eyeball',
    name: 'Wake the eyeball world',
    description: 'Make 40% of Proxima b habitable for 20 years by spreading the dayside heat.',
    scenario: 'proxima',
    target: 'Proxima b',
    hold: 20 * YEAR,
    hints: ['Thicker air carries heat to the night side', 'CO₂ warms the frozen far side', 'Or end the tidal lock with a giant impact…'],
    check: (_s, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: '—' };
      const hab = c.stats.habitable;
      return { ok: hab >= 0.4, progress: Math.min(1, hab / 0.4), status: `Habitable ${fmtPct(hab)} · ${fmtTemp(c.stats.minT)} … ${fmtTemp(c.stats.maxT)}` };
    },
  },
  {
    id: 'save-earth',
    name: 'Outlast the brightening Sun',
    description: 'The Sun is 10% brighter. Keep Earth below 35 °C with oceans for 200 million years.',
    scenario: 'futuresun',
    target: 'Earth',
    hold: 2e8 * YEAR,
    hints: ['Move Earth outward (Orbit tab)', 'A sunshade buys time', 'Pull CO₂ out of the air'],
    check: (_s, b) => {
      const c = climate(b);
      if (!c) return { ok: false, progress: 0, status: 'Earth is gone!' };
      const ok = c.stats.meanT < 308 && c.stats.oceanFrac > 0.3;
      return { ok, progress: ok ? 1 : 0, status: `${fmtTemp(c.stats.meanT)} · oceans ${fmtPct(c.stats.oceanFrac)}` };
    },
  },
];

export interface ChallengeState {
  challenge: Challenge;
  heldFor: number;
  won: boolean;
  failed: boolean;
  last: ChallengeCheck;
}

export function updateChallenge(st: ChallengeState, sim: Simulation, dt: number): ChallengeState {
  if (st.won) return st;
  const body = sim.bodies.find((b) => b.name === st.challenge.target);
  if (!body) {
    st.failed = true;
    st.last = { ok: false, progress: 0, status: `${st.challenge.target} no longer exists.` };
    return st;
  }
  const r = st.challenge.check(sim, body);
  st.last = r;
  st.heldFor = r.ok ? st.heldFor + dt : 0;
  if (st.heldFor >= st.challenge.hold) {
    st.won = true;
    sim.notify(`🏆 Challenge complete: ${st.challenge.name}! (${fmtDuration(sim.time)} of simulated time)`, 'success', body.id);
  }
  return st;
}

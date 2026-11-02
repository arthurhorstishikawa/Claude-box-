import { M_DEUTERIUM, M_EARTH, M_HBURN, M_SUN, R_EARTH, R_SUN } from '../core/constants';
import { clamp } from '../core/math';
import { blackHoleRadius, whiteDwarfRadius } from '../stars/stellar';
import type { Body, BodyKind, Composition } from './body';

export function classifyBody(b: Body): BodyKind {
  const s = b.star;
  if (s) {
    if (s.model === 'BH' || s.phase === 'BH') return 'blackHole';
    if (s.model === 'NS' || s.phase === 'NS') return 'neutronStar';
    if (s.model === 'WD' || s.phase === 'WD') return 'whiteDwarf';
    if (s.phase === 'SN') return s.snapshot?.remnant === 'BH' ? 'blackHole' : 'neutronStar';
    if (s.model === 'BD') return 'brownDwarf';
    return 'star';
  }
  if (b.mass >= M_HBURN) return 'star';
  if (b.mass >= M_DEUTERIUM) return 'brownDwarf';
  const me = b.mass / M_EARTH;
  if (b.composition.gas >= 0.03 && me >= 1.5) return me >= 50 ? 'gasGiant' : 'iceGiant';
  if (b.mass < 5e19) return 'smallBody';
  return 'terrestrial';
}

export function defaultComposition(kind: BodyKind): Composition {
  switch (kind) {
    case 'gasGiant':
      return { iron: 0.02, rock: 0.04, ice: 0.04, gas: 0.9 };
    case 'iceGiant':
      return { iron: 0.05, rock: 0.15, ice: 0.65, gas: 0.15 };
    case 'brownDwarf':
    case 'star':
      return { iron: 0, rock: 0, ice: 0, gas: 1 };
    case 'smallBody':
      return { iron: 0.15, rock: 0.75, ice: 0.1, gas: 0 };
    default:
      return { iron: 0.32, rock: 0.68, ice: 0, gas: 0 };
  }
}

function rockyRadius(mass: number, c: Composition): number {
  const me = mass / M_EARTH;
  const comp = clamp(1 + 0.3 * c.ice - 0.4 * (c.iron - 0.32), 0.6, 1.6);
  const power = R_EARTH * comp * Math.pow(Math.max(me, 1e-12), 0.27);
  // Small bodies: uncompressed density.
  const rho = 1 / (c.iron / 7800 + c.rock / 3300 + c.ice / 1000 + 1e-9);
  const dens = Math.cbrt((3 * mass) / (4 * Math.PI * rho));
  if (me >= 0.05) return power;
  if (me <= 0.002) return dens;
  const t = Math.log(me / 0.002) / Math.log(0.05 / 0.002);
  return Math.exp(Math.log(dens) * (1 - t) + Math.log(power) * t);
}

function giantRadius(mass: number): number {
  const me = mass / M_EARTH;
  if (me < 111) return R_EARTH * 3.9 * Math.pow(me / 17.15, 0.59);
  return R_EARTH * 11.21 * Math.pow(me / 317.8, -0.044);
}

/** Radius (m) from mass, kind and composition (not for stars on evolutionary tracks). */
export function radiusFromMass(kind: BodyKind, mass: number, c: Composition): number {
  switch (kind) {
    case 'blackHole':
      return blackHoleRadius(mass);
    case 'neutronStar':
      return 12e3;
    case 'whiteDwarf':
      return whiteDwarfRadius(mass / M_SUN) * R_SUN;
    case 'brownDwarf':
    case 'gasGiant':
      return giantRadius(mass);
    case 'iceGiant': {
      const rock = rockyRadius(mass, c);
      const nep = giantRadius(mass);
      if (c.gas >= 0.1) return nep;
      return Math.min(nep, rock * (1 + 25 * c.gas));
    }
    case 'star':
      return R_SUN * Math.pow(mass / M_SUN, 0.8);
    default:
      return rockyRadius(mass, c);
  }
}

/** Recompute a body's radius honouring its preset anchor. */
export function updateRadius(b: Body): void {
  if (b.star && (b.kind === 'star' || b.kind === 'brownDwarf' || b.kind === 'whiteDwarf' || b.kind === 'neutronStar' || b.kind === 'blackHole')) {
    b.radius = b.star.R;
    return;
  }
  const r = radiusFromMass(b.kind, b.mass, b.composition);
  if (b.radiusAnchor) {
    const ra = radiusFromMass(b.kind, b.radiusAnchor.mass, b.composition);
    b.radius = (b.radiusAnchor.radius * r) / ra;
  } else b.radius = r;
}

/** Human-readable class name, using the orbital hierarchy for planets vs moons. */
export function kindLabel(b: Body, primary: Body | null): string {
  switch (b.kind) {
    case 'star':
      return 'Star';
    case 'brownDwarf':
      return 'Brown dwarf';
    case 'whiteDwarf':
      return 'White dwarf';
    case 'neutronStar':
      return 'Neutron star';
    case 'blackHole':
      return 'Black hole';
    case 'gasGiant':
      return primary && !primary.isStarLike ? 'Gas-giant moon' : 'Gas giant';
    case 'iceGiant':
      return primary && !primary.isStarLike ? 'Ice-giant moon' : b.mass < 8 * M_EARTH ? 'Mini-Neptune' : 'Ice giant';
    case 'smallBody':
      return b.composition.ice > 0.3 ? 'Comet' : 'Asteroid';
    default: {
      const isMoon = primary !== null && !primary.isStarLike;
      if (isMoon) return 'Moon';
      if (b.mass < 0.01 * M_EARTH) return 'Dwarf planet';
      if (b.mass > 2 * M_EARTH) return 'Super-Earth';
      return 'Terrestrial planet';
    }
  }
}

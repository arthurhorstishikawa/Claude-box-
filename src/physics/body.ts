import { G, L_SUN, M_EARTH, R_EARTH, SIGMA, TWO_PI } from '../core/constants';
import { V3 } from '../core/vec3';
import type { StarPhase, StarSnapshot } from '../stars/stellar';
import type { TerrestrialClimate } from '../climate/terrestrial';
import type { GasGiantClimate } from '../climate/gasGiant';
import type { TerrainStyle } from '../climate/terrain';

export type BodyKind =
  | 'star'
  | 'brownDwarf'
  | 'gasGiant'
  | 'iceGiant'
  | 'terrestrial'
  | 'smallBody'
  | 'whiteDwarf'
  | 'neutronStar'
  | 'blackHole';

export interface Composition {
  iron: number;
  rock: number;
  ice: number;
  gas: number;
}

export type StarModel = 'track' | 'WD' | 'NS' | 'BH' | 'BD';

export interface StarState {
  model: StarModel;
  /** Initial (zero-age) mass for evolutionary tracks, kg. */
  initialMass: number;
  /** Stellar age, s. For fixed remnants: time since the remnant formed. */
  age: number;
  /** Calibration multipliers (presets match observed L, R). */
  fL: number;
  fR: number;
  phase: StarPhase;
  /** SI luminosity, radius, effective temperature. */
  L: number;
  R: number;
  T: number;
  snapshot: StarSnapshot | null;
  /** Sim time of a supernova explosion (for visuals and blast physics). */
  snTime: number | null;
  typeIa: boolean;
  /** Visual spin for pulsars etc. */
  activity: number;
}

export interface RingSystem {
  inner: number;
  outer: number;
  mass: number;
  seed: number;
  color: [number, number, number];
  opacity: number;
}

/** What a world is made of at the surface — used to (re)build its climate model. */
export interface WorldSpec {
  /** Partial pressures in Pa at creation (converted to gas masses by the climate model). */
  atmosphere: Record<string, number>;
  /** Global-equivalent layer of the primary volatile (water or methane), metres. */
  waterGEL: number;
  volatile: 'H2O' | 'CH4';
  biosphere: boolean;
  terrain: TerrainStyle;
  terrainSeed: number;
  /** Optional fixed haze optical depth (Titan) and dust (Mars). */
  haze?: number;
  dust?: number;
  /** Initial global-mean temperature guess (K). */
  initialTemp?: number;
  /** Initial ice-cap latitude (deg) for presets such as Earth/Mars. */
  iceCapLat?: number;
}

export interface GiantSpec {
  palette: 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'auto';
  seed: number;
  /** Intrinsic (internal) temperature, K. If absent, derived from mass/age. */
  tInt?: number;
  /** Named persistent vortices for presets (Great Red Spot etc.). */
  vortices?: { lat: number; lon: number; size: number; color: [number, number, number] }[];
}

let nextId = 1;

export class Body {
  id = nextId++;
  name: string;
  mass: number;
  radius: number;
  /** If set, radius follows the mass-radius relation scaled to pass through this anchor. */
  radiusAnchor: { mass: number; radius: number } | null = null;
  pos = new V3();
  vel = new V3();
  composition: Composition = { iron: 0.32, rock: 0.68, ice: 0, gas: 0 };
  /** Unit spin axis (inertial). */
  spinAxis = new V3(0, 0, 1);
  /** Unit vector ⟂ spinAxis giving the prime meridian at rotationAngle = 0. */
  primeRef = new V3(1, 0, 0);
  /** Sidereal rotation period (s); negative = retrograde. */
  rotationPeriod = 86_400;
  rotationAngle = 0;
  tidallyLocked = false;
  /** Progress toward tidal locking (0..1). */
  lockProgress = 0;
  /** Period of axial precession driven by stellar and lunar torques (s); Infinity if none. */
  precessionPeriod = Infinity;
  /** Recent stellar flare brightening (0 = quiet), decays in minutes. */
  flare = 0;
  kind: BodyKind = 'terrestrial';
  star: StarState | null = null;
  climate: TerrestrialClimate | GasGiantClimate | null = null;
  world: WorldSpec | null = null;
  giant: GiantSpec | null = null;
  rings: RingSystem | null = null;
  /** Baseline internal heat flux (W/m²): geothermal or intrinsic planetary heat. */
  internalHeat = 0.087;
  /** Tidal heating (W/m²), computed each frame. */
  tidalHeat = 0;
  /** Extra internal heat from impacts, decays over time (W/m²). */
  impactHeat = 0;
  /** Energy (J) waiting to be deposited into the surface by the climate model. */
  heatPulse = 0;
  /** Sunshade (<1) / orbital mirror (>1) multiplier on received starlight. */
  insolationFactor = 1;
  /** Fixed forced eccentricity for tidal heating (resonant moons). */
  forcedEcc = 0;
  /** Smoothed osculating eccentricity around the primary. */
  eccSmoothed = 0;
  /** Age (s) — giant planet cooling, crater counts etc. */
  age = 4.5e9 * 3.15576e7;
  /** Display hierarchy (computed). */
  primaryId: number | null = null;
  alive = true;
  /** UI accent colour. */
  color = '#9ab';
  description = '';
  createdAt = 0;

  constructor(name: string, mass: number, radius: number) {
    this.name = name;
    this.mass = mass;
    this.radius = radius;
  }

  get isStarLike(): boolean {
    return this.kind === 'star' || this.kind === 'whiteDwarf' || this.kind === 'neutronStar' || this.kind === 'blackHole' || this.kind === 'brownDwarf';
  }
  get isGiant(): boolean {
    return this.kind === 'gasGiant' || this.kind === 'iceGiant' || this.kind === 'brownDwarf';
  }
  get isRocky(): boolean {
    return this.kind === 'terrestrial' || this.kind === 'smallBody';
  }

  /** Bolometric luminosity (W) if this body is a light source. */
  luminosity(): number {
    if (this.star) return this.star.L;
    return 0;
  }
  surfaceGravity(): number {
    return (G * this.mass) / (this.radius * this.radius);
  }
  escapeVelocity(): number {
    return Math.sqrt((2 * G * this.mass) / this.radius);
  }
  density(): number {
    return this.mass / ((4 / 3) * Math.PI * this.radius ** 3);
  }
  /** Angular rotation rate (rad/s), signed. */
  omega(): number {
    return Number.isFinite(this.rotationPeriod) && this.rotationPeriod !== 0 ? TWO_PI / this.rotationPeriod : 0;
  }

  /** Body-fixed frame (x = prime meridian, z = north pole) expressed in inertial coordinates. */
  frame(): { x: V3; y: V3; z: V3 } {
    const z = this.spinAxis;
    const x = V3.rotate(this.primeRef, z, this.rotationAngle);
    const y = z.cross(x);
    return { x, y, z };
  }

  /** Inertial vector → body-fixed coordinates. */
  toBody(v: V3, f = this.frame()): V3 {
    return new V3(v.dot(f.x), v.dot(f.y), v.dot(f.z));
  }

  /** Set spin axis keeping primeRef orthogonal. */
  setSpinAxis(axis: V3): void {
    this.spinAxis = axis.clone().normalize();
    let p = this.primeRef.clone().addScaled(this.spinAxis, -this.primeRef.dot(this.spinAxis));
    if (p.len() < 1e-6) p = V3.perpendicular(this.spinAxis);
    this.primeRef = p.normalize();
  }

  /** Equilibrium temperature for zero albedo at the given flux (diagnostic). */
  static equilibriumTemp(flux: number, albedo = 0.3): number {
    return Math.pow((flux * (1 - albedo)) / (4 * SIGMA), 0.25);
  }
}

export function resetBodyIds(start = 1): void {
  nextId = start;
}
export function bumpBodyId(minNext: number): void {
  nextId = Math.max(nextId, minNext);
}

export const EARTH_REF = { mass: M_EARTH, radius: R_EARTH, L: L_SUN };

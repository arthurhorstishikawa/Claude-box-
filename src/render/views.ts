import * as THREE from 'three';
import { L_SUN, R_GAS, SIGMA, T_SUN } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { V3 } from '../core/vec3';
import type { Body } from '../physics/body';
import { blackbodyRGB } from '../stars/blackbody';
import { GasGiantClimate } from '../climate/gasGiant';
import { TerrestrialClimate } from '../climate/terrestrial';
import { plantPigment } from '../climate/life';
import type { TerrainStyle } from '../climate/terrain';
import {
  makeAtmosphereMaterial,
  makeCloudShellMaterial,
  makeGiantMaterial,
  makeGlowMaterial,
  makeRingMaterial,
  makeStarMaterial,
  makeTerrainMaterial,
  makeVolumeCloudMaterial,
} from './materials';
import { buildPatchGeometry, HeightField, parentNode, patchNode, selectPatches, type PatchNode } from './terrain';
import { bandTexture, ClimateTextures, elevationTexture, ringTexture, thermalTexture, updateElevationTexture } from './textures';
import { bodyBasis, rel, toThree } from './units';
import { LAYERS, view, type LayerId } from './viewSettings';

export interface LightSrc {
  body: Body;
  color: [number, number, number];
  L: number;
}

export interface FrameCtx {
  camPos: V3;
  exposure: number;
  realistic: boolean;
  simTime: number;
  realTime: number;
  dt: number;
  lights: LightSrc[];
  focusId: number | null;
  layer: LayerId;
  cameraAlt: number;
  pixelScale: number;
}

const TMP = new THREE.Vector3();

/** Fill the shared light/ambient uniforms for a body. */
export function setLights(u: Record<string, THREE.IUniform>, body: Body, ctx: FrameCtx): void {
  const list = ctx.lights
    .filter((l) => l.body !== body)
    .map((l) => {
      const d = V3.sub(l.body.pos, body.pos);
      const r = Math.max(d.len(), 1);
      return { l, dir: toThree(d.scale(1 / r)), flux: (l.L / (4 * Math.PI * r * r)) * body.insolationFactor };
    })
    .sort((a, b) => b.flux - a.flux)
    .slice(0, 2);
  u.uNumSuns.value = list.length;
  list.forEach((x, i) => {
    (u.uSunDir.value as THREE.Vector3[])[i].copy(x.dir);
    const s = ctx.realistic ? (x.flux / 1361) * ctx.exposure : Math.pow(x.flux / 1361, 0.33) * 1.1;
    (u.uSunRadiance.value as THREE.Vector3[])[i].set(x.l.color[0] * s, x.l.color[1] * s, x.l.color[2] * s);
  });
  if (u.uAmbient) {
    const a = ctx.realistic ? 2e-9 * ctx.exposure : 0.035;
    (u.uAmbient.value as THREE.Vector3).set(a * 0.8, a * 0.85, a);
  }
  if (u.uExposure) u.uExposure.value = ctx.realistic ? ctx.exposure : 1;
}

export abstract class BodyView {
  group = new THREE.Group();
  constructor(public body: Body) {
    this.group.matrixAutoUpdate = true;
  }
  abstract update(ctx: FrameCtx): void;
  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat && !(mat as any).__shared) mat.dispose();
    });
  }
  protected place(ctx: FrameCtx): void {
    rel(this.body.pos, ctx.camPos, this.group.position);
    const basis = bodyBasis(this.body.frame());
    this.group.quaternion.setFromRotationMatrix(basis);
  }
}

// ---------------------------------------------------------------------------- rocky worlds

const ROCK: Record<TerrainStyle, [[number, number, number], [number, number, number]]> = {
  earthlike: [[0.24, 0.2, 0.17], [0.46, 0.4, 0.33]],
  oceanic: [[0.22, 0.2, 0.18], [0.42, 0.38, 0.32]],
  continental: [[0.36, 0.27, 0.19], [0.6, 0.48, 0.34]],
  marslike: [[0.32, 0.13, 0.06], [0.62, 0.32, 0.16]],
  venuslike: [[0.3, 0.24, 0.16], [0.45, 0.36, 0.24]],
  moonlike: [[0.09, 0.09, 0.09], [0.3, 0.29, 0.28]],
  mercurylike: [[0.16, 0.15, 0.14], [0.32, 0.3, 0.28]],
  europalike: [[0.42, 0.28, 0.2], [0.88, 0.86, 0.8]],
  ganymedelike: [[0.22, 0.2, 0.18], [0.6, 0.58, 0.55]],
  callistolike: [[0.14, 0.13, 0.12], [0.42, 0.4, 0.38]],
  iolike: [[0.45, 0.32, 0.08], [0.95, 0.85, 0.4]],
  titanlike: [[0.12, 0.08, 0.04], [0.32, 0.22, 0.12]],
  plutolike: [[0.35, 0.18, 0.1], [0.92, 0.86, 0.78]],
  tritonlike: [[0.55, 0.45, 0.42], [0.86, 0.8, 0.76]],
  asteroid: [[0.12, 0.11, 0.1], [0.32, 0.3, 0.28]],
  lavaworld: [[0.07, 0.06, 0.06], [0.16, 0.13, 0.11]],
};

const DETAIL: Partial<Record<TerrainStyle, number>> = {
  earthlike: 260,
  oceanic: 220,
  continental: 300,
  marslike: 320,
  venuslike: 200,
  moonlike: 380,
  mercurylike: 380,
  europalike: 60,
  titanlike: 120,
  asteroid: 900,
  iolike: 220,
};

export class RockyView extends BodyView {
  material = makeTerrainMaterial();
  private patches = new Map<string, THREE.Mesh>();
  private shown: THREE.Mesh[] = [];
  private hf: HeightField | null = null;
  private elevTex: THREE.DataTexture | null = null;
  private terrainVersion = -1;
  private seaBuilt = NaN;
  private tex: ClimateTextures | null = null;
  private texClock = 0;
  private cloudShell: THREE.Mesh;
  private cloudMat = makeCloudShellMaterial();
  private volume: THREE.Mesh;
  private volMat: THREE.ShaderMaterial;
  private atmo: THREE.Mesh;
  private atmoMat = makeAtmosphereMaterial();
  private dummy: THREE.DataTexture;
  cloudTop = 10e3;

  constructor(body: Body, noise3d: THREE.Data3DTexture) {
    super(body);
    this.dummy = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    this.dummy.needsUpdate = true;
    this.cloudShell = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), this.cloudMat);
    this.cloudShell.renderOrder = 2;
    this.volMat = makeVolumeCloudMaterial(noise3d);
    this.volume = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.volMat);
    this.volume.renderOrder = 3;
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.atmoMat);
    this.atmo.renderOrder = 4;
    for (const m of [this.cloudShell, this.volume, this.atmo]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  get climate(): TerrestrialClimate | null {
    return this.body.climate instanceof TerrestrialClimate ? this.body.climate : null;
  }

  /** Terrain height (m above the reference radius) for camera collision. */
  heightAt(lat: number, lon: number): number {
    if (!this.hf) return 0;
    const d = new V3(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
    const h = this.hf.height(d, 15);
    const c = this.climate;
    if (c && c.waterTotal > 0 && Number.isFinite(c.seaLevel)) return Math.max(h, c.seaLevel);
    return h;
  }

  private ensureTerrain(): void {
    const c = this.climate;
    const R = this.body.radius;
    if (!c) {
      if (!this.hf && this.body.world) {
        // Bodies without a climate model (asteroids) still get terrain.
        const { generateTerrain } = require_terrain();
        const map = generateTerrain(this.body.world.terrain, this.body.world.terrainSeed, 128, 64);
        this.hf = new HeightField(map, R, this.body.world.terrainSeed, DETAIL[this.body.world.terrain] ?? 200);
        this.elevTex = elevationTexture(map);
      }
      return;
    }
    if (!this.hf || this.terrainVersion !== c.terrainVersion || this.hf.radius !== R) {
      this.hf = new HeightField(c.terrain, R, c.seed, DETAIL[c.style] ?? 150);
      if (this.elevTex && this.elevTex.image.width === c.terrain.w) updateElevationTexture(this.elevTex, c.terrain);
      else {
        this.elevTex?.dispose();
        this.elevTex = elevationTexture(c.terrain);
      }
      this.clearPatches();
      this.terrainVersion = c.terrainVersion;
    }
  }

  private clearPatches(): void {
    for (const m of this.patches.values()) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.patches.clear();
    this.shown = [];
  }

  private atmosphereParams(): { betaR: THREE.Vector3; betaM: THREE.Vector3; mieAlb: THREE.Vector3; Hr: number; Hm: number; top: number; has: boolean; g: number; deck: number } {
    const c = this.climate;
    const R = this.body.radius;
    const g = this.body.surfaceGravity();
    if (!c || c.P < 5) return { betaR: new THREE.Vector3(), betaM: new THREE.Vector3(), mieAlb: new THREE.Vector3(1, 1, 1), Hr: 8000, Hm: 1000, top: R * 1.001, has: false, g, deck: 0 };
    const T = Math.max(40, c.stats.meanT || 250);
    const molar = c.bulk?.molar || 0.029;
    const Hr = clamp((R_GAS * T) / (molar * g), 500, R * 0.2);
    const perMol = (c.bulk?.rayleighPerMass ?? 1) * (molar / 0.02897);
    const nRel = (c.P / 1e5) * (288 / T);
    const k = nRel * perMol;
    const betaR = new THREE.Vector3(5.8e-6 * k, 13.5e-6 * k, 33.1e-6 * k);
    // Aerosols: background haze, Martian dust, Titan haze, impact/industrial aerosols, Venus deck.
    const dust = c.dust;
    const haze = c.hazeBase;
    const deck = (c.bulk?.pp.SO2 ?? 0) > 1 && c.P > 5e5 ? smoothstep(5e5, 3e6, c.P) : 0;
    const Hm = haze > 0 ? Hr * 2.5 : Math.max(Hr * 0.25, 800);
    const tauM = 0.03 * Math.min(1, c.P / 1e5) + dust * 0.9 + haze * 3 + c.aerosol * 0.5 + deck * 20;
    const bm = tauM / Hm;
    const betaM = new THREE.Vector3(bm, bm, bm);
    let mieAlb = new THREE.Vector3(0.92, 0.92, 0.92);
    if (dust > 0.05) mieAlb = new THREE.Vector3(0.95, 0.68, 0.45);
    if (haze > 0.1) mieAlb = new THREE.Vector3(0.95, 0.62, 0.22);
    if (deck > 0.1) mieAlb = new THREE.Vector3(0.98, 0.93, 0.78);
    const top = R + Math.min(Math.max(10 * Hr, 6 * Hm), R * 0.5);
    return { betaR, betaM, mieAlb, Hr, Hm, top, has: true, g, deck };
  }

  update(ctx: FrameCtx): void {
    const b = this.body;
    const R = b.radius;
    this.place(ctx);
    this.ensureTerrain();
    if (!this.hf || !this.elevTex) return;
    const c = this.climate;
    const u = this.material.uniforms;
    const focus = ctx.focusId === b.id;
    // --- climate textures (throttled)
    this.texClock -= ctx.dt;
    const ap = this.atmosphereParams();
    if (c) {
      if (!this.tex || !this.tex.fits(c)) {
        this.tex?.dispose();
        this.tex = new ClimateTextures(c.grid.nLon, c.grid.nLat);
        this.texClock = 0;
      }
      if (this.texClock <= 0 && (this.tex.version !== c.version || ctx.layer !== (this as any)._layer)) {
        this.tex.update(c, ctx.layer, ap.deck);
        (this as any)._layer = ctx.layer;
        this.texClock = focus ? 0.12 : 1.0;
      }
    }
    const tex = this.tex;
    u.uElevTex.value = this.elevTex;
    u.uClimA.value = tex?.climA ?? this.dummy;
    u.uClimB.value = tex?.climB ?? this.dummy;
    u.uLayerTex.value = tex?.layer ?? this.dummy;
    const li = LAYERS.findIndex((l) => l.id === ctx.layer);
    const layerOn = c && ctx.layer !== 'true' && li > 0;
    u.uLayer.value = layerOn ? li : 0;
    if (layerOn) {
      const L = LAYERS[li];
      (u.uLayerRange.value as THREE.Vector2).set(L.range[0], L.range[1]);
      u.uPalette.value = L.palette === 'blueRed' ? 1 : L.palette === 'rain' ? 2 : 0;
    }
    const sea = c && c.waterTotal > 0 && Number.isFinite(c.seaLevel) ? c.seaLevel : -1e9;
    u.uSeaLevel.value = sea;
    u.uHasOcean.value = sea > -1e8 ? 1 : 0;
    u.uWetWorld.value = c && c.waterTotal > 0 && c.vol.id === 'H2O' && c.P > 1000 ? 1 : 0;
    const style = c?.style ?? b.world?.terrain ?? 'asteroid';
    const [ra, rb] = ROCK[style];
    (u.uRockA.value as THREE.Vector3).set(...ra);
    (u.uRockB.value as THREE.Vector3).set(...rb);
    if (c?.vol.id === 'CH4') {
      (u.uLiquidDeep.value as THREE.Vector3).set(0.02, 0.012, 0.006);
      (u.uLiquidShallow.value as THREE.Vector3).set(0.08, 0.05, 0.025);
    }
    const pig = plantPigment(c?.hostTeff ?? 5772);
    (u.uPlant.value as THREE.Vector3).set(...pig);
    (u.uPlantDry.value as THREE.Vector3).set(pig[0] * 0.6 + 0.2, pig[1] * 0.6 + 0.17, pig[2] * 0.6 + 0.06);
    u.uTime.value = ctx.realTime;
    // Lit urban ground ≈ 1e-4 of sunlit-white radiance (a few cd/m²).
    u.uLightsScale.value = (ctx.realistic ? 1.2e-4 * ctx.exposure : 0.6) * (c?.civ ? 1 : 0);
    setLights(u, b, ctx);
    // Atmosphere uniforms shared by surface, clouds and sky.
    const setAtmo = (uu: Record<string, THREE.IUniform>) => {
      (uu.uBetaR.value as THREE.Vector3).copy(ap.betaR);
      (uu.uBetaM.value as THREE.Vector3).copy(ap.betaM);
      (uu.uMieAlbedo.value as THREE.Vector3).copy(ap.mieAlb);
      uu.uHr.value = ap.Hr;
      uu.uHm.value = ap.Hm;
      uu.uAtmR.value = ap.top;
      uu.uGroundR.value = R + Math.max(0, Number.isFinite(sea) ? sea : 0);
      (uu.uPlanetCenter.value as THREE.Vector3).copy(this.group.position);
    };
    setAtmo(u);
    u.uHasAtm.value = ap.has ? 1 : 0;
    // --- terrain patches
    const camBody = b.toBody(V3.sub(ctx.camPos, b.pos));
    const maxDepth = focus ? 17 : ctx.cameraAlt < R * 30 ? 3 : 1;
    if (Math.abs(sea - this.seaBuilt) > 8 && !(sea < -1e8 && this.seaBuilt < -1e8)) {
      this.clearPatches();
      this.seaBuilt = sea;
    }
    const maxElev = Math.max(9000, Math.abs(c?.terrain.max ?? 9000) + 2000);
    const nodes = selectPatches(R, camBody, maxDepth, 2.3, maxElev);
    // Build missing patches within a time budget, coarse and near ones first; until a leaf
    // exists its nearest built ancestor stands in, so the surface never has holes.
    const build = (n: PatchNode): THREE.Mesh => {
      const g = buildPatchGeometry(n, this.hf!, sea, sea > -1e8);
      const m = new THREE.Mesh(g, this.material);
      m.position.set(n.center.x, n.center.y, n.center.z);
      m.renderOrder = 1;
      this.patches.set(n.key, m);
      return m;
    };
    const missing = nodes.filter((n) => !this.patches.has(n.key)).sort((a, b) => a.depth - b.depth || a.dist - b.dist);
    const deadline = performance.now() + (focus ? 7 : 2.5);
    for (const n of missing) {
      if (performance.now() > deadline) break;
      build(n);
    }
    const cover = new Map<string, PatchNode>();
    for (const n of nodes) {
      if (this.patches.has(n.key)) continue;
      let a = parentNode(n, R, maxElev);
      while (a && !this.patches.has(a.key)) a = a.depth > 0 ? parentNode(a, R, maxElev) : null;
      if (!a) {
        // Nothing built on this face yet: build the root (cheap) so there is never a hole.
        a = patchNode(n.face, 0, 0, 0, R, maxElev);
        if (!this.patches.has(a.key)) build(a);
      }
      cover.set(a.key, a);
    }
    const covered = (n: PatchNode): boolean => {
      for (let a = parentNode(n, R, maxElev); a; a = parentNode(a, R, maxElev)) if (cover.has(a.key)) return true;
      return false;
    };
    const want = new Set<THREE.Mesh>();
    for (const n of nodes) {
      const m = this.patches.get(n.key);
      if (m && !covered(n)) want.add(m);
    }
    for (const k of cover.keys()) want.add(this.patches.get(k)!);
    for (const m of this.shown) if (!want.has(m)) this.group.remove(m);
    for (const m of want) if (m.parent !== this.group) this.group.add(m);
    this.shown = [...want];
    // Evict old patches.
    if (this.patches.size > 900) {
      for (const [k, m] of this.patches) {
        if (this.shown.includes(m)) continue;
        m.geometry.dispose();
        this.patches.delete(k);
        if (this.patches.size < 700) break;
      }
    }
    // --- clouds and sky
    const showClouds = view.clouds && !!c && c.P > 50 && (c.stats.cloudFrac > 0.002 || ap.deck > 0.1) && !layerOn;
    const cloudAlt = Math.min(8000 * (9.81 / ap.g), ap.Hr * 1.2, R * 0.02);
    this.cloudTop = cloudAlt * 1.6;
    const alt = V3.sub(ctx.camPos, b.pos).len() - R;
    const volFade = focus && showClouds ? smoothstep(this.cloudTop * 40, this.cloudTop * 8, alt) : 0;
    this.cloudShell.visible = showClouds && volFade < 0.99;
    this.cloudShell.scale.setScalar(R + cloudAlt + Math.max(0, sea > -1e8 ? sea : 0));
    const cu = this.cloudMat.uniforms;
    cu.uClimB.value = tex?.climB ?? this.dummy;
    cu.uWind.value = tex?.wind ?? this.dummy;
    cu.uTime.value = ctx.realTime;
    cu.uOpacity.value = 1 - volFade;
    cu.uFlowScale.value = 1;
    setLights(cu, b, ctx);
    setAtmo(cu);
    const deckCol = ap.deck > 0.1 ? new THREE.Vector3(0.95, 0.88, 0.68) : c?.vol.id === 'CH4' ? new THREE.Vector3(0.95, 0.75, 0.45) : new THREE.Vector3(1, 1, 1);
    (cu.uCloudColor.value as THREE.Vector3).copy(deckCol);
    // Storms → uniforms.
    const storms = c?.storms.storms ?? [];
    const sv = cu.uStorms.value as THREE.Vector4[];
    const si = cu.uStormInfo.value as THREE.Vector4[];
    let ns = 0;
    for (const s of storms) {
      if (ns >= 12 || s.vmax < 12) continue;
      const cl = Math.cos(s.lat);
      sv[ns].set(cl * Math.cos(s.lon), cl * Math.sin(s.lon), Math.sin(s.lat), (s.radius / R) * 1.1);
      si[ns].set(clamp(s.vmax / 40, 0.3, 1.3), s.spin, s.kind === 'tropical' ? 0 : s.kind === 'extratropical' ? 1 : 2, 0);
      ns++;
    }
    cu.uNumStorms.value = ns;
    this.volume.visible = volFade > 0.01;
    if (this.volume.visible) {
      const vu = this.volMat.uniforms;
      vu.uClimB.value = tex?.climB ?? this.dummy;
      vu.uGiant.value = 0;
      const base = R + Math.max(0, sea > -1e8 ? sea : 0);
      vu.uShellIn.value = base + cloudAlt * 0.2;
      vu.uShellOut.value = base + this.cloudTop;
      vu.uScale.value = 1 / (cloudAlt * 1.3);
      vu.uDensity.value = 1 / (cloudAlt * 0.12);
      vu.uTime.value = ctx.realTime;
      vu.uOpacity.value = volFade;
      (vu.uCloudColor.value as THREE.Vector3).copy(deckCol);
      const inv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.group.quaternion)).transpose();
      (vu.uBodyRot.value as THREE.Matrix3).copy(inv);
      setLights(vu, b, ctx);
      setAtmo(vu);
      this.volume.scale.setScalar(base + this.cloudTop);
      // From above, draw the shell's front faces (depth-tested against the terrain below);
      // from inside or below the layer, draw its back faces without depth test.
      const inside = alt + R < base + this.cloudTop * 1.02;
      this.volMat.side = inside ? THREE.BackSide : THREE.FrontSide;
      this.volMat.depthTest = !inside;
    }
    this.atmo.visible = ap.has;
    if (ap.has) {
      this.atmo.scale.setScalar(ap.top);
      setLights(this.atmoMat.uniforms, b, ctx);
      setAtmo(this.atmoMat.uniforms);
    }
  }

  override dispose(): void {
    this.clearPatches();
    this.tex?.dispose();
    this.elevTex?.dispose();
    this.material.dispose();
    this.cloudMat.dispose();
    this.volMat.dispose();
    this.atmoMat.dispose();
    super.dispose();
  }
}

// Lazy import to avoid a cycle at module load.
import { generateTerrain } from '../climate/terrain';
function require_terrain() {
  return { generateTerrain };
}

// ---------------------------------------------------------------------------- gas giants

export class GiantView extends BodyView {
  private mat = makeGiantMaterial();
  private sphere: THREE.Mesh;
  private bandTex: THREE.DataTexture | null = null;
  private thermTex: THREE.DataTexture | null = null;
  private ring: THREE.Mesh | null = null;
  private ringMat = makeRingMaterial();
  private ringKey = '';
  private atmo: THREE.Mesh;
  private atmoMat = makeAtmosphereMaterial();
  private volume: THREE.Mesh;
  private volMat: THREE.ShaderMaterial;
  private bandClock = 0;
  private lastClass = -1;

  constructor(body: Body, noise3d: THREE.Data3DTexture) {
    super(body);
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), this.mat);
    this.sphere.renderOrder = 1;
    this.group.add(this.sphere);
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.atmoMat);
    this.atmo.renderOrder = 4;
    this.group.add(this.atmo);
    this.volMat = makeVolumeCloudMaterial(noise3d);
    this.volume = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.volMat);
    this.volume.renderOrder = 3;
    this.group.add(this.volume);
    for (const m of [this.sphere, this.atmo, this.volume]) m.frustumCulled = false;
  }

  get climate(): GasGiantClimate | null {
    return this.body.climate instanceof GasGiantClimate ? this.body.climate : null;
  }

  /** Pressure scale height near the cloud tops (m). */
  scaleHeight(): number {
    const g = this.climate;
    const T = g ? Math.max(60, g.stats.T1bar) : 150;
    return clamp((R_GAS * T) / (0.0023 * this.body.surfaceGravity()), 1e4, this.body.radius * 0.05);
  }

  /** How deep below the 1-bar level the camera may descend (m): ~10–20 bar, under the water clouds. */
  maxDepth(): number {
    return this.scaleHeight() * 2.7;
  }

  update(ctx: FrameCtx): void {
    const b = this.body;
    const R = b.radius;
    this.place(ctx);
    const g = this.climate;
    const u = this.mat.uniforms;
    this.bandClock -= ctx.dt;
    if (g && (this.bandClock <= 0 || g.stats.sudarsky !== this.lastClass)) {
      this.bandTex = bandTexture(g, b.giant?.seed ?? b.id, this.bandTex ?? undefined);
      this.thermTex = thermalTexture(g, this.thermTex ?? undefined);
      this.bandClock = 1;
      this.lastClass = g.stats.sudarsky;
    }
    u.uBands.value = this.bandTex;
    u.uThermal.value = this.thermTex;
    u.uTime.value = ctx.realTime;
    u.uLayer.value = ctx.layer === 'Ts' || ctx.layer === 'tAnnual' ? 1 : 0;
    const pal = g ? g.stats.T1bar : 150;
    u.uGlow.value = pal > 700 || b.kind === 'brownDwarf' ? 1 : 0;
    u.uTurb.value = g?.palette === 'uranus' ? 0.25 : 1;
    // Vortices.
    const vv = u.uVort.value as THREE.Vector4[];
    const vc = u.uVortCol.value as THREE.Vector4[];
    let nv = 0;
    for (const v of g?.vortices ?? []) {
      if (nv >= 8) break;
      const cl = Math.cos(v.lat);
      vv[nv].set(cl * Math.cos(v.lon), cl * Math.sin(v.lon), Math.sin(v.lat), v.a / R);
      vc[nv].set(v.color[0], v.color[1], v.color[2], v.sense);
      nv++;
    }
    u.uNumVort.value = nv;
    setLights(u, b, ctx);
    const Hr = this.scaleHeight();
    const k = 0.25 * 0.4; // H2/He: weak per-molecule Rayleigh, ~0.4 bar above the clouds
    const set = (uu: Record<string, THREE.IUniform>) => {
      (uu.uBetaR.value as THREE.Vector3).set(5.8e-6 * k, 13.5e-6 * k, 33.1e-6 * k);
      (uu.uBetaM.value as THREE.Vector3).set(4e-7, 4e-7, 4e-7);
      (uu.uMieAlbedo.value as THREE.Vector3).set(0.95, 0.9, 0.8);
      uu.uHr.value = Hr;
      uu.uHm.value = Hr * 0.5;
      uu.uAtmR.value = R + Hr * 8;
      uu.uGroundR.value = R - this.maxDepth() * 0.8;
      (uu.uPlanetCenter.value as THREE.Vector3).copy(this.group.position);
    };
    set(u);
    this.sphere.scale.setScalar(R);
    // Rings.
    const rs = b.rings;
    if (rs) {
      const key = `${rs.inner}:${rs.outer}:${rs.mass}:${rs.opacity}`;
      if (key !== this.ringKey) {
        if (this.ring) {
          this.group.remove(this.ring);
          this.ring.geometry.dispose();
        }
        const tex = ringTexture(rs, b.name === 'Saturn');
        this.ringMat.uniforms.uRingTex.value = tex;
        this.ringMat.uniforms.uInner.value = rs.inner;
        this.ringMat.uniforms.uOuter.value = rs.outer;
        this.ring = new THREE.Mesh(new THREE.RingGeometry(rs.inner, rs.outer, 256, 4), this.ringMat);
        this.ring.renderOrder = 5;
        this.ring.frustumCulled = false;
        this.group.add(this.ring);
        this.ringKey = key;
        u.uRingTex.value = tex;
      }
      const ru = this.ringMat.uniforms;
      ru.uPlanetR.value = R;
      (ru.uPlanetCenter.value as THREE.Vector3).copy(this.group.position);
      setLights(ru, b, ctx);
      u.uRingIn.value = rs.inner;
      u.uRingOut.value = rs.outer;
      const n = toThree(b.spinAxis).normalize();
      (u.uRingNormal.value as THREE.Vector3).copy(n);
    } else {
      u.uRingOut.value = 0;
      if (this.ring) {
        this.group.remove(this.ring);
        this.ring = null;
        this.ringKey = '';
      }
    }
    // Atmosphere rim / interior haze.
    this.atmo.scale.setScalar(R + Hr * 8);
    setLights(this.atmoMat.uniforms, b, ctx);
    set(this.atmoMat.uniforms);
    // Volumetric cloud decks when diving in.
    const alt = V3.sub(ctx.camPos, b.pos).len() - R;
    const fade = ctx.focusId === b.id ? smoothstep(R * 0.03, R * 0.004, alt) : 0;
    this.volume.visible = fade > 0.01;
    // Decks: NH3 ice (~0.6 bar), NH4SH (~2 bar) and water (~6 bar) inside a shell from
    // ~20 bar up to the tropopause haze.
    const shellIn = R - Hr * 3.0;
    const shellOut = R + Hr * 1.2;
    if (this.volume.visible) {
      const vu = this.volMat.uniforms;
      vu.uGiant.value = 1;
      vu.uBands.value = this.bandTex;
      vu.uShellIn.value = shellIn;
      vu.uShellOut.value = shellOut;
      vu.uScale.value = 1 / (Hr * 2.5);
      vu.uDensity.value = 1 / (Hr * 0.08);
      vu.uTime.value = ctx.realTime;
      vu.uOpacity.value = fade;
      const pal2 = this.bandTex ? Array.from((this.bandTex.image.data as Uint8Array).slice(512, 515)).map((x) => x / 255) : [0.9, 0.85, 0.75];
      (vu.uCloudColor.value as THREE.Vector3).set(pal2[0] * 1.05, pal2[1] * 1.05, pal2[2] * 1.05);
      (vu.uDeepColor.value as THREE.Vector3).set(pal2[0] * 0.5, pal2[1] * 0.4, pal2[2] * 0.3);
      const inv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.group.quaternion)).transpose();
      (vu.uBodyRot.value as THREE.Matrix3).copy(inv);
      setLights(vu, b, ctx);
      set(vu);
      this.volume.scale.setScalar(shellOut);
      const inside = alt + R < shellOut * 1.001;
      this.volMat.side = inside ? THREE.BackSide : THREE.FrontSide;
      this.volMat.depthTest = !inside;
    }
    // Once the decks are fully drawn (and opaque), the flat cloud-top sphere would only hide them.
    this.sphere.visible = !(this.volume.visible && fade > 0.98) && alt > Hr * 1.5;
  }

  override dispose(): void {
    this.bandTex?.dispose();
    this.thermTex?.dispose();
    this.mat.dispose();
    this.ringMat.dispose();
    this.atmoMat.dispose();
    this.volMat.dispose();
    super.dispose();
  }
}

// ---------------------------------------------------------------------------- stars & remnants

export class StarView extends BodyView {
  private mat = makeStarMaterial();
  private sphere: THREE.Mesh;
  private glow: THREE.Mesh;
  private glowMat = makeGlowMaterial();
  private beams: THREE.Mesh | null = null;

  constructor(body: Body) {
    super(body);
    this.sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), this.mat);
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 6;
    this.group.add(this.sphere);
    this.group.add(this.glow);
    if (body.kind === 'neutronStar') {
      const geo = new THREE.ConeGeometry(0.25, 1, 24, 1, true);
      geo.translate(0, 0.5, 0);
      const m = makeGlowMaterial();
      m.side = THREE.DoubleSide;
      this.beams = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x88aaff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      const b2 = this.beams.clone();
      b2.rotation.z = Math.PI;
      this.beams.add(b2);
      this.group.add(this.beams);
    }
  }

  update(ctx: FrameCtx): void {
    const b = this.body;
    this.place(ctx);
    const s = b.star;
    const T = s?.T ?? 0;
    const R = b.radius;
    const dist = Math.max(ctx.camPos.distTo(b.pos), R * 1.01);
    const color = T > 0 ? blackbodyRGB(T) : [0, 0, 0];
    const radiancePhys = (SIGMA * Math.pow(Math.max(T, 1), 4)) / 1361;
    const u = this.mat.uniforms;
    if (b.kind === 'blackHole') {
      (u.uColor.value as THREE.Vector3).set(0, 0, 0);
      u.uRadiance.value = 0;
    } else {
      (u.uColor.value as THREE.Vector3).set(color[0], color[1], color[2]);
      // Enhanced: a fixed display brightness that keeps granulation, spots and limb darkening visible.
      u.uRadiance.value = ctx.realistic ? radiancePhys * ctx.exposure : 1.05 + Math.log10(1 + radiancePhys) * 0.05;
    }
    u.uTime.value = ctx.realTime;
    u.uCellScale.value = s && R > 50 * 6.957e8 ? 6 : 30;
    u.uSpots.value = T < 6500 && T > 3000 ? 0.35 : 0.05;
    this.sphere.scale.setScalar(R);
    // Glow: physically, total flux at the camera sets how bright the halo looks.
    const L = s?.L ?? 0;
    const flux = L / (4 * Math.PI * dist * dist);
    const gu = this.glowMat.uniforms;
    (gu.uColor.value as THREE.Vector3).set(color[0], color[1], color[2]);
    const angR = R / dist;
    const minPx = 0.012; // radians covered by the glow sprite at minimum
    const size = Math.max(R * 7, dist * minPx * (b.kind === 'blackHole' ? 0.4 : 1));
    this.glow.scale.setScalar(size);
    const pointLike = clamp(1 - angR / 0.01, 0, 1);
    if (ctx.realistic) gu.uIntensity.value = (flux / 1361) * ctx.exposure * (0.25 / Math.max(minPx * minPx, angR * angR)) * 0.02 + radiancePhys * ctx.exposure * 0.02 * (1 - pointLike);
    else gu.uIntensity.value = (0.6 + 2.5 * pointLike * clamp(Math.log10(1 + (L / L_SUN) * 10) / 3, 0.2, 1.5)) * (0.25 + 0.75 * clamp(1 - angR / 0.15, 0, 1));
    gu.uCore.value = clamp((angR * dist) / size, 0.02, 0.4);
    if (b.kind === 'blackHole') {
      // Photon ring hint.
      (gu.uColor.value as THREE.Vector3).set(0.6, 0.7, 1.0);
      gu.uIntensity.value = ctx.realistic ? 0 : 0.35;
    }
    if (this.beams) {
      this.beams.scale.setScalar(Math.max(R * 4e3, dist * 0.08));
      this.beams.rotation.y = ctx.realTime * 6;
      this.beams.rotation.x = 0.4;
    }
    void T_SUN;
  }
}

export { TMP };

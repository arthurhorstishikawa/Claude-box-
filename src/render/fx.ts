import * as THREE from 'three';
import { DAY } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { V3 } from '../core/vec3';
import type { Body } from '../physics/body';
import { plantPigment } from '../climate/life';
import type { TerrestrialClimate } from '../climate/terrestrial';
import { LOGDEPTH_F, LOGDEPTH_PARS_F, LOGDEPTH_PARS_V, LOGDEPTH_V, SCATTER_GLSL } from './glsl';
import { toThree } from './units';

/** Local east/north/up axes (render frame) at a point on a body. */
function localFrame(body: Body, camPos: V3) {
  const up = V3.sub(camPos, body.pos).normalize();
  let east = body.spinAxis.cross(up);
  if (east.len() < 1e-6) east = V3.perpendicular(up);
  east.normalize();
  const north = up.cross(east);
  return { e: toThree(east), n: toThree(north), u: toThree(up) };
}

/**
 * Weather you can see when standing on a world: rain streaks or snowflakes around the camera
 * at the local precipitation rate, drifting with the local wind, and lightning in deep
 * convection — all read from the climate model at the camera's position.
 */
export class GroundWeather {
  private readonly n = 3000;
  private local = new Float32Array(this.n * 3);
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private bolt: THREE.Line;
  private boltLife = 0;
  private flash = 0;
  private flashEl: HTMLDivElement;
  group = new THREE.Group();
  overlayGroup = new THREE.Group();

  constructor(overlay: HTMLElement) {
    for (let i = 0; i < this.n; i++) {
      this.local[3 * i] = (Math.random() - 0.5) * 70;
      this.local[3 * i + 1] = (Math.random() - 0.5) * 70;
      this.local[3 * i + 2] = Math.random() * 40 - 15;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 6), 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false }));
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.5, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false }));
    for (const o of [this.rain, this.snow]) {
      o.frustumCulled = false;
      o.visible = false;
      this.group.add(o);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3));
    this.bolt = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: new THREE.Color(6, 6, 8) }));
    this.bolt.frustumCulled = false;
    this.bolt.visible = false;
    this.overlayGroup.add(this.bolt);
    this.flashEl = document.createElement('div');
    this.flashEl.style.cssText = 'position:fixed;inset:0;background:#dfe6ff;opacity:0;pointer-events:none;mix-blend-mode:screen';
    overlay.appendChild(this.flashEl);
  }

  update(o: { body: Body | null; climate: TerrestrialClimate | null; surface: { lat: number; lon: number; aboveGround: number } | null; camPos: V3; dt: number; brightness: number }): void {
    const c = o.climate;
    const b = o.body;
    this.flash = Math.max(0, this.flash - o.dt * 6);
    this.flashEl.style.opacity = String(0.4 * this.flash * (0.6 + 0.4 * Math.sin(this.flash * 40)));
    this.boltLife -= o.dt;
    this.bolt.visible = this.boltLife > 0;
    if (!c || !b || !o.surface || o.surface.aboveGround > 4000 || c.P < 2000) {
      this.rain.visible = this.snow.visible = false;
      return;
    }
    const { lat, lon } = o.surface;
    const g = c.grid;
    const mm = g.sample(c.precip, lat, lon) * DAY;
    const T = g.sample(c.Ts, lat, lon);
    const cloud = g.sample(c.cloud, lat, lon);
    const storm = g.sample(c.stormFactor, lat, lon);
    const we = g.sample(c.circ.u, lat, lon);
    const wn = g.sample(c.circ.v, lat, lon);
    const intensity = smoothstep(0.4, 25, mm) * smoothstep(0.2, 0.5, cloud);
    const count = Math.floor(this.n * intensity);
    const snowing = T < 273.6 && c.vol.id === 'H2O';
    const f = localFrame(b, o.camPos);
    const fall = snowing ? 1.2 : 9;
    const L = this.local;
    for (let i = 0; i < count; i++) {
      L[3 * i] += we * 0.6 * o.dt + (snowing ? Math.sin(i * 1.7 + performance.now() * 0.002) * 0.4 * o.dt : 0);
      L[3 * i + 1] += wn * 0.6 * o.dt;
      L[3 * i + 2] -= fall * o.dt;
      for (const a of [0, 1]) {
        if (L[3 * i + a] > 35) L[3 * i + a] -= 70;
        if (L[3 * i + a] < -35) L[3 * i + a] += 70;
      }
      if (L[3 * i + 2] < -15) L[3 * i + 2] += 40;
    }
    const tmp = new THREE.Vector3();
    const place = (i: number, dz: number, out: Float32Array, off: number) => {
      tmp.set(0, 0, 0).addScaledVector(f.e, L[3 * i]).addScaledVector(f.n, L[3 * i + 1]).addScaledVector(f.u, L[3 * i + 2] + dz);
      out[off] = tmp.x;
      out[off + 1] = tmp.y;
      out[off + 2] = tmp.z;
    };
    const col = clamp(o.brightness, 0.01, 2);
    if (snowing) {
      const arr = (this.snow.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < count; i++) place(i, 0, arr, 3 * i);
      this.snow.geometry.setDrawRange(0, count);
      (this.snow.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.snow.material as THREE.PointsMaterial).color.setScalar(col * 1.3);
    } else {
      const arr = (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < count; i++) {
        place(i, 0, arr, 6 * i);
        place(i, 0.35, arr, 6 * i + 3);
      }
      this.rain.geometry.setDrawRange(0, count * 2);
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).color.setScalar(col);
    }
    this.snow.visible = snowing && count > 0;
    this.rain.visible = !snowing && count > 0;
    // Lightning in deep convection (warm, heavy rain) and in storms.
    const strikeRate = (T > 283 ? 0.25 * smoothstep(10, 40, mm) : 0) + 0.4 * storm;
    if (strikeRate > 0 && Math.random() < 1 - Math.exp(-o.dt * strikeRate)) this.strike(f, o.surface.aboveGround);
  }

  private strike(f: { e: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3 }, above: number): void {
    const ang = Math.random() * Math.PI * 2;
    const dist = 1500 + Math.random() * 5000;
    const x0 = Math.cos(ang) * dist,
      y0 = Math.sin(ang) * dist;
    const arr = (this.bolt.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    const top = 2500,
      bottom = -above;
    let x = x0,
      y = y0;
    const v = new THREE.Vector3();
    for (let i = 0; i < 16; i++) {
      const z = top + ((bottom - top) * i) / 15;
      x += (Math.random() - 0.5) * 260;
      y += (Math.random() - 0.5) * 260;
      v.set(0, 0, 0).addScaledVector(f.e, x).addScaledVector(f.n, y).addScaledVector(f.u, z);
      arr[3 * i] = v.x;
      arr[3 * i + 1] = v.y;
      arr[3 * i + 2] = v.z;
    }
    (this.bolt.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.boltLife = 0.18;
    this.flash = 1;
  }
}

// ---------------------------------------------------------------------------- trees

const TREE_VS = /* glsl */ `
  ${LOGDEPTH_PARS_V}
  attribute float part;
  varying vec3 vN; varying float vPart; varying vec3 vCol; varying vec3 vWorld;
  void main(){
    vPart = part;
    #ifdef USE_INSTANCING_COLOR
      vCol = instanceColor;
    #else
      vCol = vec3(1.0);
    #endif
    mat4 m = modelMatrix * instanceMatrix;
    vN = normalize(mat3(m) * normal);
    vec4 w = m * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
    ${LOGDEPTH_V}
  }`;
// Lit exactly like the ground around them: no sun below the horizon, sunlight reddened by the
// air, blue skylight only while the sky is lit, starlight/airglow at night, aerial perspective.
const TREE_FS = /* glsl */ `
  #include <common>
  ${LOGDEPTH_PARS_F}
  ${SCATTER_GLSL}
  uniform vec3 uPlanetCenter; uniform vec3 uLeaf; uniform vec3 uAmbient; uniform float uHasAtm; uniform float uShadow;
  varying vec3 vN; varying float vPart; varying vec3 vCol; varying vec3 vWorld;
  void main(){
    vec3 alb = mix(vec3(0.09, 0.06, 0.04), uLeaf * vCol, step(0.5, vPart));
    vec3 N = normalize(vN);
    vec3 G = normalize(vWorld - uPlanetCenter);
    vec3 V = normalize(vWorld);
    float tauZ = uBetaR.b * uHr + uBetaM.r * uHm;
    vec3 skyTint = mix(vec3(0.45, 0.62, 1.0), uMieAlbedo, clamp(uBetaM.r * uHm / max(tauZ, 1e-9), 0.0, 1.0));
    float skyAmt = uHasAtm * 0.35 * (1.0 - exp(-tauZ));
    vec3 col = vec3(0.0);
    for (int s = 0; s < 2; s++) {
      if (s >= uNumSuns) break;
      vec3 L = uSunDir[s];
      float cosG = dot(G, L);
      float horizon = smoothstep(-0.03, 0.05, cosG);
      vec3 rad = uSunRadiance[s];
      if (uHasAtm > 0.5) {
        vec2 od = lightDepth(vWorld - uPlanetCenter, L);
        rad *= sunTrans(od);
      }
      // Leaves pass some light through: wrapped diffuse.
      float ndl = dot(N, L);
      float diff = max(ndl, 0.0) * 0.8 + 0.2 * max(ndl * 0.5 + 0.5, 0.0);
      col += alb * rad * diff * horizon * uShadow;
      col += alb * uSunRadiance[s] * skyTint * skyAmt * smoothstep(-0.15, 0.35, cosG) * (0.6 + 0.4 * dot(N, G));
    }
    col += alb * uAmbient;
    if (uHasAtm > 0.5) {
      vec3 trans;
      vec3 ins = atmosphere(-uPlanetCenter, V, length(vWorld), trans);
      col = col * trans + ins;
    }
    gl_FragColor = vec4(col, 1.0);
    ${LOGDEPTH_F}
  }`;

function treeGeometry(conifer: boolean): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.04, 0.06, 0.4, 6);
  trunk.translate(0, 0.2, 0);
  const crown = conifer ? new THREE.ConeGeometry(0.28, 0.8, 8) : new THREE.IcosahedronGeometry(0.32, 1);
  crown.translate(0, conifer ? 0.6 : 0.62, 0);
  if (!conifer) crown.scale(1, 1.15, 1);
  const parts: THREE.BufferGeometry[] = [];
  for (const [g, p] of [
    [trunk, 0],
    [crown, 1],
  ] as [THREE.BufferGeometry, number][]) {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.setAttribute('part', new THREE.BufferAttribute(new Float32Array(ng.getAttribute('position').count).fill(p), 1));
    parts.push(ng);
  }
  // Merge by hand (positions, normals, part).
  const total = parts.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const pos = new Float32Array(total * 3),
    nrm = new Float32Array(total * 3),
    prt = new Float32Array(total);
  let o = 0;
  for (const g of parts) {
    const n = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nrm.set(g.getAttribute('normal').array as Float32Array, o * 3);
    prt.set(g.getAttribute('part').array as Float32Array, o);
    o += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('part', new THREE.BufferAttribute(prt, 1));
  return out;
}

/**
 * Forest around the landed camera: instanced trees on the actual terrain wherever the
 * climate model grows vegetation, shaped by biome (conifers in boreal regions) and coloured
 * with the plant pigment of the host star, turning in autumn.
 */
export class TreeField {
  anchor = new THREE.Object3D();
  private meshes: THREE.InstancedMesh[];
  private mat: THREE.ShaderMaterial;
  private built: { lat: number; lon: number; conifer: boolean } | null = null;
  private readonly max = 2600;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uNumSuns: { value: 0 },
        uSunDir: { value: [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 0)] },
        uSunRadiance: { value: [new THREE.Vector3(), new THREE.Vector3()] },
        uBetaR: { value: new THREE.Vector3() },
        uBetaM: { value: new THREE.Vector3() },
        uMieAlbedo: { value: new THREE.Vector3(0.9, 0.9, 0.9) },
        uHr: { value: 8000 },
        uHm: { value: 1200 },
        uMieG: { value: 0.76 },
        uAtmR: { value: 6.471e6 },
        uGroundR: { value: 6.371e6 },
        uPlanetCenter: { value: new THREE.Vector3() },
        uAmbient: { value: new THREE.Vector3() },
        uHasAtm: { value: 0 },
        uShadow: { value: 1 },
        uLeaf: { value: new THREE.Vector3(0.05, 0.14, 0.03) },
      },
      vertexShader: TREE_VS,
      fragmentShader: TREE_FS,
    });
    this.meshes = [false, true].map((conifer) => {
      const m = new THREE.InstancedMesh(treeGeometry(conifer), this.mat, this.max);
      m.count = 0;
      m.frustumCulled = false;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.max * 3), 3);
      this.anchor.add(m);
      return m;
    });
  }

  /** Uniforms shared with the ground's lighting (filled by the planet view). */
  get uniforms(): Record<string, THREE.IUniform> {
    return this.mat.uniforms;
  }

  hide(): void {
    for (const m of this.meshes) m.count = 0;
    this.built = null;
  }

  /**
   * (Re)build around (lat, lon) when the camera has moved. `height` gives terrain height (m),
   * `R` the planet radius; instances are placed in the body frame relative to the anchor.
   */
  update(c: TerrestrialClimate, lat: number, lon: number, R: number, height: (lat: number, lon: number) => number, sea: number): void {
    if (this.built && Math.hypot(lat - this.built.lat, (lon - this.built.lon) * Math.cos(lat)) * R < 80) return;
    const g = c.grid;
    const veg = g.sample(c.veg, lat, lon);
    const tMonth = g.sample(c.tMonth, lat, lon);
    const tAnn = g.sample(c.tAnnual, lat, lon) - 273.15;
    const conifer = tAnn < 4;
    // Leaf colour: the star-matched pigment, turning in autumn, bare in deep winter.
    const pig = plantPigment(c.hostTeff);
    const turn = 1 - smoothstep(276, 286, tMonth);
    const leaf = new THREE.Vector3(pig[0] + (0.3 - pig[0]) * turn * (conifer ? 0.15 : 0.9), pig[1] + (0.13 - pig[1]) * turn * (conifer ? 0.15 : 0.9), pig[2] + (0.03 - pig[2]) * turn * (conifer ? 0.15 : 0.9));
    (this.mat.uniforms.uLeaf.value as THREE.Vector3).copy(leaf).multiplyScalar(1.2);
    // Anchor at the camera's ground point, oriented with the body frame (the parent).
    const cl = Math.cos(lat),
      up = new THREE.Vector3(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
    const h0 = height(lat, lon);
    this.anchor.position.copy(up).multiplyScalar(R + h0);
    const east = new THREE.Vector3(-Math.sin(lon), Math.cos(lon), 0);
    const north = new THREE.Vector3().crossVectors(up, east);
    const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const mesh = this.meshes[conifer ? 1 : 0];
    const other = this.meshes[conifer ? 0 : 1];
    other.count = 0;
    let n = 0;
    const spacing = 9;
    const radius = 520;
    const steps = Math.floor(radius / spacing);
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    // Stable placement: cells are indexed in absolute (lat, lon) units of ~9 m.
    const dLat = spacing / R;
    const dLon = spacing / (R * Math.max(cl, 0.05));
    const i0 = Math.round(lat / dLat),
      j0 = Math.round(lon / dLon);
    const hash = (a: number, b: number) => {
      const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let di = -steps; di <= steps && n < this.max; di++)
      for (let dj = -steps; dj <= steps && n < this.max; dj++) {
        if (di * di + dj * dj > steps * steps) continue;
        const ci = i0 + di,
          cj = j0 + dj;
        const r1 = hash(ci, cj);
        if (r1 > veg * (veg > 0.45 ? 0.75 : 0.35)) continue;
        const tl = (ci + hash(cj, ci) - 0.5) * dLat;
        const tn = (cj + hash(ci + 7, cj) - 0.5) * dLon;
        const h = height(tl, tn);
        if (h < sea + 2) continue;
        const ht = 8 + 17 * hash(ci * 3, cj * 5);
        // Offset from the anchor in the body frame (small numbers: no float32 jitter).
        const dn = (tl - lat) * R,
          de = (tn - lon) * R * cl;
        p.copy(east).multiplyScalar(de).addScaledVector(north, dn).addScaledVector(up, h - h0);
        s.set(ht * (0.8 + 0.4 * r1), ht, ht * (0.8 + 0.4 * r1));
        m4.compose(p, rot, s);
        mesh.setMatrixAt(n, m4);
        const v = 0.75 + 0.5 * hash(cj, ci * 2);
        col.setRGB(v, v * (0.9 + 0.2 * r1), v);
        mesh.setColorAt(n, col);
        n++;
      }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.built = { lat, lon, conifer };
  }
}

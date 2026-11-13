import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { AU, G } from '../core/constants';
import { clamp, smoothstep } from '../core/math';
import { V3 } from '../core/vec3';
import type { Body } from '../physics/body';
import { orbitFromState, orbitPoints } from '../physics/orbits';
import { blackbodyRGB } from '../stars/blackbody';
import { habitableZone } from '../stars/habitableZone';
import { TerrestrialClimate } from '../climate/terrestrial';
import type { Simulation } from '../sim/simulation';
import { CameraController } from './camera';
import { EyeAdaptation } from './exposure';
import { GroundWeather } from './fx';
import { Starfield } from './starfield';
import { makeNoise3D } from './textures';
import { rel, toThree } from './units';
import { BodyView, GiantView, RockyView, StarView, type FrameCtx, type LightSrc } from './views';
import { view } from './viewSettings';

class MeasurePass extends Pass {
  constructor(private eye: EyeAdaptation) {
    super();
    this.needsSwap = false;
  }
  override render(renderer: THREE.WebGLRenderer, _w: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    this.eye.measure(renderer, readBuffer.texture);
  }
}

interface Effect {
  obj: THREE.Object3D;
  pos: V3;
  age: number;
  life: number;
  update: (e: Effect, ctx: { camPos: V3; dt: number; exposure: number }) => void;
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  /** Orbits, markers, zones and wind tracers: drawn after exposure metering so UI never dazzles the eye. */
  overlay = new THREE.Scene();
  cam: CameraController;
  eye = new EyeAdaptation();
  starfield = new Starfield();
  views = new Map<number, BodyView>();
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private noise3d = makeNoise3D(64);
  private orbitGroup = new THREE.Group();
  private orbitLines = new Map<number, THREE.Line>();
  private markers: THREE.Points;
  private markerMat: THREE.PointsMaterial;
  private hzGroup = new THREE.Group();
  private effects: Effect[] = [];
  private labelsEl: HTMLDivElement;
  private labels = new Map<number, HTMLDivElement>();
  private wind: WindParticles;
  private weather: GroundWeather;
  private realTime = 0;
  selectedId: number | null = null;
  /**
   * Night vision (realistic mode): in dim light the eye switches from cones to rods, which see
   * no colour and are most sensitive to blue-green (the Purkinje shift). Each pixel's absolute
   * luminance (pre-exposed value ÷ exposure; 1 = sunlit white ≈ 3·10⁴ cd/m²) blends it from full
   * colour (above ~1 cd/m²) to blue-grey rod vision (below ~0.005 cd/m²).
   */
  private nightVision = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uExposure: { value: 1 }, uOn: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uExposure; uniform float uOn; varying vec2 vUv;
      void main(){
        vec4 c = texture2D(tDiffuse, vUv);
        vec3 rgb = max(c.rgb, vec3(0.0));
        if (uOn > 0.5) {
          vec3 xyz = mat3(0.4124, 0.2126, 0.0193, 0.3576, 0.7152, 0.1192, 0.1805, 0.0722, 0.9505) * rgb;
          float absY = max(xyz.y, 1e-14) / uExposure;
          float rods = 1.0 - smoothstep(-6.8, -4.3, log(absY) / 2.302585);
          if (rods > 0.0) {
            // Scotopic luminance (Larson et al. 1997), normalised so white keeps its brightness.
            float V = max(xyz.y * (1.33 * (1.0 + (xyz.y + xyz.z) / max(xyz.x, 1e-12)) - 1.68), 0.0) / 2.57;
            vec3 night = V * vec3(0.78, 0.88, 1.18) / 0.88;
            rgb = mix(rgb, night, rods * 0.92);
          }
        }
        gl_FragColor = vec4(rgb, c.a);
      }`,
  });
  fps = 60;

  constructor(private canvas: HTMLCanvasElement, private sim: Simulation, overlay: HTMLDivElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.cam = new CameraController(canvas.clientWidth / Math.max(canvas.clientHeight, 1));
    this.scene.background = new THREE.Color(0, 0, 0);
    this.scene.add(this.starfield.group);
    this.overlay.add(this.orbitGroup);
    this.overlay.add(this.hzGroup);
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.composer.addPass(new RenderPass(this.scene, this.cam.camera));
    this.composer.addPass(new MeasurePass(this.eye));
    const overlayPass = new RenderPass(this.overlay, this.cam.camera);
    overlayPass.clear = false; // keep the world's colour and depth
    this.composer.addPass(overlayPass);
    // Cap what feeds the glare: a star's disk can be 10⁴× brighter than white. The bloom blur
    // kernels are truncated, so an over-bright source saturates even their edges and the glow
    // turns into a square. Anything above the cap is pure white on screen anyway.
    this.composer.addPass(
      new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); float l = max(max(c.r, c.g), c.b); gl_FragColor = vec4(c.rgb * min(1.0, 3.0 / max(l, 1e-6)), c.a); }',
      }),
    );
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.55, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.nightVision);
    this.composer.addPass(new OutputPass());
    this.markerMat = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, opacity: 0.9 });
    this.markers = new THREE.Points(new THREE.BufferGeometry(), this.markerMat);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 10;
    this.overlay.add(this.markers);
    this.labelsEl = document.createElement('div');
    this.labelsEl.className = 'labels';
    overlay.appendChild(this.labelsEl);
    this.wind = new WindParticles();
    this.overlay.add(this.wind.lines);
    this.weather = new GroundWeather(overlay);
    this.scene.add(this.weather.group);
    this.overlay.add(this.weather.overlayGroup);
    this.cam.groundHeight = (b, lat, lon) => {
      const v = this.views.get(b.id);
      return v instanceof RockyView ? v.heightAt(lat, lon) : 0;
    };
    this.cam.maxDepth = (b) => {
      const v = this.views.get(b.id);
      return v instanceof GiantView ? v.maxDepth() : 0;
    };
    sim.events.on('bodyRemoved', (b) => this.removeView(b));
    sim.events.on('reset', () => {
      for (const id of [...this.views.keys()]) this.removeView({ id } as Body);
      const f = sim.focus();
      if (f) this.cam.focus(f, { instant: true });
      this.eye.snap();
    });
    sim.events.on('impact', (e) => this.spawnImpact(e.pos, e.target, e.energy));
    sim.events.on('merge', (e) => this.spawnImpact(e.pos, e.result, e.energy));
    sim.events.on('supernova', (e) => this.spawnSupernova(e.pos, e.body));
    sim.events.on('disrupted', (e) => this.spawnDebris(e.pos, e.primary));
    sim.events.on('eruption', (e) => this.spawnEruption(e.body, e.lat, e.lon, e.vei));
    this.resize();
  }

  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this.cam.camera.aspect = w / Math.max(h, 1);
    this.cam.camera.updateProjectionMatrix();
  }

  private removeView(b: Body): void {
    const v = this.views.get(b.id);
    if (v) {
      this.scene.remove(v.group);
      v.dispose();
      this.views.delete(b.id);
    }
    const l = this.labels.get(b.id);
    if (l) {
      l.remove();
      this.labels.delete(b.id);
    }
    const o = this.orbitLines.get(b.id);
    if (o) {
      this.orbitGroup.remove(o);
      o.geometry.dispose();
      this.orbitLines.delete(b.id);
    }
  }

  private viewFor(b: Body): BodyView | null {
    let v = this.views.get(b.id);
    const want = b.isStarLike && b.kind !== 'brownDwarf' ? 'star' : b.isGiant ? 'giant' : 'rocky';
    const has = v instanceof StarView ? 'star' : v instanceof GiantView ? 'giant' : v ? 'rocky' : null;
    if (v && has !== want) {
      this.removeView(b);
      v = undefined;
    }
    if (!v) {
      v = want === 'star' ? new StarView(b) : want === 'giant' ? new GiantView(b, this.noise3d) : new RockyView(b, this.noise3d);
      this.views.set(b.id, v);
      this.scene.add(v.group);
    }
    return v;
  }

  render(realDt: number): void {
    const dt = Math.min(realDt, 0.1);
    this.realTime += dt;
    this.fps += (1 / Math.max(realDt, 1e-3) - this.fps) * 0.05;
    const sim = this.sim;
    this.cam.update(dt);
    this.eye.update(dt);
    const camPos = this.cam.pos;
    const lights: LightSrc[] = [];
    for (const b of sim.bodies) {
      if (b.star && b.star.L > 0) {
        const raw = blackbodyRGB(b.star.T);
        // Chromatic adaptation: the eye partly white-balances to the light it lives under, so a
        // red dwarf's light looks orange rather than neon red (and a blue star, pale blue).
        const c = raw.map((x) => Math.pow(Math.max(x, 1e-4), 0.55)) as [number, number, number];
        // Normalise colour to unit luminance so flux carries the brightness.
        const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        lights.push({ body: b, color: [c[0] / lum, c[1] / lum, c[2] / lum], L: b.star.L });
      }
    }
    this.nightVision.uniforms.uOn.value = view.mode === 'realistic' ? 1 : 0;
    this.nightVision.uniforms.uExposure.value = this.eye.exposure;
    const focus = sim.focus();
    const ctx: FrameCtx = {
      camPos,
      exposure: this.eye.exposure,
      realistic: view.mode === 'realistic',
      simTime: sim.time,
      realTime: this.realTime,
      dt,
      lights,
      focusId: sim.focusId,
      layer: view.layer,
      cameraAlt: this.cam.altitude(),
      pixelScale: this.renderer.getPixelRatio(),
      occluders: (body: Body) => this.occludersFor(body, lights),
      moonlight: (body: Body) => this.moonlightFor(body, lights),
      surface:
        this.cam.mode === 'surface' && this.cam.target
          ? { bodyId: this.cam.target.id, lat: this.cam.lat, lon: this.cam.lon, aboveGround: this.cam.alt - (this.cam.groundHeight ? this.cam.groundHeight(this.cam.target, this.cam.lat, this.cam.lon) : 0) }
          : null,
    };
    const alive = new Set<number>();
    for (const b of sim.bodies) {
      alive.add(b.id);
      const v = this.viewFor(b);
      if (!v) continue;
      // Skip detail for tiny, far bodies (markers represent them).
      const d = camPos.distTo(b.pos);
      const ang = b.radius / Math.max(d, 1);
      v.group.visible = ang > 2e-5 || b.isStarLike;
      if (v.group.visible) v.update(ctx);
    }
    for (const id of [...this.views.keys()]) if (!alive.has(id)) this.removeView({ id } as Body);
    // Near/far planes from the closest surface.
    let near = Infinity;
    for (const b of sim.bodies) near = Math.min(near, camPos.distTo(b.pos) - b.radius * 1.05);
    this.cam.camera.near = clamp(near * 0.3, 0.2, 1e7);
    this.cam.camera.far = 1e21;
    this.cam.camera.updateProjectionMatrix();
    this.starfield.update(this.eye.exposure, this.renderer.getPixelRatio(), this.canvas.clientHeight, this.cam.camera, this.eye.starExposure);
    this.updateOrbits(camPos);
    this.updateMarkers(camPos);
    this.updateHZ(camPos, lights);
    this.updateVoyages(camPos);
    this.updatePreview(camPos);
    this.updateEffects(camPos, dt);
    const fv = focus ? this.views.get(focus.id) : null;
    this.wind.update(fv instanceof RockyView && view.wind ? fv : null, focus, camPos, dt, this.realTime);
    const tgt = this.cam.target;
    this.weather.update({
      body: tgt,
      climate: tgt?.climate instanceof TerrestrialClimate ? tgt.climate : null,
      surface: ctx.surface,
      camPos,
      dt,
      brightness: view.mode === 'realistic' ? this.eye.sceneLuminance * this.eye.exposure * 1.6 : 0.6,
    });
    this.bloom.enabled = view.bloom;
    this.bloom.strength = view.mode === 'realistic' ? 0.55 : 0.75;
    this.composer.render(dt);
    this.updateLabels(camPos);
  }

  // ------------------------------------------------------------------ orbits

  private updateOrbits(camPos: V3): void {
    // Orbit lines would slice through the sky when standing on a planet.
    this.orbitGroup.visible = view.orbits && this.cam.mode !== 'surface';
    if (!this.orbitGroup.visible) return;
    const seen = new Set<number>();
    for (const b of this.sim.bodies) {
      const p = this.sim.primaryOf(b);
      if (!p || b.isStarLike && b.mass > 0.2 * p.mass) continue;
      const o = orbitFromState(V3.sub(b.pos, p.pos), V3.sub(b.vel, p.vel), G * (p.mass + b.mass), 0);
      const pts = orbitPoints(o, 360, 200 * AU);
      let line = this.orbitLines.get(b.id);
      if (!line) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(361 * 3), 3));
        const col = new THREE.Color(b.color);
        line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.45, depthWrite: false }));
        line.frustumCulled = false;
        this.orbitLines.set(b.id, line);
        this.orbitGroup.add(line);
      }
      const arr = (line.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
      const tmp = new THREE.Vector3();
      for (let i = 0; i < pts.length && i < 361; i++) {
        const w = new V3(p.pos.x + pts[i].x, p.pos.y + pts[i].y, p.pos.z + pts[i].z);
        rel(w, camPos, tmp);
        arr[3 * i] = tmp.x;
        arr[3 * i + 1] = tmp.y;
        arr[3 * i + 2] = tmp.z;
      }
      line.geometry.setDrawRange(0, Math.min(pts.length, 361));
      (line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const selected = b.id === this.selectedId || b.id === this.sim.focusId;
      (line.material as THREE.LineBasicMaterial).opacity = selected ? 0.8 : 0.35;
      // Fade orbits that are tiny on screen relative to the camera distance.
      const d = camPos.distTo(p.pos);
      line.visible = Math.abs(o.a) / Math.max(d, 1) > 0.004 || selected;
      seen.add(b.id);
    }
    for (const [id, l] of this.orbitLines) if (!seen.has(id)) l.visible = false;
  }

  // ------------------------------------------------------------------ markers and labels

  private updateMarkers(camPos: V3): void {
    this.markers.visible = view.markers;
    if (!view.markers) return;
    const bodies = this.sim.bodies;
    const pos = new Float32Array(bodies.length * 3);
    const col = new Float32Array(bodies.length * 3);
    const tmp = new THREE.Vector3();
    let n = 0;
    const h = this.canvas.clientHeight;
    const pxPerRad = h / ((this.cam.camera.fov * Math.PI) / 180);
    for (const b of bodies) {
      const d = camPos.distTo(b.pos);
      const px = (b.radius / Math.max(d, 1)) * pxPerRad;
      if (px > 2.5 || d < b.radius * 3) continue;
      rel(b.pos, camPos, tmp);
      // Pull markers in so they never hit the far plane.
      tmp.normalize().multiplyScalar(Math.min(d, 1e15));
      pos[3 * n] = tmp.x;
      pos[3 * n + 1] = tmp.y;
      pos[3 * n + 2] = tmp.z;
      const c = new THREE.Color(b.color);
      col[3 * n] = c.r;
      col[3 * n + 1] = c.g;
      col[3 * n + 2] = c.b;
      n++;
    }
    const g = this.markers.geometry;
    g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(col.slice(0, n * 3), 3));
    this.markerMat.size = 5 * this.renderer.getPixelRatio();
  }

  private updateLabels(camPos: V3): void {
    const show = view.labels;
    this.labelsEl.style.display = show ? '' : 'none';
    if (!show) return;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.cam.camera;
    const tmp = new THREE.Vector3();
    const placed: [number, number][] = [];
    const sorted = [...this.sim.bodies].sort((a, b) => b.mass - a.mass);
    for (const b of sorted) {
      let el = this.labels.get(b.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'label';
        el.dataset.id = String(b.id);
        this.labelsEl.appendChild(el);
        this.labels.set(b.id, el);
      }
      if (el.textContent !== b.name) el.textContent = b.name;
      // Inhabited worlds fly their empire's flag (⚔ while it is at war).
      const emp = this.sim.agency.empireOf(b);
      const flag = emp && view.markers ? '#' + emp.color.toString(16).padStart(6, '0') : '';
      if (el.dataset.flag !== flag) {
        el.dataset.flag = flag;
        el.style.setProperty('--flag', flag);
        el.classList.toggle('flag', !!emp && view.markers);
      }
      el.classList.toggle('war', !!emp && this.sim.agency.empires.atWar(emp));
      rel(b.pos, camPos, tmp);
      const dist = tmp.length();
      tmp.normalize().multiplyScalar(Math.min(dist, 1e12));
      tmp.project(cam);
      const visible = tmp.z < 1 && tmp.z > -1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1;
      const x = (tmp.x * 0.5 + 0.5) * w;
      const y = (-tmp.y * 0.5 + 0.5) * h;
      const important = b.id === this.sim.focusId || b.id === this.selectedId;
      const crowded = placed.some(([px, py]) => Math.abs(px - x) < 70 && Math.abs(py - y) < 16);
      const inside = this.cam.mode === 'surface' && b.id === this.sim.focusId;
      // Standing on a world: bodies below the local horizon are hidden by the ground.
      let belowHorizon = false;
      const tgt = this.cam.target;
      if (this.cam.mode === 'surface' && tgt && b !== tgt) {
        const up = V3.sub(camPos, tgt.pos).normalize();
        belowHorizon = V3.sub(b.pos, camPos).normalize().dot(up) < -0.01;
      }
      // Hidden behind a nearer body (e.g. the Sun's label while it is behind the planet).
      let occluded = false;
      if (visible && !belowHorizon) {
        const dir = V3.sub(b.pos, camPos);
        const dl = dir.len();
        dir.scale(1 / Math.max(dl, 1));
        for (const o of this.sim.bodies) {
          if (o === b || o.radius < 1e5) continue;
          const oc = V3.sub(o.pos, camPos);
          const t = oc.dot(dir);
          if (t <= 0 || t >= dl) continue;
          const d2 = oc.dot(oc) - t * t;
          if (d2 < o.radius * o.radius * 0.98) {
            occluded = true;
            break;
          }
        }
      }
      if (!visible || inside || belowHorizon || occluded || (crowded && !important)) {
        el.style.display = 'none';
        continue;
      }
      placed.push([x, y]);
      el.style.display = '';
      const pxR = (b.radius / Math.max(dist, 1)) * (h / ((cam.fov * Math.PI) / 180));
      el.style.transform = `translate(${x + Math.min(pxR, 200) * 0.7 + 8}px, ${y - 8}px)`;
      el.classList.toggle('focus', important);
    }
  }

  // ------------------------------------------------------------------ launch preview

  private preview: { from: V3; vel: V3; primary: Body | null } | null = null;
  private previewLine: THREE.Line | null = null;
  private previewArrow: THREE.Line | null = null;
  /** Show (or hide with null) the predicted path of a body about to be launched. */
  setLaunchPreview(p: { from: V3; vel: V3; primary: Body | null } | null): void {
    this.preview = p;
  }
  private updatePreview(camPos: V3): void {
    if (!this.previewLine) {
      this.previewLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8bf0c3, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false }));
      this.previewArrow = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, depthWrite: false, depthTest: false }));
      for (const l of [this.previewLine, this.previewArrow]) {
        l.frustumCulled = false;
        l.renderOrder = 20;
        this.overlay.add(l);
      }
    }
    const p = this.preview;
    this.previewLine.visible = this.previewArrow!.visible = !!p;
    if (!p) return;
    const pts: THREE.Vector3[] = [];
    const pr = p.primary;
    if (pr && p.vel.len() > 0) {
      const o = orbitFromState(V3.sub(p.from, pr.pos), p.vel, G * pr.mass, 0);
      const reach = Math.max(p.from.distTo(pr.pos) * 12, 1);
      for (const q of orbitPoints(o, 240, reach)) pts.push(rel(V3.add(pr.pos, q), camPos));
    } else {
      pts.push(rel(p.from, camPos), rel(p.from.clone().addScaled(p.vel, 3e7), camPos));
    }
    this.previewLine.geometry.setFromPoints(pts);
    // Arrow from the launch point along the velocity (same scale the drag uses).
    const r = pr ? p.from.distTo(pr.pos) : 1e11;
    const vc = pr ? Math.sqrt((G * pr.mass) / r) : 1e4;
    const tip = p.from.clone().addScaled(p.vel, (0.4 * r) / vc);
    this.previewArrow!.geometry.setFromPoints([rel(p.from, camPos), rel(tip, camPos)]);
  }

  // ------------------------------------------------------------------ colony ships

  private voyageGroup: THREE.Group | null = null;
  private updateVoyages(camPos: V3): void {
    if (!this.voyageGroup) {
      this.voyageGroup = new THREE.Group();
      this.overlay.add(this.voyageGroup);
    }
    const g = this.voyageGroup;
    const vs = this.sim.agency.voyages;
    while (g.children.length > vs.length * 2) {
      const o = g.children[g.children.length - 1] as THREE.Mesh;
      g.remove(o);
      o.geometry.dispose();
    }
    vs.forEach((v, i) => {
      const to = this.sim.getBody(v.toStar);
      if (!to) return;
      let line = g.children[2 * i] as THREE.Line | undefined;
      let ship = g.children[2 * i + 1] as THREE.Points | undefined;
      if (!line || !ship) {
        line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0x8fd8ff, dashSize: 1, gapSize: 1, transparent: true, opacity: 0.45, depthWrite: false }));
        ship = new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]), new THREE.PointsMaterial({ color: 0xbfeaff, size: 7, sizeAttenuation: false, depthWrite: false, transparent: true }));
        line.frustumCulled = ship.frustumCulled = false;
        g.add(line, ship);
      }
      // War fleets in red; colony ships in their empire's colour.
      const emp = this.sim.agency.empires.get(v.empire);
      const col = v.kind === 'fleet' ? 0xff4a3d : emp ? emp.color : 0x8fd8ff;
      (line.material as THREE.LineDashedMaterial).color.setHex(col);
      (ship.material as THREE.PointsMaterial).color.setHex(col);
      (ship.material as THREE.PointsMaterial).size = v.kind === 'fleet' ? 9 : 7;
      const f = clamp((this.sim.time - v.depart) / Math.max(v.arrive - v.depart, 1), 0, 1);
      const o = new V3(v.origin.x, v.origin.y, v.origin.z);
      const p = o.clone().addScaled(V3.sub(to.pos, o), f);
      const pts = [rel(o, camPos), rel(to.pos, camPos)];
      (line.geometry as THREE.BufferGeometry).setFromPoints(pts);
      line.computeLineDistances();
      const len = pts[0].distanceTo(pts[1]);
      (line.material as THREE.LineDashedMaterial).dashSize = len / 60;
      (line.material as THREE.LineDashedMaterial).gapSize = len / 60;
      (ship.geometry as THREE.BufferGeometry).setFromPoints([rel(p, camPos)]);
    });
  }

  // ------------------------------------------------------------------ habitable zones

  private hzRings = new Map<number, THREE.Mesh>();
  private updateHZ(camPos: V3, lights: LightSrc[]): void {
    this.hzGroup.visible = view.hz;
    if (!view.hz) return;
    const seen = new Set<number>();
    for (const l of lights) {
      const s = l.body;
      // Stars, brown dwarfs and white dwarfs all have habitable zones (the latter two shrink as they cool).
      if (!s.star || !(s.kind === 'star' || s.kind === 'brownDwarf' || s.kind === 'whiteDwarf')) continue;
      const hz = habitableZone(s.star.L, s.star.T);
      let m = this.hzRings.get(s.id);
      if (!m) {
        m = new THREE.Mesh(
          new THREE.RingGeometry(1, 2, 256, 1),
          new THREE.ShaderMaterial({
            uniforms: { uIn: { value: 1 }, uOut: { value: 2 }, uOptIn: { value: 0.9 }, uOptOut: { value: 2.2 } },
            vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
            fragmentShader: `uniform float uIn,uOut,uOptIn,uOptOut; varying vec2 vP;
              void main(){ float r = length(vP); float cons = step(uIn, r) * step(r, uOut); float opt = step(uOptIn, r) * step(r, uOptOut);
                float edge = smoothstep(0.0, 0.01 * uOut, min(abs(r-uIn), abs(r-uOut)));
                gl_FragColor = vec4(vec3(0.15, 0.85, 0.35) * (cons * 0.12 + opt * 0.05 + (1.0 - edge) * cons * 0.25), 1.0); }`,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          }),
        );
        m.rotation.x = -Math.PI / 2;
        m.frustumCulled = false;
        this.hzRings.set(s.id, m);
        this.hzGroup.add(m);
      }
      const u = (m.material as THREE.ShaderMaterial).uniforms;
      m.scale.setScalar(hz.optimisticOuter * 1.02);
      const k = 1 / (hz.optimisticOuter * 1.02);
      u.uIn.value = hz.inner * k;
      u.uOut.value = hz.outer * k;
      u.uOptIn.value = hz.optimisticInner * k;
      u.uOptOut.value = hz.optimisticOuter * k;
      (m.geometry as THREE.RingGeometry).dispose();
      m.geometry = new THREE.RingGeometry(hz.optimisticInner * k * 0.98, 1, 256, 1);
      rel(s.pos, camPos, m.position);
      seen.add(s.id);
    }
    for (const [id, m] of this.hzRings) m.visible = seen.has(id);
  }

  // ------------------------------------------------------------------ effects

  private spawnImpact(pos: V3, target: Body, energy: number): void {
    const size = clamp(Math.cbrt(energy) * 3, 2e4, target.radius * 0.8);
    const geo = new THREE.BufferGeometry();
    const n = 260;
    const p = new Float32Array(n * 3);
    const v: number[] = [];
    const up = V3.sub(pos, target.pos).normalize();
    for (let i = 0; i < n; i++) {
      const r = V3.perpendicular(up);
      const a = Math.random() * Math.PI * 2;
      const dir = V3.rotate(r, up, a).scale(Math.random() * 0.9).addScaled(up, 0.4 + Math.random()).normalize();
      v.push(dir.x, dir.y, dir.z);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffb070, size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false;
    this.scene.add(pts);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pts.add(flash);
    this.effects.push({
      obj: pts,
      pos: pos.clone(),
      age: 0,
      life: 4,
      update: (e, c) => {
        rel(e.pos, c.camPos, e.obj.position);
        const t = e.age / e.life;
        const arr = (geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        const dist = size * (0.2 + 3 * Math.sqrt(t));
        for (let i = 0; i < n; i++) {
          const d = toThree(new V3(v[3 * i], v[3 * i + 1], v[3 * i + 2]));
          arr[3 * i] = d.x * dist;
          arr[3 * i + 1] = d.y * dist;
          arr[3 * i + 2] = d.z * dist;
        }
        (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        (pts.material as THREE.PointsMaterial).opacity = 1 - t;
        flash.scale.setScalar(size * (0.3 + 2 * t));
        (flash.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - t * 3);
        (flash.material as THREE.MeshBasicMaterial).color.setRGB(3 * (1 - t), 2.2 * (1 - t), 1.2 * (1 - t));
      },
    });
  }

  /** Bodies between `body` and its brightest star that could cast a shadow on it. */
  /**
   * Light reflected onto `body` by its brightest neighbour (the Moon at full: ~2·10⁻⁶ of sunlight,
   * ~0.25 lux). Lambert-sphere phase law; geometric albedo from the climate model's albedo.
   * Only for the world the camera stands on or orbits closely.
   */
  private moonlightFor(body: Body, lights: LightSrc[]): { dir: V3; flux: number; color: [number, number, number] } | null {
    if (this.sim.focusId !== body.id || this.cam.altitude() > body.radius * 4 || body.isStarLike) return null;
    let best: { dir: V3; flux: number; color: [number, number, number] } | null = null;
    for (const r of this.sim.bodies) {
      if (r === body || r.isStarLike || r.radius < 1e5) continue;
      const toR = V3.sub(r.pos, body.pos);
      const d = toR.len();
      if (d < r.radius + body.radius) continue;
      // The star that lights the reflector most.
      let star: LightSrc | null = null,
        F = 0;
      for (const l of lights) {
        if (l.body === r) continue;
        const ds = V3.sub(l.body.pos, r.pos).len();
        const f = l.L / (4 * Math.PI * Math.max(ds * ds, 1));
        if (f > F) {
          F = f;
          star = l;
        }
      }
      if (!star) continue;
      const toStar = V3.sub(star.body.pos, r.pos).normalize();
      const toObs = V3.scaled(toR, -1 / d);
      const alpha = Math.acos(clamp(toStar.dot(toObs), -1, 1));
      const phase = (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;
      const bond = r.climate && 'stats' in r.climate && Number.isFinite((r.climate.stats as { albedo?: number }).albedo) ? (r.climate.stats as { albedo: number }).albedo : r.isGiant ? 0.45 : 0.12;
      const flux = F * ((2 / 3) * bond) * Math.pow(r.radius / d, 2) * phase;
      if (flux > (best?.flux ?? 1e-9 * 1361)) best = { dir: V3.scaled(toR, 1 / d), flux, color: [star.color[0] * 1.02, star.color[1] * 0.99, star.color[2] * 0.95] };
    }
    return best;
  }

  private occludersFor(body: Body, lights: LightSrc[]): { body: Body; atm: number }[] {
    const main = lights.filter((l) => l.body !== body).sort((a, b) => b.L / b.body.pos.distTo(body.pos) ** 2 - a.L / a.body.pos.distTo(body.pos) ** 2)[0];
    if (!main) return [];
    const S = main.body;
    const toS = V3.sub(S.pos, body.pos);
    const dS = toS.len();
    toS.scale(1 / dS);
    const sunAng = S.radius / dS;
    const out: { body: Body; atm: number; ang: number }[] = [];
    for (const o of this.sim.bodies) {
      if (o === body || o === S || o.isStarLike || o.radius < body.radius * 0.02) continue;
      const d = V3.sub(o.pos, body.pos);
      const dist = d.len();
      if (dist >= dS || d.dot(toS) <= 0) continue;
      const ang = o.radius / dist;
      const sep = Math.acos(clamp(d.dot(toS) / dist, -1, 1));
      // Within reach of any point of the body's disk.
      if (sep > ang + sunAng + Math.min(1, body.radius / dist) * 1.1) continue;
      const c = o.climate;
      const atm = c instanceof TerrestrialClimate ? clamp(c.P / 1e5, 0, 1) : o.isGiant ? 1 : 0;
      out.push({ body: o, atm, ang });
    }
    return out.sort((a, b) => b.ang - a.ang).slice(0, 3);
  }

  /** Ash and steam column rising from an erupting volcano, spreading into an umbrella cloud. */
  private spawnEruption(body: Body, lat: number, lon: number, vei: number): void {
    const n = 500;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const mat = new THREE.PointsMaterial({ color: 0x9a8a78, size: 3, sizeAttenuation: false, transparent: true, depthWrite: false, opacity: 0.9 });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.scene.add(pts);
    const seeds = Array.from({ length: n }, () => [Math.random(), Math.random(), Math.random()]);
    const top = 15e3 * Math.pow(1.6, vei - 5);
    const spread = top * 3;
    this.effects.push({
      obj: pts,
      pos: body.pos.clone(),
      age: 0,
      life: 25,
      update: (e, c) => {
        const t = e.age / e.life;
        const cl = Math.cos(lat);
        const f = body.frame();
        const d = (x: number, y: number, z: number) => new V3(f.x.x * x + f.y.x * y + f.z.x * z, f.x.y * x + f.y.y * y + f.z.y * z, f.x.z * x + f.y.z * y + f.z.z * z);
        const up = d(cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat));
        const east = d(-Math.sin(lon), Math.cos(lon), 0);
        const north = up.cross(east);
        const base = V3.add(body.pos, up.clone().scale(body.radius));
        rel(base, c.camPos, e.obj.position);
        const arr = (geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
        const grow = Math.min(1, t * 4);
        for (let i = 0; i < n; i++) {
          const [a, r, h] = seeds[i];
          const hh = top * grow * Math.pow(h, 0.6);
          const umb = smoothstep(0.75, 1, h) * spread * Math.min(1, t * 2) * Math.sqrt(r);
          const col = top * 0.06 * r;
          const ang = a * Math.PI * 2;
          const v = up.clone().scale(hh).addScaled(east, Math.cos(ang) * (col + umb)).addScaled(north, Math.sin(ang) * (col + umb));
          const tv = toThree(v);
          arr[3 * i] = tv.x;
          arr[3 * i + 1] = tv.y;
          arr[3 * i + 2] = tv.z;
        }
        (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        mat.opacity = 0.9 * (1 - smoothstep(0.7, 1, t));
        mat.color.setRGB(0.6, 0.54, 0.47).multiplyScalar(view.mode === 'realistic' ? Math.min(3, 0.35 * c.exposure) : 0.8);
      },
    });
  }

  private spawnSupernova(pos: V3, body: Body): void {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uExp: { value: 1 } },
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vN = normalize(normalMatrix*normal); vec4 mv = modelViewMatrix*vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
      fragmentShader: `uniform float uT, uExp; varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); vec3 c = mix(vec3(1.0,0.9,0.8), vec3(0.9,0.3,0.5), uT); gl_FragColor = vec4(c * f * (1.0 - uT) * uExp, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
    shell.frustumCulled = false;
    this.scene.add(shell);
    this.effects.push({
      obj: shell,
      pos: pos.clone(),
      age: 0,
      life: 25,
      update: (e, c) => {
        rel(e.pos, c.camPos, e.obj.position);
        const t = e.age / e.life;
        shell.scale.setScalar(body.radius * 50 + 30 * AU * Math.pow(t, 0.8));
        mat.uniforms.uT.value = t;
        mat.uniforms.uExp.value = view.mode === 'realistic' ? Math.min(50, 1e3 * c.exposure) : 3;
      },
    });
  }

  private spawnDebris(pos: V3, primary: Body): void {
    this.spawnImpact(pos, primary, 1e26);
  }

  private updateEffects(camPos: V3, dt: number): void {
    for (const e of this.effects) {
      e.age += dt;
      e.update(e, { camPos, dt, exposure: this.eye.exposure });
    }
    const dead = this.effects.filter((e) => e.age >= e.life);
    for (const e of dead) {
      this.scene.remove(e.obj);
      e.obj.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      });
    }
    this.effects = this.effects.filter((e) => e.age < e.life);
  }

  // ------------------------------------------------------------------ picking

  /** Body under the cursor (screen-space proximity, favouring big bodies). */
  pick(x: number, y: number): Body | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const cam = this.cam.camera;
    const tmp = new THREE.Vector3();
    let best: Body | null = null;
    let bestScore = Infinity;
    const pxPerRad = h / ((cam.fov * Math.PI) / 180);
    for (const b of this.sim.bodies) {
      rel(b.pos, this.cam.pos, tmp);
      const dist = tmp.length();
      tmp.normalize().multiplyScalar(Math.min(dist, 1e12));
      tmp.project(cam);
      if (tmp.z > 1 || tmp.z < -1) continue;
      const sx = (tmp.x * 0.5 + 0.5) * w;
      const sy = (-tmp.y * 0.5 + 0.5) * h;
      const r = Math.max(10, (b.radius / Math.max(dist, 1)) * pxPerRad);
      const d = Math.hypot(sx - x, sy - y);
      if (d < r && d / r < bestScore) {
        bestScore = d / r;
        best = b;
      }
    }
    return best;
  }

  /** Point on the plane through `through` (ecliptic-parallel) under the cursor (for placing bodies). */
  planePoint(x: number, y: number, through: V3): V3 | null {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const ndc = new THREE.Vector3((x / w) * 2 - 1, -(y / h) * 2 + 1, 0.5);
    ndc.unproject(this.cam.camera);
    const dir = ndc.normalize();
    const origin = rel(through, this.cam.pos);
    // Plane y = origin.y in render space.
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = origin.y / dir.y;
    if (t <= 0) return null;
    const p = dir.multiplyScalar(t);
    return new V3(this.cam.pos.x + p.x, this.cam.pos.y - p.z, this.cam.pos.z + p.y);
  }

  climateOf(b: Body | null): TerrestrialClimate | null {
    return b && b.climate instanceof TerrestrialClimate ? b.climate : null;
  }
}

/** Animated wind tracers drawn just above the focused planet's surface. */
class WindParticles {
  lines: THREE.LineSegments;
  private n = 3500;
  private lat = new Float32Array(this.n);
  private lon = new Float32Array(this.n);
  private age = new Float32Array(this.n);
  private pos: Float32Array;
  private col: Float32Array;
  constructor() {
    this.pos = new Float32Array(this.n * 6);
    this.col = new Float32Array(this.n * 6);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 8;
    for (let i = 0; i < this.n; i++) this.reset(i);
  }
  private reset(i: number) {
    this.lat[i] = Math.asin(Math.random() * 2 - 1);
    this.lon[i] = Math.random() * Math.PI * 2 - Math.PI;
    this.age[i] = Math.random() * 4;
  }
  update(v: RockyView | null, b: Body | null, camPos: V3, dt: number, _t: number): void {
    const c = v?.climate;
    this.lines.visible = !!(v && c && b && c.P > 10);
    if (!this.lines.visible || !c || !b || !v) return;
    const R = b.radius + v.cloudTop * 0.4;
    const grid = c.grid;
    const u = c.circ.u;
    const w = c.circ.v;
    const f = b.frame();
    const center = rel(b.pos, camPos);
    const ex = toThree(f.x),
      ey = toThree(f.y),
      ez = toThree(f.z);
    const speedVis = 2e-6 * (6.371e6 / b.radius) * 3;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > 4) this.reset(i);
      const la = this.lat[i],
        lo = this.lon[i];
      const uu = grid.sample(u, la, lo);
      const vv = grid.sample(w, la, lo);
      const nla = clamp(la + vv * speedVis * dt * 60, -1.55, 1.55);
      const nlo = lo + (uu * speedVis * dt * 60) / Math.max(Math.cos(la), 0.05);
      const p0 = this.pt(la, lo, R, ex, ey, ez, center);
      const p1 = this.pt(nla + (nla - la) * 6, nlo + (nlo - lo) * 6, R, ex, ey, ez, center);
      this.lat[i] = nla;
      this.lon[i] = nlo;
      this.pos.set([p0.x, p0.y, p0.z, p1.x, p1.y, p1.z], i * 6);
      const s = clamp(Math.hypot(uu, vv) / 25, 0, 1);
      const fade = Math.sin((this.age[i] / 4) * Math.PI);
      const col = [0.4 + 0.6 * s, 0.75 + 0.25 * s, 1 - 0.6 * s].map((x) => x * fade * 0.9);
      this.col.set([col[0] * 0.3, col[1] * 0.3, col[2] * 0.3, col[0], col[1], col[2]], i * 6);
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.lines.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }
  private pt(lat: number, lon: number, R: number, ex: THREE.Vector3, ey: THREE.Vector3, ez: THREE.Vector3, c: THREE.Vector3) {
    const cl = Math.cos(lat);
    const x = cl * Math.cos(lon) * R,
      y = cl * Math.sin(lon) * R,
      z = Math.sin(lat) * R;
    return new THREE.Vector3(c.x + ex.x * x + ey.x * y + ez.x * z, c.y + ex.y * x + ey.y * y + ez.y * z, c.z + ex.z * x + ey.z * y + ez.z * z);
  }
}

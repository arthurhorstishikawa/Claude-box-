import * as THREE from 'three';
import { clamp } from '../core/math';
import { V3 } from '../core/vec3';
import type { Body } from '../physics/body';
import { toThree } from './units';

export type CamMode = 'orbit' | 'surface';

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Camera with two modes:
 * - orbit: circles the focused body (world-up = ecliptic north);
 * - surface: attached to the body's rotating frame at (lat, lon, altitude) with free look and
 *   WASD flight — lets you land on rocky worlds or sink into a gas giant's cloud decks.
 */
export class CameraController {
  camera: THREE.PerspectiveCamera;
  /** Camera position in the physics frame (m). */
  pos = new V3(0, -3e7, 1e7);
  quat = new THREE.Quaternion();
  target: Body | null = null;
  mode: CamMode = 'orbit';
  dist = 2e7;
  az = 0.6;
  el = 0.35;
  lat = 0;
  lon = 0;
  alt = 1000;
  heading = 0;
  pitch = -0.15;
  keys = new Set<string>();
  /** Ground height (m above the body's reference radius) under (lat, lon); set by the planet view. */
  groundHeight: ((b: Body, lat: number, lon: number) => number) | null = null;
  /** How deep (m below the reference radius) the camera may go (gas giants). */
  maxDepth: ((b: Body) => number) | null = null;
  private trans: { from: V3; fromQ: THREE.Quaternion; t: number; dur: number } | null = null;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(55, aspect, 0.5, 1e21);
    this.camera.position.set(0, 0, 0);
  }

  /** Fly to a new target. */
  focus(b: Body, opts: { instant?: boolean; dist?: number } = {}): void {
    const from = this.pos.clone();
    const fromQ = this.quat.clone();
    this.target = b;
    this.mode = 'orbit';
    const k = b.isStarLike ? 5 : b.isGiant ? 3.2 : 3.6;
    this.dist = opts.dist ?? Math.max(b.radius * k, 2e3);
    if (!opts.instant) this.trans = { from, fromQ, t: 0, dur: 1.6 };
    else this.trans = null;
  }

  minDistance(): number {
    const b = this.target;
    if (!b) return 10;
    return b.radius * 1.0004 + 5;
  }

  /** Orbit-mode drag / surface-mode look. */
  drag(dx: number, dy: number): void {
    if (this.mode === 'orbit') {
      this.az -= dx * 0.005;
      this.el = clamp(this.el + dy * 0.005, -1.55, 1.55);
    } else {
      this.heading += dx * 0.004;
      this.pitch = clamp(this.pitch - dy * 0.004, -1.5, 1.5);
    }
  }

  zoom(delta: number): void {
    const f = Math.exp(clamp(delta, -400, 400) * 0.0012);
    const b = this.target;
    if (this.mode === 'orbit') {
      this.dist = clamp(this.dist * f, this.minDistance(), 5e15);
      if (b && !b.isStarLike && b.kind !== 'smallBody' && this.dist < b.radius * 1.035 && f < 1) this.enterSurface();
    } else if (b) {
      const ground = this.groundAt(b);
      const above = Math.max(1, this.alt - ground);
      const newAbove = above * f;
      this.alt = ground + Math.max(newAbove, 1.5);
      if (this.alt > b.radius * 0.05 && f > 1) this.exitSurface();
    }
  }

  private groundAt(b: Body): number {
    const depth = this.maxDepth ? this.maxDepth(b) : 0;
    if (depth > 0) return -depth;
    return this.groundHeight ? this.groundHeight(b, this.lat, this.lon) : 0;
  }

  /**
   * Switch to the surface/flight mode below the camera. The altitude comes from the requested
   * distance (`this.dist`, or `alt` if given), not the camera's lagging position — otherwise a
   * zoom step that crosses the threshold would land and immediately take off again.
   */
  enterSurface(alt?: number): void {
    const b = this.target;
    if (!b) return;
    const rel = V3.sub(this.pos, b.pos);
    const loc = b.toBody(rel.clone().normalize());
    this.lat = Math.asin(clamp(loc.z, -1, 1));
    this.lon = Math.atan2(loc.y, loc.x);
    const want = alt ?? this.dist - b.radius;
    this.alt = clamp(want, this.groundAt(b) + 50, b.radius * 0.04);
    this.trans = null;
    this.heading = 0;
    this.pitch = -0.35;
    this.mode = 'surface';
  }

  exitSurface(): void {
    const b = this.target;
    if (!b) return;
    this.mode = 'orbit';
    this.dist = clamp(b.radius + this.alt, this.minDistance(), 5e15);
    // Keep looking at the same side of the planet.
    const rel = V3.sub(this.pos, b.pos).normalize();
    const r = toThree(rel);
    this.el = Math.asin(clamp(r.y, -1, 1));
    this.az = Math.atan2(r.x, r.z);
  }

  update(dt: number): void {
    const b = this.target;
    if (!b) return;
    if (this.mode === 'orbit') {
      // Spherical coordinates in render space around the target.
      const ce = Math.cos(this.el);
      const off = new THREE.Vector3(Math.sin(this.az) * ce, Math.sin(this.el), Math.cos(this.az) * ce).multiplyScalar(this.dist);
      const offP = new V3(off.x, -off.z, off.y);
      const want = V3.add(b.pos, offP);
      const look = new THREE.Matrix4().lookAt(off, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0));
      const q = new THREE.Quaternion().setFromRotationMatrix(look);
      this.applyTransition(want, q, dt);
      return;
    }
    // Surface / flight mode in the body-fixed frame.
    const f = b.frame();
    const speedBase = Math.max(8, (this.alt - this.groundAt(b)) * 1.2);
    let mf = 0,
      mr = 0,
      mu = 0;
    if (this.keys.has('w')) mf += 1;
    if (this.keys.has('s')) mf -= 1;
    if (this.keys.has('d')) mr += 1;
    if (this.keys.has('a')) mr -= 1;
    if (this.keys.has('e') || this.keys.has(' ')) mu += 1;
    if (this.keys.has('q')) mu -= 1;
    const boost = this.keys.has('shift') ? 6 : 1;
    const step = speedBase * boost * dt;
    if (mf || mr) {
      const hx = Math.cos(this.heading) * mf - Math.sin(this.heading) * mr;
      const hy = Math.sin(this.heading) * mf + Math.cos(this.heading) * mr;
      const R = b.radius + this.alt;
      this.lat = clamp(this.lat + (hx * step) / R, -1.5707, 1.5707);
      this.lon += (hy * step) / (R * Math.max(Math.cos(this.lat), 0.02));
    }
    if (mu) this.alt += mu * step;
    const ground = this.groundAt(b);
    if (this.alt < ground + 1.5) this.alt = ground + 1.5;
    if (this.alt > b.radius * 0.06) {
      this.exitSurface();
      return;
    }
    const cl = Math.cos(this.lat),
      sl = Math.sin(this.lat),
      co = Math.cos(this.lon),
      so = Math.sin(this.lon);
    const upB = new V3(cl * co, cl * so, sl);
    const eastB = new V3(-so, co, 0);
    const northB = new V3(-sl * co, -sl * so, cl);
    const toI = (v: V3) => new V3(f.x.x * v.x + f.y.x * v.y + f.z.x * v.z, f.x.y * v.x + f.y.y * v.y + f.z.y * v.z, f.x.z * v.x + f.y.z * v.y + f.z.z * v.z);
    const up = toI(upB);
    const east = toI(eastB);
    const north = toI(northB);
    const want = b.pos.clone().addScaled(up, b.radius + this.alt);
    const fwd = north
      .clone()
      .scale(Math.cos(this.heading) * Math.cos(this.pitch))
      .addScaled(east, Math.sin(this.heading) * Math.cos(this.pitch))
      .addScaled(up, Math.sin(this.pitch));
    const fwdT = toThree(fwd).normalize();
    const upT = toThree(up).normalize();
    const look = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), fwdT, upT);
    const q = new THREE.Quaternion().setFromRotationMatrix(look);
    this.applyTransition(want, q, dt);
  }

  private applyTransition(want: V3, q: THREE.Quaternion, dt: number): void {
    if (this.trans) {
      this.trans.t += dt / this.trans.dur;
      const e = ease(Math.min(1, this.trans.t));
      // Interpolate distance logarithmically so long flights don't crawl at the end.
      const from = this.trans.from;
      this.pos.set(from.x + (want.x - from.x) * e, from.y + (want.y - from.y) * e, from.z + (want.z - from.z) * e);
      this.quat.copy(this.trans.fromQ).slerp(q, Math.min(1, e * 1.4));
      if (this.trans.t >= 1) this.trans = null;
    } else {
      this.pos.copy(want);
      this.quat.copy(q);
    }
    this.camera.quaternion.copy(this.quat);
    this.camera.position.set(0, 0, 0);
    this.camera.updateMatrixWorld(true);
  }

  /** Altitude above the target's reference radius (m). */
  altitude(): number {
    const b = this.target;
    if (!b) return Infinity;
    return this.pos.distTo(b.pos) - b.radius;
  }

  get transitioning(): boolean {
    return this.trans !== null;
  }
}

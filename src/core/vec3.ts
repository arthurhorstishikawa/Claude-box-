/** Minimal double-precision 3-vector used by the simulation (not Three.js). */
export class V3 {
  constructor(public x = 0, public y = 0, public z = 0) {}

  static from(a: ArrayLike<number>): V3 {
    return new V3(a[0], a[1], a[2]);
  }
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: V3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone(): V3 {
    return new V3(this.x, this.y, this.z);
  }
  add(v: V3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v: V3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  addScaled(v: V3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }
  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  dot(v: V3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  cross(v: V3): V3 {
    return new V3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }
  len(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  len2(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  normalize(): this {
    const l = this.len();
    if (l > 0) this.scale(1 / l);
    return this;
  }
  distTo(v: V3): number {
    return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
  static sub(a: V3, b: V3): V3 {
    return new V3(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  static add(a: V3, b: V3): V3 {
    return new V3(a.x + b.x, a.y + b.y, a.z + b.z);
  }
  static scaled(a: V3, s: number): V3 {
    return new V3(a.x * s, a.y * s, a.z * s);
  }
  /** Rotate v around unit axis k by angle (Rodrigues). */
  static rotate(v: V3, k: V3, angle: number): V3 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const kxv = k.cross(v);
    const kdv = k.dot(v);
    return new V3(
      v.x * c + kxv.x * s + k.x * kdv * (1 - c),
      v.y * c + kxv.y * s + k.y * kdv * (1 - c),
      v.z * c + kxv.z * s + k.z * kdv * (1 - c),
    );
  }
  /** Any unit vector perpendicular to v. */
  static perpendicular(v: V3): V3 {
    const a = Math.abs(v.z) < 0.9 ? new V3(0, 0, 1) : new V3(1, 0, 0);
    return v.cross(a).normalize();
  }
  /** Spherical linear interpolation between unit vectors. */
  static slerp(a: V3, b: V3, t: number): V3 {
    const d = Math.max(-1, Math.min(1, a.dot(b)));
    const th = Math.acos(d);
    if (th < 1e-6) return new V3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t).normalize();
    const s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s;
    const wb = Math.sin(t * th) / s;
    return new V3(a.x * wa + b.x * wb, a.y * wa + b.y * wb, a.z * wa + b.z * wb).normalize();
  }
}

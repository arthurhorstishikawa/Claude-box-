import * as THREE from 'three';
import { V3 } from '../core/vec3';

/**
 * Physics frame: x toward the vernal equinox, z = ecliptic north (right-handed).
 * Render frame: three.js with +Y up (= ecliptic north). Mapping (x, y, z) → (x, z, −y).
 * The render origin is always the camera (camera-relative rendering, metres).
 */
export function toThree(v: V3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(v.x, v.z, -v.y);
}

export function toThreeDir(v: V3): [number, number, number] {
  return [v.x, v.z, -v.y];
}

export function fromThree(v: THREE.Vector3, out = new V3()): V3 {
  return out.set(v.x, -v.z, v.y);
}

/** Camera-relative render position of a physics point (float64 subtraction first). */
export function rel(p: V3, cam: V3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(p.x - cam.x, p.z - cam.z, -(p.y - cam.y));
}

/** Rotation matrix taking body-fixed coordinates (x prime meridian, z pole) to render frame. */
export function bodyBasis(frame: { x: V3; y: V3; z: V3 }, out = new THREE.Matrix4()): THREE.Matrix4 {
  const x = toThree(frame.x);
  const y = toThree(frame.y);
  const z = toThree(frame.z);
  return out.makeBasis(x, y, z);
}

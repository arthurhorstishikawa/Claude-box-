import * as THREE from 'three';
import { clamp } from '../core/math';
import { Noise3 } from '../core/noise';
import { V3 } from '../core/vec3';
import type { TerrainMap } from '../climate/terrain';

const SEG = 32; // quads per patch edge
const VERTS = SEG + 1;

/** Map a cube-face coordinate (face 0..5, u, v ∈ [-1, 1]) to a unit vector (body frame). */
export function cubeToSphere(face: number, u: number, v: number, out = new V3()): V3 {
  let x: number, y: number, z: number;
  switch (face) {
    case 0:
      x = 1; y = u; z = v;
      break;
    case 1:
      x = -1; y = -u; z = v;
      break;
    case 2:
      x = -u; y = 1; z = v;
      break;
    case 3:
      x = u; y = -1; z = v;
      break;
    case 4:
      x = -v; y = u; z = 1;
      break;
    default:
      x = v; y = u; z = -1;
  }
  // Area-preserving-ish cube → sphere mapping.
  const x2 = x * x, y2 = y * y, z2 = z * z;
  out.set(x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3), y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3), z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3));
  return out;
}

/**
 * Height field of a rocky world in metres relative to its datum: the generated map
 * (bilinear) plus fractal detail that grows with altitude contrast. Deterministic, so the
 * camera can query exactly what is rendered.
 */
export class HeightField {
  private noise: Noise3;
  constructor(public map: TerrainMap, public radius: number, seed: number, public detailAmp: number) {
    this.noise = new Noise3(seed ^ 0x5f3759df);
  }

  base(d: V3): number {
    const t = this.map;
    const lat = Math.asin(clamp(d.z, -1, 1));
    const lon = Math.atan2(d.y, d.x);
    let x = ((lon + Math.PI) / (2 * Math.PI)) * t.w - 0.5;
    let y = (0.5 - lat / Math.PI) * t.h - 0.5;
    y = clamp(y, 0, t.h - 1);
    x = ((x % t.w) + t.w) % t.w;
    const i0 = Math.floor(x),
      j0 = Math.floor(y);
    const i1 = (i0 + 1) % t.w,
      j1 = Math.min(t.h - 1, j0 + 1);
    const fx = x - i0,
      fy = y - j0;
    const e = t.elev;
    const a = e[j0 * t.w + i0] * (1 - fx) + e[j0 * t.w + i1] * fx;
    const b = e[j1 * t.w + i0] * (1 - fx) + e[j1 * t.w + i1] * fx;
    return a * (1 - fy) + b * fy;
  }

  material(d: V3): number {
    const t = this.map;
    const lat = Math.asin(clamp(d.z, -1, 1));
    const lon = Math.atan2(d.y, d.x);
    const i = Math.floor(((lon + Math.PI) / (2 * Math.PI)) * t.w) % t.w;
    const j = clamp(Math.floor((0.5 - lat / Math.PI) * t.h), 0, t.h - 1);
    return t.material[j * t.w + i];
  }

  /** Fractal detail: octaves finer than ~(cellSize) are skipped. */
  height(d: V3, minWavelength = 20): number {
    const h0 = this.base(d);
    const R = this.radius;
    let amp = this.detailAmp;
    let wl = 60e3;
    let s = 0;
    const n = this.noise;
    const mountain = clamp(Math.abs(h0) / 2500, 0.15, 1.6);
    for (let o = 0; o < 11 && wl >= minWavelength; o++) {
      const f = R / wl;
      const v = o < 3 ? n.noise(d.x * f, d.y * f, d.z * f) : 1 - 2 * Math.abs(n.noise(d.x * f + 7.3, d.y * f, d.z * f));
      s += v * amp * (o < 3 ? 1 : mountain);
      amp *= 0.47;
      wl *= 0.5;
    }
    return h0 + s;
  }
}

export interface PatchNode {
  key: string;
  face: number;
  /** Integer patch indices on the face at this depth (0 … 2^depth − 1). */
  ix: number;
  iy: number;
  x0: number;
  y0: number;
  size: number;
  depth: number;
  center: V3; // body frame, metres from planet centre
  radius: number; // bounding radius (m)
  /** Distance from the camera to the patch's bounding sphere (m). */
  dist: number;
}

export function patchKey(face: number, depth: number, ix: number, iy: number): string {
  return `${face}:${depth}:${ix}:${iy}`;
}

/** Describe the quadtree node (face, depth, ix, iy) of a planet of radius R. */
export function patchNode(face: number, depth: number, ix: number, iy: number, R: number, maxElev: number, camBody?: V3): PatchNode {
  const size = 2 / (1 << depth);
  const x0 = -1 + ix * size;
  const y0 = -1 + iy * size;
  const c = cubeToSphere(face, x0 + size / 2, y0 + size / 2);
  const arc = size * 0.85; // approximate angular half-diagonal (rad)
  const center = c.scale(R);
  const radius = arc * R + maxElev;
  const dist = camBody ? Math.max(0, camBody.distTo(center) - radius) : 0;
  return { key: patchKey(face, depth, ix, iy), face, ix, iy, x0, y0, size, depth, center, radius, dist };
}

/** The parent of a quadtree node, or null at the root of a face. */
export function parentNode(n: PatchNode, R: number, maxElev: number): PatchNode | null {
  if (n.depth === 0) return null;
  return patchNode(n.face, n.depth - 1, n.ix >> 1, n.iy >> 1, R, maxElev);
}

let sharedIndex: THREE.BufferAttribute | null = null;
function patchIndex(): THREE.BufferAttribute {
  if (sharedIndex) return sharedIndex;
  const idx: number[] = [];
  const v = (i: number, j: number) => j * VERTS + i;
  for (let j = 0; j < SEG; j++)
    for (let i = 0; i < SEG; i++) {
      idx.push(v(i, j), v(i + 1, j), v(i, j + 1));
      idx.push(v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
    }
  // Skirts: an extra ring of vertices after the grid.
  const base = VERTS * VERTS;
  const ring: number[] = [];
  for (let i = 0; i < SEG; i++) ring.push(v(i, 0));
  for (let j = 0; j < SEG; j++) ring.push(v(SEG, j));
  for (let i = SEG; i > 0; i--) ring.push(v(i, SEG));
  for (let j = SEG; j > 0; j--) ring.push(v(0, j));
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k];
    const b = ring[(k + 1) % ring.length];
    const sa = base + k;
    const sb = base + ((k + 1) % ring.length);
    idx.push(a, sa, b, b, sa, sb);
  }
  sharedIndex = new THREE.BufferAttribute(new Uint32Array(idx), 1);
  return sharedIndex;
}

export const SKIRT_COUNT = SEG * 4;

/** Build a patch mesh geometry: positions relative to the patch centre, in the body frame. */
export function buildPatchGeometry(node: PatchNode, hf: HeightField, seaLevel: number, flattenSea: boolean): THREE.BufferGeometry {
  const R = hf.radius;
  const nV = VERTS * VERTS + SKIRT_COUNT;
  const pos = new Float32Array(nV * 3);
  const nrm = new Float32Array(nV * 3);
  const bdir = new Float32Array(nV * 3);
  const detail = new Float32Array(nV);
  const P = new Float64Array(VERTS * VERTS * 3);
  const d = new V3();
  const cellWl = (node.size * R * 0.8) / SEG;
  const minWl = Math.max(15, cellWl * 1.5);
  for (let j = 0; j < VERTS; j++)
    for (let i = 0; i < VERTS; i++) {
      const u = node.x0 + (node.size * i) / SEG;
      const v = node.y0 + (node.size * j) / SEG;
      cubeToSphere(node.face, u, v, d);
      let h = hf.height(d, minWl);
      const k = j * VERTS + i;
      detail[k] = h - hf.base(d);
      if (flattenSea && h < seaLevel) h = seaLevel;
      const r = R + h;
      P[3 * k] = d.x * r;
      P[3 * k + 1] = d.y * r;
      P[3 * k + 2] = d.z * r;
      pos[3 * k] = P[3 * k] - node.center.x;
      pos[3 * k + 1] = P[3 * k + 1] - node.center.y;
      pos[3 * k + 2] = P[3 * k + 2] - node.center.z;
      bdir[3 * k] = d.x;
      bdir[3 * k + 1] = d.y;
      bdir[3 * k + 2] = d.z;
    }
  // Normals from the grid (central differences).
  const at = (i: number, j: number) => {
    i = clamp(i, 0, SEG);
    j = clamp(j, 0, SEG);
    const k = j * VERTS + i;
    return [P[3 * k], P[3 * k + 1], P[3 * k + 2]];
  };
  for (let j = 0; j < VERTS; j++)
    for (let i = 0; i < VERTS; i++) {
      const a = at(i + 1, j),
        b = at(i - 1, j),
        c = at(i, j + 1),
        e = at(i, j - 1);
      const ux = a[0] - b[0],
        uy = a[1] - b[1],
        uz = a[2] - b[2];
      const vx = c[0] - e[0],
        vy = c[1] - e[1],
        vz = c[2] - e[2];
      let nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const k = j * VERTS + i;
      // Orient outward.
      if (nx * bdir[3 * k] + ny * bdir[3 * k + 1] + nz * bdir[3 * k + 2] < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[3 * k] = nx / l;
      nrm[3 * k + 1] = ny / l;
      nrm[3 * k + 2] = nz / l;
    }
  // Skirt vertices: copies of the border pulled toward the centre of the planet.
  const ring: number[] = [];
  for (let i = 0; i < SEG; i++) ring.push(i);
  for (let j = 0; j < SEG; j++) ring.push(j * VERTS + SEG);
  for (let i = SEG; i > 0; i--) ring.push(SEG * VERTS + i);
  for (let j = SEG; j > 0; j--) ring.push(j * VERTS);
  const skirt = node.size * R * 0.02 + 30;
  const cc = [node.center.x, node.center.y, node.center.z];
  for (let s = 0; s < ring.length; s++) {
    const k = ring[s];
    const q = VERTS * VERTS + s;
    for (let c = 0; c < 3; c++) {
      pos[3 * q + c] = P[3 * k + c] - bdir[3 * k + c] * skirt - cc[c];
      nrm[3 * q + c] = nrm[3 * k + c];
      bdir[3 * q + c] = bdir[3 * k + c];
    }
    detail[q] = detail[k];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('bdir', new THREE.BufferAttribute(bdir, 3));
  g.setAttribute('detail', new THREE.BufferAttribute(detail, 1));
  g.setIndex(patchIndex());
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), node.radius);
  return g;
}

/** Choose the visible leaf patches for a camera at `camBody` (body frame, metres). */
export function selectPatches(R: number, camBody: V3, maxDepth: number, splitFactor = 2.3, maxElev = 9000): PatchNode[] {
  const out: PatchNode[] = [];
  const camDist = camBody.len();
  const camDir = camBody.clone().scale(1 / Math.max(camDist, 1));
  // Horizon: points beyond it (accounting for mountains) are hidden.
  const hor = camDist > R ? Math.acos(clamp(R / camDist, -1, 1)) + Math.acos(clamp(R / (R + maxElev), -1, 1)) : Math.PI;
  const c = new V3();
  const visit = (face: number, ix: number, iy: number, depth: number) => {
    const size = 2 / (1 << depth);
    const x0 = -1 + ix * size,
      y0 = -1 + iy * size;
    cubeToSphere(face, x0 + size / 2, y0 + size / 2, c);
    const arc = size * 0.85;
    const ang = Math.acos(clamp(c.dot(camDir), -1, 1));
    if (ang - arc > hor + 0.02 && depth > 0) return;
    const radius = arc * R + maxElev;
    const dist = Math.max(0, Math.hypot(c.x * R - camBody.x, c.y * R - camBody.y, c.z * R - camBody.z) - radius * 0.5);
    if (depth < maxDepth && dist < radius * splitFactor) {
      visit(face, 2 * ix, 2 * iy, depth + 1);
      visit(face, 2 * ix + 1, 2 * iy, depth + 1);
      visit(face, 2 * ix, 2 * iy + 1, depth + 1);
      visit(face, 2 * ix + 1, 2 * iy + 1, depth + 1);
      return;
    }
    out.push(patchNode(face, depth, ix, iy, R, maxElev, camBody));
  };
  for (let f = 0; f < 6; f++) visit(f, 0, 0, 0);
  return out;
}

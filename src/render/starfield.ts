import * as THREE from 'three';
import { Rng } from '../core/rng';
import { blackbodyRGB } from '../stars/blackbody';
import { eclipticFromRaDec } from '../sim/factory';
import { NOISE_GLSL } from './glsl';
import { toThreeDir } from './units';
import { view } from './viewSettings';

/**
 * Background sky: ~12k procedural stars concentrated toward a Milky Way band, plus a diffuse
 * galactic glow with dust lanes. Brightness is physical in Realistic mode (only visible once
 * the eye dark-adapts) and boosted in Enhanced mode.
 */
export class Starfield {
  group = new THREE.Group();
  private points: THREE.Points;
  private sky: THREE.Mesh;
  private starMat: THREE.ShaderMaterial;
  private skyMat: THREE.ShaderMaterial;

  constructor() {
    const rng = new Rng(20261102);
    const n = 12000;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const mag = new Float32Array(n);
    const gp = toThreeDir(eclipticFromRaDec(192.86, 27.13));
    const gc = toThreeDir(eclipticFromRaDec(266.4, -28.94));
    const gpV = new THREE.Vector3(gp[0], gp[1], gp[2]);
    const gcV = new THREE.Vector3(gc[0], gc[1], gc[2]);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      // Concentrate fainter stars toward the galactic plane.
      let d: THREE.Vector3;
      const m = 6.8 - 2.5 * Math.log10(1 + rng.next() * 9999) * 0.62;
      const planeBias = m > 4 ? 0.65 : 0.2;
      for (;;) {
        const z = rng.range(-1, 1);
        const a = rng.range(0, Math.PI * 2);
        const s = Math.sqrt(1 - z * z);
        d = tmp.set(s * Math.cos(a), z, s * Math.sin(a)).clone();
        const b = Math.abs(d.dot(gpV));
        if (rng.next() < 1 - planeBias * b) break;
      }
      pos[3 * i] = d.x;
      pos[3 * i + 1] = d.y;
      pos[3 * i + 2] = d.z;
      mag[i] = m;
      const T = Math.exp(rng.range(Math.log(2800), Math.log(26000)) * 0.5 + Math.log(5200) * 0.5 * (rng.next() < 0.7 ? 1 : 1.12));
      const [r, g, b] = blackbodyRGB(T);
      col[3 * i] = r;
      col[3 * i + 1] = g;
      col[3 * i + 2] = b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('mag', new THREE.BufferAttribute(mag, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uPx: { value: 1 }, uDist: { value: 1e18 } },
      vertexShader: /* glsl */ `
        attribute float mag; attribute vec3 color;
        uniform float uScale; uniform float uPx; uniform float uDist;
        varying vec3 vCol;
        void main(){
          // Flux relative to a magnitude-0 star; radiance spread over the point sprite.
          float flux = pow(10.0, -0.4 * mag);
          float size = clamp(1.6 + 2.2 * pow(flux, 0.25), 1.6, 6.0) * uPx;
          vCol = color * flux * uScale / (size * size / (uPx * uPx));
          vec4 mv = modelViewMatrix * vec4(position * uDist, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w * 0.99999;
          gl_PointSize = size;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          float a = exp(-r * r * 3.5);
          gl_FragColor = vec4(vCol * a, 1.0);
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Depth-tested so planets hide the stars behind them (points sit just inside the far plane).
      depthTest: true,
      transparent: true,
    });
    this.points = new THREE.Points(geo, this.starMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -20;
    this.group.add(this.points);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 1 }, uGalPole: { value: gpV }, uGalCenter: { value: gcV }, uProjInv: { value: new THREE.Matrix4() }, uCamRot: { value: new THREE.Matrix3() } },
      // A full-screen pass: each pixel's view direction comes from the inverse projection, so
      // the sky stays smooth at any distance (a giant sky sphere broke into flat facets).
      vertexShader: /* glsl */ `
        uniform mat4 uProjInv; uniform mat3 uCamRot;
        varying vec3 vDir;
        void main(){
          vec4 v = uProjInv * vec4(position.xy, -1.0, 1.0); // near plane: finite even with a 1e21 m far plane
          vDir = uCamRot * (v.xyz / v.w);
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uScale; uniform vec3 uGalPole; uniform vec3 uGalCenter;
        varying vec3 vDir;
        ${NOISE_GLSL}
        void main(){
          vec3 d = normalize(vDir);
          float b = dot(d, uGalPole);
          float band = exp(-b * b / 0.012) + 0.35 * exp(-b * b / 0.06);
          float bulge = exp(-pow(acos(clamp(dot(d, uGalCenter), -1.0, 1.0)), 2.0) / 0.12);
          float n = fbm3(d * 6.0, 5) * 0.5 + 0.5;
          float dust = smoothstep(0.35, 0.75, fbm3(d * 9.0 + 3.0, 5) * 0.5 + 0.5) * exp(-b * b / 0.004);
          float glow = (band * (0.55 + 0.6 * n) + 1.6 * bulge * (0.6 + 0.4 * n)) * (1.0 - 0.75 * dust);
          vec3 col = mix(vec3(0.75, 0.78, 0.95), vec3(1.0, 0.86, 0.66), clamp(bulge * 1.4, 0.0, 1.0));
          gl_FragColor = vec4(col * glow * uScale, 1.0);
        }`,
      depthWrite: false,
      depthTest: false,
    });
    this.sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -30;
    this.group.add(this.sky);
  }

  update(exposure: number, pixelRatio: number, viewportHeight: number, camera: THREE.PerspectiveCamera): void {
    const fov = camera.fov;
    (this.skyMat.uniforms.uProjInv.value as THREE.Matrix4).copy(camera.projectionMatrixInverse);
    (this.skyMat.uniforms.uCamRot.value as THREE.Matrix3).setFromMatrix4(camera.matrixWorld);
    const realistic = view.mode === 'realistic';
    this.group.visible = view.background !== 'black';
    this.sky.visible = view.background === 'milkyway';
    // Irradiance of a magnitude-0 star relative to sunlight at Earth: 10^(-0.4·26.74).
    const m0 = 2.0e-11;
    const pixelSolidAngle = Math.pow((fov * Math.PI) / 180 / viewportHeight, 2);
    const physical = (m0 / pixelSolidAngle) * Math.PI;
    this.starMat.uniforms.uScale.value = realistic ? physical * exposure : 0.9;
    this.starMat.uniforms.uPx.value = pixelRatio;
    // Diffuse Milky Way ≈ 3e-9 of sunlit-white radiance (dark-sky surface brightness).
    this.skyMat.uniforms.uScale.value = realistic ? 4e-9 * exposure : 0.035;
  }
}

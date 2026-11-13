import * as THREE from 'three';
import { clamp } from '../core/math';
import { view } from './viewSettings';

/** Largest value we trust in the half-float HDR buffer; anything above is treated as clipped. */
const CLIP = 3.0e4;
/** Metering grid: one tap per cell. */
const MW = 64,
  MH = 48;

/**
 * Human-eye adaptation. The HDR frame is metered on the GPU (a 64×48 grid of cells, each the
 * average of 6×6 taps), then
 * exposure adapts quickly toward brighter scenes (≈0.4 s) and slowly toward darker ones
 * (≈3 s), within the range of the human eye.
 *
 * Metering combines two rules, like a person looking around:
 * - the log-average luminance sets the overall level (dark night sky → fully dark-adapted
 *   eye, faint stars and the Milky Way appear);
 * - bright regions cap the exposure (a sunlit planet or a star's disk filling part of the
 *   view (the brightest 1% of it) keeps its detail, and everything much fainter — background stars, a planet's
 *   night side — sinks into black: get close to a star and you see nothing else).
 *
 * All shaders pre-multiply their output by the current exposure (pre-exposed HDR) so values
 * stay inside half-float range; values that still clip push the exposure down hard.
 */
export class EyeAdaptation {
  exposure = 1;
  target = 1;
  /** Absolute log-average luminance (1 = sunlit white surface at 1 AU). */
  sceneLuminance = 0.18;
  /** Absolute luminance of the brightest ~1% of the view. */
  highlight = 1;
  /** Mean absolute luminance of glare sources over the whole view (their veiling flux). */
  peak = 0;
  private rt: THREE.WebGLRenderTarget;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private buf = new Float32Array(MW * MH * 4);
  private sorted = new Float32Array(MW * MH);
  private frame = 0;
  private ok = true;
  private clipped = false;
  readonly material: THREE.ShaderMaterial;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(MW, MH, { type: THREE.FloatType, depthBuffer: false });
    this.material = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc; varying vec2 vUv;
        void main(){
          // Average 6×6 taps over the cell, so small bright things (city lights, distant
          // fires) count in proportion to the area they cover instead of being hit or missed.
          float l = 0.0;
          for (int j = 0; j < 6; j++)
            for (int i = 0; i < 6; i++) {
              vec2 o = (vec2(float(i), float(j)) + 0.5) / 6.0 - 0.5;
              float t = dot(texture2D(tSrc, vUv + o / vec2(${MW}.0, ${MH}.0)).rgb, vec3(0.2126, 0.7152, 0.0722));
              if (!(t < ${CLIP.toFixed(1)})) t = ${CLIP.toFixed(1)}; // inf / NaN / overflow
              l += max(t, 0.0);
            }
          l /= 36.0;
          gl_FragColor = vec4(l, 0.0, 0.0, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.scene.add(this.quad);
  }

  /** Meter the (pre-exposed) frame and update the absolute luminance estimates. */
  measure(renderer: THREE.WebGLRenderer, hdr: THREE.Texture): void {
    if (!this.ok || view.mode !== 'realistic') return;
    if (this.frame++ % 3 !== 0) return;
    try {
      this.material.uniforms.tSrc.value = hdr;
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(this.rt);
      renderer.render(this.scene, this.cam);
      renderer.readRenderTargetPixels(this.rt, 0, 0, MW, MH, this.buf);
      renderer.setRenderTarget(prev);
      const n = MW * MH;
      for (let k = 0; k < n; k++) this.sorted[k] = this.buf[k * 4];
      this.sorted.sort();
      // Glare sources (a star's disk and halo) are far brighter than the scene around them. The
      // eye doesn't stop down until they are black-white specks — they add a veil instead,
      // which only dominates when a star fills a good part of the view.
      // Glare = far brighter than the bright part of the scene (90th percentile): a small sun
      // in the sky qualifies; a planet filling part of a black sky, or a star filling the
      // view, does not (they set the exposure through the highlight rule instead).
      const thr = Math.max(this.sorted[Math.floor(n * 0.9)] * 40, 1e-12);
      let s = 0,
        wsum = 0,
        glare = 0;
      for (let j = 0; j < MH; j++)
        for (let i = 0; i < MW; i++) {
          const l = this.buf[(j * MW + i) * 4];
          if (l > thr) glare += l;
          // Centre-weighted average, like the eye's fixation.
          const dx = (i + 0.5) / MW - 0.5,
            dy = (j + 0.5) / MH - 0.5;
          const w = 1 + 2 * Math.exp(-(dx * dx + dy * dy) / 0.04);
          s += Math.log(Math.max(Math.min(l, thr), 1e-9)) * w;
          wsum += w;
        }
      const hi = Math.min(this.sorted[Math.floor(n * 0.99)], thr);
      const logAvg = Math.exp(s / wsum);
      if (!Number.isFinite(logAvg) || !Number.isFinite(hi)) return;
      this.sceneLuminance = Math.max(1e-14, logAvg / this.exposure);
      this.highlight = Math.max(1e-14, hi / this.exposure);
      this.peak = Math.max(1e-14, glare / n / this.exposure);
      const top = this.sorted[n - 1];
      this.clipped = top >= CLIP * 0.999 && glare / n > CLIP * 0.05;
    } catch {
      this.ok = false;
    }
  }

  /** Sensitivity used for stars: the fully dark-adapted eye picks out point lights. */
  starExposure = 1;
  private starTarget = 1;

  update(dt: number): void {
    if (view.mode !== 'realistic') {
      this.exposure = Math.pow(2, view.ev);
      this.starExposure = this.exposure;
      return;
    }
    // Scene brightness plus the veil of glare from bright sources (`peak` = glare flux).
    const L = this.sceneLuminance + 0.05 * this.peak;
    // Perceived brightness: daylight scenes map to middle grey; twilight and night scenes stay
    // dim (night vision is far less sensitive than a camera that would turn night into day).
    const key = 0.18 * Math.pow(10, -1.2 * clamp((-2 - Math.log10(L)) / 5, 0, 1));
    const fromAverage = key / L;
    // Bright parts of the scene itself (sunlit clouds, snow) stay just below white.
    const fromHighlights = 1.0 / this.highlight;
    const raw = Math.min(fromAverage, fromHighlights) * Math.pow(2, view.ev);
    // The adaptation limit: how far the eye may open up in the dark.
    const limit = clamp(view.adaptLimit, 10, 3e5);
    this.target = clamp(raw, 1.5e-6, limit);
    this.starTarget = clamp(Math.min(0.18 / L, fromHighlights) * Math.pow(2, view.ev), 1.5e-6, 3e5);
    const brighter = this.target < this.exposure;
    // Clipped highlights: we only know the scene is brighter than measured — adapt fast.
    // Light adaptation takes a fraction of a second. Dark adaptation has two stages, as in the
    // eye: cones recover within seconds, then rods slowly take over for night vision (half an
    // hour in reality, compressed to ~10 s here).
    const rodStage = this.exposure > 300;
    const tau = this.clipped ? 0.12 : brighter ? 0.45 : rodStage ? 6 : 2.2;
    const a = 1 - Math.exp(-dt / tau);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(this.target) - Math.log(this.exposure)) * a);
    // Dark adaptation for faint stars is slow (minutes in reality; seconds here).
    const as = 1 - Math.exp(-dt / (this.starTarget < this.starExposure ? 0.45 : 5));
    this.starExposure = Math.exp(Math.log(this.starExposure) + (Math.log(this.starTarget) - Math.log(this.starExposure)) * as);
  }

  /** Instantly adapt (after teleports/scenario loads). */
  snap(): void {
    this.exposure = this.target;
    this.starExposure = this.starTarget;
  }
}

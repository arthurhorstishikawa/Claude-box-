import * as THREE from 'three';
import { COLORMAP_GLSL, EQUIRECT_GLSL, LOGDEPTH_F, LOGDEPTH_PARS_F, LOGDEPTH_PARS_V, LOGDEPTH_V, NOISE_GLSL, SCATTER_GLSL } from './glsl';

const v3 = (r = 0, g = 0, b = 0) => new THREE.Vector3(r, g, b);
const sunUniforms = () => ({
  uNumSuns: { value: 0 },
  uSunDir: { value: [v3(1, 0, 0), v3(1, 0, 0)] },
  uSunRadiance: { value: [v3(), v3()] },
});
const atmoUniforms = () => ({
  uBetaR: { value: v3(5.8e-6, 13.5e-6, 33.1e-6) },
  uBetaM: { value: v3(2e-6, 2e-6, 2e-6) },
  uMieAlbedo: { value: v3(0.9, 0.9, 0.9) },
  uHr: { value: 8000 },
  uHm: { value: 1200 },
  uMieG: { value: 0.76 },
  uAtmR: { value: 6.471e6 },
  uGroundR: { value: 6.371e6 },
  uPlanetCenter: { value: v3() },
});

/** Shared GLSL used by planet surfaces: lighting helpers and blackbody glow. */
const SHADE_GLSL = /* glsl */ `
vec3 glowColor(float T){
  float t = clamp((T - 700.0) / 2300.0, 0.0, 1.0);
  vec3 c = mix(vec3(1.0, 0.12, 0.02), vec3(1.0, 0.5, 0.12), smoothstep(0.0, 0.45, t));
  return mix(c, vec3(1.0, 0.85, 0.65), smoothstep(0.45, 1.0, t));
}
float glowIntensity(float T){ return 5.67e-8 * pow(max(T, 0.0), 4.0) / 1361.0 * 0.6; }
// View-path transmittance through the atmosphere from the camera (origin) to point p.
vec3 viewTransmittance(vec3 pc, vec3 p){
  vec3 ro = -pc;
  vec3 rd = normalize(p);
  float tMax = length(p);
  vec2 ta = raySphere(ro, rd, uAtmR);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return vec3(1.0);
  float ds = (t1 - t0) / 8.0;
  vec2 od = vec2(0.0);
  for (int i = 0; i < 8; i++) {
    vec3 q = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float h = max(length(q) - uGroundR, 0.0);
    od += vec2(exp(-h / uHr), exp(-h / uHm)) * ds;
  }
  return exp(-(uBetaR * od.x + uBetaM * od.y));
}
`;

export function makeTerrainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uElevTex: { value: null },
      uClimA: { value: null },
      uClimB: { value: null },
      uLayerTex: { value: null },
      uLayer: { value: 0 },
      uLayerRange: { value: new THREE.Vector2(0, 1) },
      uPalette: { value: 0 },
      uSeaLevel: { value: 0 },
      uHasOcean: { value: 0 },
      uWetWorld: { value: 0 },
      uLiquidDeep: { value: v3(0.01, 0.05, 0.14) },
      uLiquidShallow: { value: v3(0.04, 0.2, 0.3) },
      uRockA: { value: v3(0.3, 0.27, 0.24) },
      uRockB: { value: v3(0.5, 0.45, 0.4) },
      uSand: { value: v3(0.62, 0.52, 0.36) },
      uPlant: { value: v3(0.05, 0.14, 0.03) },
      uPlantDry: { value: v3(0.35, 0.33, 0.12) },
      uSnow: { value: v3(0.9, 0.92, 0.95) },
      uFrost: { value: v3(0.85, 0.82, 0.78) },
      uSeaIceCol: { value: v3(0.75, 0.82, 0.9) },
      uLightsColor: { value: v3(1.0, 0.72, 0.38) },
      uLightsScale: { value: 0 },
      uAmbient: { value: v3(0, 0, 0) },
      uExposure: { value: 1 },
      uTime: { value: 0 },
      uHasAtm: { value: 0 },
      ...sunUniforms(),
      ...atmoUniforms(),
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      attribute vec3 bdir; attribute float detail;
      varying vec3 vBdir; varying float vDetail; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vBdir = bdir; vDetail = detail;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      ${EQUIRECT_GLSL}
      ${NOISE_GLSL}
      ${SCATTER_GLSL}
      ${COLORMAP_GLSL}
      uniform vec3 uPlanetCenter;
      ${SHADE_GLSL}
      uniform sampler2D uElevTex, uClimA, uClimB, uLayerTex;
      uniform int uLayer, uPalette;
      uniform vec2 uLayerRange;
      uniform float uSeaLevel, uHasOcean, uWetWorld, uLightsScale, uExposure, uTime, uHasAtm;
      uniform vec3 uLiquidDeep, uLiquidShallow, uRockA, uRockB, uSand, uPlant, uPlantDry, uSnow, uFrost, uSeaIceCol, uLightsColor, uAmbient;
      varying vec3 vBdir; varying float vDetail; varying vec3 vWorld; varying vec3 vNrm;
      // Pixel footprint on the unit sphere, for fading procedural detail before it aliases.
      float gFp;
      float aa(float k){ return 1.0 - smoothstep(0.12, 0.45, k * gFp); }
      float nz(vec3 p, float k){ return mix(0.5, snoise(p * k) * 0.5 + 0.5, aa(k)); }
      void main(){
        vec3 d = normalize(vBdir);
        gFp = max(length(fwidth(d)), 1e-9);
        vec2 em = sampleEq(uElevTex, d).rg;
        float elev = em.r + vDetail;
        float matv = em.g;
        vec4 A = sampleEq(uClimA, d);
        vec4 B = sampleEq(uClimB, d);
        float Ts = A.r, snow = A.g, seaIce = A.b, veg = A.a;
        float cloud = B.r, precip = B.g, lights = B.b, frost = B.a;
        float n1 = nz(d, 180.0);
        float n2 = nz(d + 3.0, 900.0);
        // Close-up ground texture (km to tens of metres), faded in only where resolved.
        float micro = (nz(d + 7.0, 6000.0) - 0.5) * 0.5 + (nz(d + 11.0, 40000.0) - 0.5) * 0.35 + (nz(d + 13.0, 250000.0) - 0.5) * 0.25;
        vec3 V = normalize(vWorld);
        vec3 N = normalize(vNrm);
        vec3 G = normalize(vWorld - uPlanetCenter); // geometric up
        bool ocean = uHasOcean > 0.5 && elev < uSeaLevel;
        vec3 albedo;
        float spec = 0.0;
        float rough = 0.08;
        if (ocean) {
          float depth = uSeaLevel - elev;
          albedo = mix(uLiquidShallow, uLiquidDeep, smoothstep(5.0, 2500.0, depth));
          float iceCov = smoothstep(0.03, 0.6, seaIce + (n1 - 0.5) * 0.25);
          albedo = mix(albedo, uSeaIceCol * (0.85 + 0.15 * n2 + micro * 0.3), iceCov);
          spec = 1.0 - iceCov;
          // Wind waves in body-fixed coordinates; unresolved waves widen the sun glint instead.
          float wv = aa(30000.0);
          vec3 wn = vec3(snoise(d * 30000.0 + uTime * 0.02), snoise(d * 30000.0 + 7.0 - uTime * 0.017), snoise(d * 9000.0 + 2.0 + uTime * 0.01));
          N = normalize(G + wn * 0.06 * spec * wv);
          rough = mix(0.22, 0.07, wv);
        } else {
          vec3 rock = mix(uRockA, uRockB, clamp(matv + (n1 - 0.5) * 0.35, 0.0, 1.0));
          rock *= 0.85 + 0.3 * n2 + micro;
          float pmm = precip;
          float arid = uWetWorld * (1.0 - smoothstep(0.35, 2.2, pmm));
          vec3 ground = mix(rock, uSand * (0.85 + 0.3 * n1 + micro * 0.6), arid * 0.85);
          vec3 plant = mix(uPlantDry, uPlant, smoothstep(0.6, 3.0, pmm)) * (1.0 + micro * 0.8);
          float vegCov = clamp(veg * (0.75 + 0.5 * n1) + micro * 0.4 * veg, 0.0, 1.0);
          albedo = mix(ground, plant, vegCov);
          // Snow: thicker on flatter ground, patchy at the edges.
          float slope = 1.0 - dot(N, G);
          float sc = smoothstep(4.0, 80.0, snow * (0.6 + 0.8 * n1 + micro)) * (1.0 - smoothstep(0.25, 0.6, slope) * 0.6);
          albedo = mix(albedo, uSnow * (1.0 + micro * 0.15), sc);
          albedo = mix(albedo, uFrost, smoothstep(1.0, 30.0, frost * (0.5 + n2)));
          // Lake/shore wetness darkening near sea level.
          if (uHasOcean > 0.5) albedo *= 1.0 - 0.25 * smoothstep(40.0, 0.0, elev - uSeaLevel);
          albedo = max(albedo, vec3(0.0));
        }
        // Data overlays.
        if (uLayer > 0) {
          float val = sampleEq(uLayerTex, d).r;
          float x = (val - uLayerRange.x) / (uLayerRange.y - uLayerRange.x);
          vec3 c = uPalette == 1 ? blueRed(x) : uPalette == 2 ? rain(x) : turbo(x);
          albedo = c * 0.85;
          spec = 0.0;
        }
        // Lighting from up to two stars, plus blue skylight where there is air.
        float tauZ = uBetaR.b * uHr + uBetaM.r * uHm;
        vec3 skyTint = mix(vec3(0.45, 0.62, 1.0), uMieAlbedo, clamp(uBetaM.r * uHm / max(tauZ, 1e-9), 0.0, 1.0));
        float skyAmt = uHasAtm * 0.35 * (1.0 - exp(-tauZ));
        vec3 col = vec3(0.0);
        float dayness = 0.0;
        for (int s = 0; s < 2; s++) {
          if (s >= uNumSuns) break;
          vec3 L = uSunDir[s];
          float ndl = max(dot(N, L), 0.0);
          float cosG = dot(G, L);
          float horizon = smoothstep(-0.03, 0.05, cosG);
          float shadow = 1.0 - 0.45 * cloud * float(uHasAtm > 0.5);
          vec3 rad = uSunRadiance[s];
          if (uHasAtm > 0.5) {
            // Sunlight reddened by the atmosphere on its way down.
            vec2 od = lightDepth(vWorld - uPlanetCenter, L);
            rad *= exp(-(uBetaR * od.x + uBetaM * od.y));
          }
          col += albedo * rad * ndl * horizon * shadow;
          // Skylight: hemispherical, keeps shadowed slopes from going pitch black by day.
          col += albedo * uSunRadiance[s] * skyTint * skyAmt * smoothstep(-0.15, 0.35, cosG) * (0.6 + 0.4 * dot(N, G));
          dayness = max(dayness, horizon);
          if (spec > 0.0) {
            vec3 H = normalize(L - V);
            float nh = max(dot(N, H), 0.0);
            float a2 = rough * rough;
            float dd = nh * nh * (a2 - 1.0) + 1.0;
            float D = a2 / (PI * dd * dd);
            float F = 0.02 + 0.98 * pow(1.0 - max(dot(-V, H), 0.0), 5.0);
            col += rad * D * F * 0.25 * spec * horizon * shadow * ndl;
          }
        }
        col += albedo * uAmbient;
        // Molten rock and city lights glow on their own.
        if (Ts > 750.0) col += glowColor(Ts) * glowIntensity(Ts) * smoothstep(750.0, 1100.0, Ts) * uExposure;
        if (lights > 0.0 && uLayer == 0 && !ocean) {
          // 'lights' is the fraction of land that is lit urban area. Regional variation first,
          // then cities: a pixel is urban when a multi-scale pattern exceeds the threshold that
          // leaves exactly that fraction lit. Seen from far away, the mean shows instead.
          float c1 = snoise(d * 90.0) * 0.5 + 0.5;
          float f = clamp(lights * (0.3 + 1.6 * smoothstep(0.35, 0.8, c1)), 1e-5, 0.6);
          float c2 = snoise(d * 400.0 + 2.0) * 0.5 + 0.5;
          float c3 = nz(d + 4.0, 1800.0);
          float c4 = nz(d + 6.0, 9000.0);
          float p = 0.55 * c2 + 0.3 * c3 + 0.15 * c4;
          // Upper-tail normal quantile (Abramowitz & Stegun 26.2.23) for the threshold.
          float tq = sqrt(-2.0 * log(f));
          float z = tq - (2.515517 + 0.802853 * tq + 0.010328 * tq * tq) / (1.0 + 1.432788 * tq + 0.189269 * tq * tq + 0.001308 * tq * tq * tq);
          float thr = 0.5 + 0.13 * z;
          float mask = smoothstep(thr - 0.015, thr + 0.015, p) * (0.6 + 0.8 * c4);
          float lit = mix(f, mask, aa(400.0));
          col += uLightsColor * lit * uLightsScale * (1.0 - dayness);
        }
        if (uHasAtm > 0.5) {
          // Aerial perspective: light lost on the way to the camera, plus light scattered into the view.
          vec3 trans;
          vec3 ins = atmosphere(-uPlanetCenter, V, length(vWorld), trans);
          col = col * trans + ins;
        }
        gl_FragColor = vec4(col, 1.0);
        ${LOGDEPTH_F}
      }`,
  });
}

/** Thin cloud shell seen from space: coverage from the climate model, detail from noise. */
export function makeCloudShellMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uClimB: { value: null },
      uWind: { value: null },
      uTime: { value: 0 },
      uStorms: { value: new Array(12).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0)) },
      uStormInfo: { value: new Array(12).fill(0).map(() => new THREE.Vector4(0, 0, 0, 0)) },
      uNumStorms: { value: 0 },
      uCloudColor: { value: v3(1, 1, 1) },
      uOpacity: { value: 1 },
      uAmbient: { value: v3() },
      uFlowScale: { value: 1 },
      ...sunUniforms(),
      ...atmoUniforms(),
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vDir = normalize(position);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      ${EQUIRECT_GLSL}
      ${NOISE_GLSL}
      ${SCATTER_GLSL}
      uniform vec3 uPlanetCenter;
      uniform sampler2D uClimB, uWind;
      uniform float uTime, uOpacity, uFlowScale;
      uniform vec4 uStorms[12];    // xyz = centre dir (body), w = angular radius
      uniform vec4 uStormInfo[12]; // x = intensity, y = spin, z = kind (0 trop, 1 extra, 2 dust)
      uniform int uNumStorms;
      uniform vec3 uCloudColor, uAmbient;
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      float cloudDensity(vec3 d){
        float cov = sampleEq(uClimB, d).r;
        vec2 wind = sampleEq(uWind, d).rg;
        // Flow-map advection: two phases cross-faded so the noise never shears to pieces.
        vec3 east = normalize(vec3(-d.y, d.x, 0.0) + 1e-6);
        vec3 north = cross(d, east);
        vec3 flow = (east * wind.x + north * wind.y) * 2e-4 * uFlowScale;
        float ph0 = fract(uTime * 0.05), ph1 = fract(uTime * 0.05 + 0.5);
        float w0 = 1.0 - abs(2.0 * ph0 - 1.0);
        vec3 p = d * 9.0;
        float n0 = fbm3(p + flow * ph0 * 40.0, 6);
        float n1 = fbm3(p + flow * ph1 * 40.0 + 13.7, 6);
        float n = mix(n1, n0, w0) * 0.5 + 0.5;
        float dens = smoothstep(1.0 - cov, 1.0 - cov + 0.35, n + 0.12 * cov);
        // Storm systems: spiral bands around a clear eye.
        for (int i = 0; i < 12; i++) {
          if (i >= uNumStorms) break;
          vec3 c = uStorms[i].xyz;
          float R = uStorms[i].w;
          float ang = acos(clamp(dot(d, c), -1.0, 1.0));
          if (ang > R * 2.2) continue;
          vec3 e1 = normalize(cross(vec3(0.0, 0.0, 1.0), c) + 1e-5);
          vec3 e2 = cross(c, e1);
          float th = atan(dot(d, e2), dot(d, e1));
          float r = ang / R;
          float spin = uStormInfo[i].y;
          float inten = uStormInfo[i].x;
          float arms = sin(th * 2.0 * spin + log(r + 0.05) * 5.0 - uTime * 0.6 * spin) * 0.5 + 0.5;
          float body = exp(-r * r * 1.6) * (0.55 + 0.45 * arms);
          float eye = uStormInfo[i].z < 0.5 ? smoothstep(0.05, 0.12, r) : 1.0;
          dens = max(dens, clamp(body * inten * 1.4, 0.0, 1.0) * eye);
          if (uStormInfo[i].z < 0.5) dens *= eye;
        }
        return dens;
      }
      void main(){
        vec3 d = normalize(vDir);
        float dens = cloudDensity(d);
        if (dens < 0.01) discard;
        vec3 N = normalize(vNrm);
        vec3 V = normalize(vWorld);
        vec3 col = vec3(0.0);
        for (int s = 0; s < 2; s++) {
          if (s >= uNumSuns) break;
          vec3 L = uSunDir[s];
          float ndl = dot(N, L);
          float lit = smoothstep(-0.12, 0.25, ndl);
          vec2 od = lightDepth(vWorld - uPlanetCenter, L);
          vec3 rad = uSunRadiance[s] * exp(-(uBetaR * od.x + uBetaM * od.y));
          float silver = pow(max(dot(-V, L), 0.0), 8.0) * 0.6;
          col += uCloudColor * rad * lit * (0.75 + 0.25 * dens + silver);
        }
        col += uCloudColor * uAmbient;
        gl_FragColor = vec4(col * dens * uOpacity, dens * uOpacity);
        ${LOGDEPTH_F}
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Physically based sky/limb glow: additive single scattering on a shell around the planet. */
export function makeAtmosphereMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { ...sunUniforms(), ...atmoUniforms(), uIntensity: { value: 1 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vWorld;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      const float PI = 3.14159265358979;
      ${SCATTER_GLSL}
      uniform vec3 uPlanetCenter;
      uniform float uIntensity;
      varying vec3 vWorld;
      void main(){
        vec3 rd = normalize(vWorld);
        vec3 ro = -uPlanetCenter;
        vec2 tg = raySphere(ro, rd, uGroundR);
        float tMax = tg.x > 0.0 ? tg.x : 1e30;
        vec3 trans;
        vec3 col = atmosphere(ro, rd, tMax, trans) * uIntensity;
        gl_FragColor = vec4(col, 1.0);
        ${LOGDEPTH_F}
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/**
 * Volumetric clouds, ray-marched through a spherical shell. Used close to rocky planets
 * (coverage from the climate model) and inside gas giants (stacked cloud decks).
 */
export function makeVolumeCloudMaterial(noise3d: THREE.Data3DTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uNoise: { value: noise3d },
      uClimB: { value: null },
      uBands: { value: null },
      uGiant: { value: 0 },
      uBodyRot: { value: new THREE.Matrix3() },
      uShellIn: { value: 6.372e6 },
      uShellOut: { value: 6.382e6 },
      uScale: { value: 1 / 4000 },
      uDensity: { value: 0.02 },
      uTime: { value: 0 },
      uCloudColor: { value: v3(1, 1, 1) },
      uDeepColor: { value: v3(0.2, 0.15, 0.1) },
      uAmbient: { value: v3() },
      uOpacity: { value: 1 },
      ...sunUniforms(),
      ...atmoUniforms(),
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vWorld;
      void main(){
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      ${LOGDEPTH_PARS_F}
      ${EQUIRECT_GLSL}
      ${SCATTER_GLSL}
      uniform vec3 uPlanetCenter;
      uniform sampler3D uNoise;
      uniform sampler2D uClimB, uBands;
      uniform int uGiant;
      uniform mat3 uBodyRot; // render → body frame
      uniform float uShellIn, uShellOut, uScale, uDensity, uTime, uOpacity;
      uniform vec3 uCloudColor, uDeepColor, uAmbient;
      varying vec3 vWorld;
      float density(vec3 pc){
        float r = length(pc);
        float h = (r - uShellIn) / (uShellOut - uShellIn);
        if (h < 0.0 || h > 1.0) return 0.0;
        vec3 db = uBodyRot * (pc / r);
        vec3 q = pc * uScale + vec3(uTime * 0.002, 0.0, uTime * 0.001);
        float n = texture(uNoise, q).r * 0.62 + texture(uNoise, q * 3.1).r * 0.28 + texture(uNoise, q * 9.7).r * 0.1;
        if (uGiant == 1) {
          // Three decks — ammonia ice (~0.6 bar), ammonium hydrosulfide (~2 bar) and water
          // (~6 bar). The upper deck is broken, with convective towers punching up through it;
          // zones (bright bands) are cloudier than belts.
          float band = textureLod(uBands, vec2(0.5, 0.5 - asin(clamp(db.z, -1.0, 1.0)) / PI), 0.0).a;
          float tower = smoothstep(0.5, 0.75, texture(uNoise, q * 0.3 + 3.7).r);
          float top = 0.83 + 0.07 * tower;
          float deck = 0.0;
          deck += smoothstep(0.06 + 0.1 * tower, 0.0, abs(h - top));
          deck += smoothstep(0.09, 0.0, abs(h - 0.55)) * 0.85;
          deck += smoothstep(0.12, 0.0, abs(h - 0.29));
          float cov = 0.35 + 0.35 * band + 0.25 * tower;
          return deck * smoothstep(1.0 - cov, 1.0 - cov + 0.2, n);
        }
        float cov = sampleEqLod0(uClimB, db).r;
        float prof = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.35 + 0.6 * cov, 0.95, h));
        return prof * smoothstep(1.0 - cov, 1.0 - cov + 0.3, n);
      }
      void main(){
        vec3 rd = normalize(vWorld);
        vec3 ro = -uPlanetCenter;
        float rc = length(ro);
        vec2 to = raySphere(ro, rd, uShellOut);
        if (to.y < 0.0 || to.x > to.y) discard;
        float t0 = max(to.x, 0.0);
        float t1 = to.y;
        vec2 ti = raySphere(ro, rd, uShellIn);
        bool floorHit = false;
        if (rc < uShellIn) {
          // Below the cloud base: the clouds start where the ray leaves the inner sphere.
          if (ti.y < 0.0) discard;
          t0 = max(t0, ti.y);
        } else if (ti.x > 0.0 && ti.x < t1) {
          // Looking down into the layer: stop at the cloud base / deep interior.
          t1 = ti.x;
          floorHit = true;
        }
        // The solid planet (rocky worlds) hides everything behind it.
        if (uGiant == 0) {
          vec2 tg = raySphere(ro, rd, uGroundR);
          if (tg.x > 0.0) t1 = min(t1, tg.x);
        }
        t1 = min(t1, t0 + (uShellOut - uShellIn) * 16.0);
        if (t1 <= t0) discard;
        const int STEPS = 44;
        float L = t1 - t0;
        // Interleaved-gradient jitter (mild) hides step banding without coarse grain.
        float jitter = 0.5 + 0.5 * (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5);
        // Atmospheric reddening of sunlight, evaluated once near the start of the path.
        vec3 sunRad[2];
        for (int s = 0; s < 2; s++) {
          if (s >= uNumSuns) { sunRad[s] = vec3(0.0); continue; }
          vec2 odA = lightDepth(ro + rd * (t0 + 0.25 * L), uSunDir[s]);
          sunRad[s] = uSunRadiance[s] * exp(-(uBetaR * odA.x + uBetaM * odA.y));
        }
        vec3 acc = vec3(0.0);
        float T = 1.0;
        float ls = (uShellOut - uShellIn) * 0.1;
        for (int i = 0; i < STEPS; i++) {
          // Quadratic step distribution: fine detail close to the camera, coarse far away.
          float a0 = float(i) / float(STEPS), a1 = float(i + 1) / float(STEPS);
          float am = (float(i) + jitter) / float(STEPS);
          float ds = (a1 * a1 - a0 * a0) * L;
          vec3 p = ro + rd * (t0 + am * am * L);
          float dn = density(p);
          if (dn > 0.001) {
            float ext = dn * uDensity;
            vec3 Lsum = vec3(0.0);
            for (int s = 0; s < 2; s++) {
              if (s >= uNumSuns) break;
              vec3 Ld = uSunDir[s];
              float od = 0.0;
              for (int k = 1; k <= 3; k++) od += density(p + Ld * ls * float(k)) * uDensity * ls;
              float mu = dot(rd, Ld);
              float phase = 0.6 * phaseM(mu, 0.6) * 4.0 * PI + 0.4;
              // Beer + powder-like multiple-scattering term; planet shadow via the light path.
              float lit = smoothstep(-0.08, 0.06, dot(normalize(p), Ld));
              Lsum += sunRad[s] * lit * (exp(-od) + 0.3 * exp(-od * 0.25)) * phase;
            }
            float depthDark = uGiant == 1 ? mix(0.12, 1.0, smoothstep(0.0, 0.85, (length(p) - uShellIn) / (uShellOut - uShellIn))) : 1.0;
            vec3 cc = uCloudColor;
            if (uGiant == 1) {
              vec3 db = uBodyRot * normalize(p);
              cc = textureLod(uBands, vec2(0.5, 0.5 - asin(clamp(db.z, -1.0, 1.0)) / PI), 0.0).rgb * 1.08;
            }
            vec3 c = (Lsum + uAmbient) * cc * depthDark;
            float a = 1.0 - exp(-ext * ds);
            acc += T * a * c;
            T *= 1.0 - a;
            if (T < 0.02) break;
          }
        }
        if (uGiant == 1 && floorHit && T > 0.0) {
          // The deep, dimly lit interior below the lowest deck.
          vec3 Lsum = vec3(0.0);
          for (int s = 0; s < 2; s++) {
            if (s >= uNumSuns) break;
            Lsum += sunRad[s] * max(dot(normalize(ro + rd * t1), uSunDir[s]), 0.0);
          }
          acc += T * (Lsum + uAmbient) * uDeepColor * 0.15;
          T = 0.0;
        }
        float alpha = (1.0 - T) * uOpacity;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(acc * uOpacity, alpha);
        ${LOGDEPTH_F}
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Banded gas-giant cloud tops (seen from outside). */
export function makeGiantMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBands: { value: null },
      uThermal: { value: null },
      uTime: { value: 0 },
      uVort: { value: new Array(8).fill(0).map(() => new THREE.Vector4()) },
      uVortCol: { value: new Array(8).fill(0).map(() => new THREE.Vector4()) },
      uNumVort: { value: 0 },
      uTurb: { value: 1 },
      uGlow: { value: 0 },
      uRingIn: { value: 0 },
      uRingOut: { value: 0 },
      uRingTex: { value: null },
      uRingNormal: { value: v3(0, 1, 0) },
      uAmbient: { value: v3() },
      uExposure: { value: 1 },
      uLayer: { value: 0 },
      ...sunUniforms(),
      ...atmoUniforms(),
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vDir = normalize(position);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      ${EQUIRECT_GLSL}
      ${NOISE_GLSL}
      ${SCATTER_GLSL}
      ${COLORMAP_GLSL}
      uniform vec3 uPlanetCenter;
      ${SHADE_GLSL}
      uniform sampler2D uBands, uThermal, uRingTex;
      uniform float uTime, uTurb, uGlow, uRingIn, uRingOut, uExposure;
      uniform int uLayer;
      uniform vec4 uVort[8]; // xyz dir (body), w size (rad)
      uniform vec4 uVortCol[8]; // rgb, a = sense
      uniform int uNumVort;
      uniform vec3 uRingNormal, uAmbient;
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vec3 d = normalize(vDir);
        float lat = asin(clamp(d.z, -1.0, 1.0));
        float lon = atan(d.y, d.x);
        // Turbulent band boundaries: warp latitude with flow-sheared noise.
        float ph = fract(uTime * 0.02);
        vec3 q = vec3(cos(lon) * 2.0, sin(lon) * 2.0, lat * 14.0);
        float w1 = fbm3(q * vec3(1.0, 1.0, 0.7) + vec3(0.0, 0.0, ph), 5);
        float w2 = fbm3(q * vec3(3.0, 3.0, 2.0) + vec3(5.0, 1.0, -ph), 4);
        float latW = lat + (w1 * 0.035 + w2 * 0.012) * uTurb;
        // Vortices: swirl the sampling direction and paint ovals.
        vec3 vortCol = vec3(0.0);
        float vortA = 0.0;
        for (int i = 0; i < 8; i++) {
          if (i >= uNumVort) break;
          vec3 c = uVort[i].xyz;
          float R = uVort[i].w;
          float ang = acos(clamp(dot(d, c), -1.0, 1.0));
          if (ang > R * 2.5) continue;
          vec3 e1 = normalize(cross(vec3(0.0, 0.0, 1.0), c) + 1e-5);
          vec3 e2 = cross(c, e1);
          vec2 pl = vec2(dot(d, e1), dot(d, e2)) / R;
          pl.x *= 0.62;
          float r = length(pl);
          float sw = (1.0 - smoothstep(0.0, 1.6, r)) * 2.2 * uVortCol[i].a;
          latW += sin(sw + atan(pl.y, pl.x)) * 0.01 * exp(-r * r);
          float a = (1.0 - smoothstep(0.75, 1.05, r)) * (0.75 + 0.25 * snoise(vec3(pl * 6.0, uTime * 0.1)));
          vortCol += uVortCol[i].rgb * a;
          vortA = max(vortA, a);
        }
        vec2 uv = vec2(0.5, 0.5 - latW / PI);
        vec4 band = texture2D(uBands, uv);
        vec3 albedo = band.rgb * (0.9 + 0.2 * w2);
        albedo = mix(albedo, vortCol / max(vortA, 1e-3), vortA);
        if (uLayer > 0) {
          float T = sampleEq(uThermal, d).r;
          albedo = turbo((T - 50.0) / 1500.0) * 0.8;
        }
        vec3 N = normalize(vNrm);
        vec3 V = normalize(vWorld);
        vec3 col = vec3(0.0);
        for (int s = 0; s < 2; s++) {
          if (s >= uNumSuns) break;
          vec3 L = uSunDir[s];
          float ndl = max(dot(N, L), 0.0);
          // Ring shadow.
          float shadow = 1.0;
          if (uRingOut > 0.0) {
            vec3 pc = vWorld - uPlanetCenter;
            float denom = dot(L, uRingNormal);
            if (abs(denom) > 1e-4) {
              float t = -dot(pc, uRingNormal) / denom;
              if (t > 0.0) {
                float rr = length(pc + L * t);
                if (rr > uRingIn && rr < uRingOut) shadow = 1.0 - 0.85 * texture2D(uRingTex, vec2((rr - uRingIn) / (uRingOut - uRingIn), 0.5)).a;
              }
            }
          }
          // Limb darkening from the hazy upper atmosphere.
          float mu = max(dot(N, -V), 0.0);
          col += albedo * uSunRadiance[s] * ndl * shadow * (0.55 + 0.45 * pow(mu, 0.35));
        }
        col += albedo * uAmbient;
        // Thermal glow of hot giants and brown dwarfs.
        if (uGlow > 0.0) {
          float T = sampleEq(uThermal, d).r;
          float mu = max(dot(N, -V), 0.0);
          col += glowColor(T) * 5.67e-8 * pow(T, 4.0) / 1361.0 * (0.6 + 0.4 * mu) * uExposure * uGlow;
        }
        gl_FragColor = vec4(col, 1.0);
        ${LOGDEPTH_F}
      }`,
  });
}

/** Saturn-like rings: radial density texture, lit both sides, planet shadow. */
export function makeRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRingTex: { value: null },
      uInner: { value: 1 },
      uOuter: { value: 2 },
      uPlanetR: { value: 1 },
      uAmbient: { value: v3() },
      ...sunUniforms(),
      uPlanetCenter: { value: v3() },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vWorld; varying vec2 vLocal;
      void main(){
        vLocal = position.xy;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      uniform sampler2D uRingTex;
      uniform float uInner, uOuter, uPlanetR;
      uniform vec3 uPlanetCenter, uAmbient;
      uniform int uNumSuns;
      uniform vec3 uSunDir[2];
      uniform vec3 uSunRadiance[2];
      varying vec3 vWorld; varying vec2 vLocal;
      void main(){
        float r = length(vLocal);
        float x = (r - uInner) / (uOuter - uInner);
        if (x < 0.0 || x > 1.0) discard;
        vec4 t = texture2D(uRingTex, vec2(x, 0.5));
        if (t.a < 0.01) discard;
        vec3 col = vec3(0.0);
        vec3 V = normalize(vWorld);
        for (int s = 0; s < 2; s++) {
          if (s >= uNumSuns) break;
          vec3 L = uSunDir[s];
          // Planet shadow on the rings.
          vec3 pc = vWorld - uPlanetCenter;
          float b = dot(pc, L);
          float c = dot(pc, pc) - uPlanetR * uPlanetR;
          float shadow = (b < 0.0 && b * b - c > 0.0) ? 0.04 : 1.0;
          float fwd = pow(max(dot(V, L), 0.0), 6.0);
          col += t.rgb * uSunRadiance[s] * shadow * (0.55 + 1.2 * fwd * (1.0 - t.a));
        }
        col += t.rgb * uAmbient;
        gl_FragColor = vec4(col * t.a, t.a);
        ${LOGDEPTH_F}
      }`,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

/** Star photosphere: granulation, limb darkening, spots; radiance is physical × exposure. */
export function makeStarMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: v3(1, 1, 1) },
      uRadiance: { value: 1 },
      uTime: { value: 0 },
      uCellScale: { value: 30 },
      uSpots: { value: 0.3 },
    },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vDir = normalize(position);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz; vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      ${NOISE_GLSL}
      uniform vec3 uColor; uniform float uRadiance, uTime, uCellScale, uSpots;
      varying vec3 vDir; varying vec3 vWorld; varying vec3 vNrm;
      void main(){
        vec3 d = normalize(vDir);
        float mu = max(dot(normalize(vNrm), -normalize(vWorld)), 0.0);
        float limb = 1.0 - 0.6 * (1.0 - mu) - 0.15 * (1.0 - mu) * (1.0 - mu);
        float g = fbm3(d * uCellScale + vec3(0.0, 0.0, uTime * 0.05), 4) * 0.5 + 0.5;
        float gran = 0.82 + 0.3 * g;
        float spot = smoothstep(0.62, 0.72, fbm3(d * 3.0 + uTime * 0.003, 4) * 0.5 + 0.5) * uSpots;
        float fac = 0.88 + 0.12 * (fbm3(d * 6.0 - uTime * 0.01, 3) * 0.5 + 0.5);
        vec3 col = uColor * uRadiance * limb * gran * fac * (1.0 - 0.75 * spot);
        gl_FragColor = vec4(min(col, vec3(3.0e4)), 1.0); // stay inside half-float range
        ${LOGDEPTH_F}
      }`,
  });
}

/** Camera-facing glow/corona sprite for stars and distant bright points. */
export function makeGlowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: v3(1, 1, 1) }, uIntensity: { value: 1 }, uCore: { value: 0.1 }, uRays: { value: 1 } },
    vertexShader: /* glsl */ `
      ${LOGDEPTH_PARS_V}
      varying vec2 vUv;
      void main(){
        vUv = uv * 2.0 - 1.0;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
        mv.xy += position.xy * scale;
        gl_Position = projectionMatrix * mv;
        ${LOGDEPTH_V}
      }`,
    fragmentShader: /* glsl */ `
      ${LOGDEPTH_PARS_F}
      uniform vec3 uColor; uniform float uIntensity, uCore, uRays;
      varying vec2 vUv;
      void main(){
        float r = length(vUv);
        if (r > 1.0) discard;
        float a = atan(vUv.y, vUv.x);
        float halo = exp(-r * 5.0) * 0.6 + exp(-r * r / (uCore * uCore)) + 0.04 / (r * 30.0 + 0.4);
        float rays = (pow(abs(cos(a * 3.0)), 60.0) + pow(abs(cos(a * 3.0 + 0.5)), 80.0)) * exp(-r * 4.0) * 0.25 * uRays;
        float v = (halo + rays) * (1.0 - smoothstep(0.85, 1.0, r));
        gl_FragColor = vec4(min(uColor * v * uIntensity, vec3(3.0e4)), 1.0);
        ${LOGDEPTH_F}
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

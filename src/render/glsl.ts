// Shared GLSL snippets.

export const NOISE_GLSL = /* glsl */ `
// 3D simplex noise (Ashima Arts, MIT).
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm3(vec3 p, int oct){
  float s=0.0, a=0.5, n=0.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; s+=a*snoise(p); n+=a; p=p*2.03+vec3(1.7,9.2,3.1); a*=0.5; }
  return s/n;
}
float ridged3(vec3 p, int oct){
  float s=0.0, a=0.5, n=0.0, prev=1.0;
  for(int i=0;i<8;i++){ if(i>=oct) break; float r=1.0-abs(snoise(p)); r*=r; s+=a*r*prev; prev=r; n+=a; p=p*2.1+vec3(3.1,1.3,7.7); a*=0.5; }
  return s/n;
}
`;

/** Equirectangular sampling with seam-free derivatives (Tarini's trick). */
export const EQUIRECT_GLSL = /* glsl */ `
const float PI = 3.14159265358979;
vec2 dirToUV(vec3 d){
  // Body-fixed frame: x = prime meridian, y = 90°E, z = north pole. Row 0 of textures = north.
  float lon = atan(d.y, d.x);
  float lat = asin(clamp(d.z, -1.0, 1.0));
  return vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI);
}
vec4 sampleEq(sampler2D t, vec3 d){
  vec2 uv = dirToUV(d);
  vec2 uv2 = vec2(fract(uv.x + 0.5) - 0.5, uv.y);
  vec2 dx1 = dFdx(uv), dy1 = dFdy(uv);
  vec2 dx2 = dFdx(uv2), dy2 = dFdy(uv2);
  bool useB = (abs(dx2.x) + abs(dy2.x)) < (abs(dx1.x) + abs(dy1.x)) - 1e-6;
  return useB ? textureGrad(t, vec2(uv2.x < 0.0 ? uv2.x + 1.0 : uv2.x, uv2.y), dx2, dy2) : textureGrad(t, uv, dx1, dy1);
}
vec4 sampleEqLod0(sampler2D t, vec3 d){ return textureLod(t, dirToUV(d), 0.0); }
`;

/**
 * Single-scattering atmosphere (Rayleigh + Mie) ray-marched along the view ray, with the
 * optical depth toward each star integrated in a few samples. Works from space and from
 * inside the atmosphere. All lengths in metres, centre-relative coordinates.
 */
export const SCATTER_GLSL = /* glsl */ `
uniform vec3 uBetaR;     // Rayleigh scattering at the surface (1/m)
uniform vec3 uBetaM;     // Mie/haze extinction at the surface (1/m)
uniform vec3 uMieAlbedo; // Mie single-scattering colour
uniform float uHr;       // Rayleigh scale height (m)
uniform float uHm;       // Mie scale height (m)
uniform float uMieG;
uniform float uAtmR;     // top of atmosphere radius (m)
uniform float uGroundR;  // ground radius (m)
uniform int uNumSuns;
uniform vec3 uSunDir[2];      // unit, from planet toward the star (world/render frame)
uniform vec3 uSunRadiance[2]; // pre-exposed radiance scale × colour

vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e30, -1e30);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float phaseR(float mu){ return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g){
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
// Optical depth (R, M) from point p to the top of the atmosphere along direction l.
vec2 lightDepth(vec3 p, vec3 l){
  vec2 t = raySphere(p, l, uAtmR);
  float len = max(t.y, 0.0);
  // Blocked by the planet?
  vec2 g = raySphere(p, l, uGroundR * 0.999);
  if (g.x > 0.0) return vec2(1e9);
  float ds = len / 6.0;
  vec2 od = vec2(0.0);
  for (int i = 0; i < 6; i++) {
    vec3 q = p + l * ((float(i) + 0.5) * ds);
    float h = length(q) - uGroundR;
    od += vec2(exp(-h / uHr), exp(-h / uHm)) * ds;
  }
  return od;
}
// Returns inscattered radiance; 'trans' gets the view-path transmittance.
vec3 atmosphere(vec3 ro, vec3 rd, float tMax, out vec3 trans){
  trans = vec3(1.0);
  vec2 ta = raySphere(ro, rd, uAtmR);
  if (ta.y < 0.0 || ta.x > tMax) return vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float t1 = min(ta.y, tMax);
  if (t1 <= t0) return vec3(0.0);
  const int STEPS = 14;
  float ds = (t1 - t0) / float(STEPS);
  vec2 odView = vec2(0.0);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  vec3 sumR2 = vec3(0.0), sumM2 = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float h = max(length(p) - uGroundR, 0.0);
    vec2 dens = vec2(exp(-h / uHr), exp(-h / uHm)) * ds;
    odView += dens;
    for (int s = 0; s < 2; s++) {
      if (s >= uNumSuns) break;
      vec2 odL = lightDepth(p, uSunDir[s]);
      vec3 tau = uBetaR * (odView.x + odL.x) + uBetaM * (odView.y + odL.y);
      vec3 att = exp(-tau);
      if (s == 0) { sumR += dens.x * att; sumM += dens.y * att; }
      else { sumR2 += dens.x * att; sumM2 += dens.y * att; }
    }
  }
  trans = exp(-(uBetaR * odView.x + uBetaM * odView.y));
  vec3 col = vec3(0.0);
  for (int s = 0; s < 2; s++) {
    if (s >= uNumSuns) break;
    float mu = dot(rd, uSunDir[s]);
    vec3 r = s == 0 ? sumR : sumR2;
    vec3 m = s == 0 ? sumM : sumM2;
    col += uSunRadiance[s] * (r * uBetaR * phaseR(mu) + m * uBetaM * uMieAlbedo * phaseM(mu, uMieG));
  }
  // Radiance relative to a sunlit white Lambertian surface (E/π). Single scattering misses
  // roughly a third to a half of real skylight; a constant factor stands in for higher orders.
  return col * PI * 1.6;
}
`;

/**
 * Threshold on a roughly normal noise value (mean mu, s.d. sd) that leaves a fraction `cover`
 * of samples above it, so drawn cloud cover matches the climate model's cloud fraction.
 */
export const COVER_GLSL = /* glsl */ `
float coverThreshold(float cover, float mu, float sd){
  float c = clamp(cover, 0.002, 0.998);
  float p = c < 0.5 ? c : 1.0 - c;
  float t = sqrt(-2.0 * log(p));
  float z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) / (1.0 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  return mu + sd * (c < 0.5 ? z : -z);
}
`;

export const COLORMAP_GLSL = /* glsl */ `
vec3 turbo(float x){
  x = clamp(x, 0.0, 1.0);
  const vec4 kr = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kg = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kb = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kr2 = vec2(-152.94239396, 59.28637943);
  const vec2 kg2 = vec2(4.27729857, 2.82956604);
  const vec2 kb2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kr) + dot(v2, kr2), dot(v4, kg) + dot(v2, kg2), dot(v4, kb) + dot(v2, kb2));
}
vec3 blueRed(float x){
  x = clamp(x, 0.0, 1.0);
  return x < 0.5 ? mix(vec3(0.05,0.2,0.65), vec3(0.95,0.95,0.95), x * 2.0) : mix(vec3(0.95,0.95,0.95), vec3(0.75,0.08,0.06), x * 2.0 - 1.0);
}
vec3 biomeColor(float v){
  int b = int(floor(v + 0.5));
  if (b == 0) return vec3(0.04, 0.12, 0.35);
  if (b == 1) return vec3(0.92, 0.95, 1.0);
  if (b == 2) return vec3(0.55, 0.55, 0.45);
  if (b == 3) return vec3(0.1, 0.28, 0.18);
  if (b == 4) return vec3(0.15, 0.45, 0.13);
  if (b == 5) return vec3(0.6, 0.68, 0.25);
  if (b == 6) return vec3(0.88, 0.76, 0.5);
  if (b == 7) return vec3(0.74, 0.62, 0.25);
  if (b == 8) return vec3(0.02, 0.3, 0.07);
  return vec3(0.45, 0.4, 0.37);
}
vec3 rain(float x){
  x = clamp(x, 0.0, 1.0);
  return mix(mix(vec3(0.85,0.75,0.55), vec3(0.3,0.75,0.35), smoothstep(0.0,0.4,x)), vec3(0.1,0.25,0.75), smoothstep(0.4,1.0,x));
}
`;

/** Logarithmic depth support for custom ShaderMaterials (matches three.js chunks). */
export const LOGDEPTH_PARS_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';
export const LOGDEPTH_V = '#include <logdepthbuf_vertex>';
export const LOGDEPTH_PARS_F = '#include <logdepthbuf_pars_fragment>';
export const LOGDEPTH_F = '#include <logdepthbuf_fragment>';

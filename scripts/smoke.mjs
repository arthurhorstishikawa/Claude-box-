// Headless smoke test: serves the app with Vite, opens it in Chromium (software WebGL via
// SwiftShader), drives the camera through key views and saves screenshots.
//
//   npm run smoke                  -> screenshots in ./smoke-out
//   npm run smoke -- --only=earth  -> only the shots whose name contains "earth"
//   npm run smoke -- --verbose     -> also print the page's console output
//
// Exits non-zero if the page throws, logs an error, or a WebGL shader fails to compile.
// Software rendering is slow (about 1 frame per second), so timings here say nothing about
// real GPU performance.
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run `npm i -D playwright && npx playwright install chromium` first.');
  process.exit(2);
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const outDir = resolve(args.out ?? 'smoke-out');
mkdirSync(outDir, { recursive: true });
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 760);

const server = await createServer({ logLevel: 'error', server: { port: 5199, strictPort: false, host: '127.0.0.1' } });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.setDefaultTimeout(240000);
const problems = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /THREE\.WebGLProgram|Shader Error|ERROR:/.test(t)) problems.push(`[console.${m.type()}] ${t}`);
  else if (args.verbose) console.log(`[console.${m.type()}] ${t}`);
});
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.stack ?? e.message}`));

const wait = (ms) => page.waitForTimeout(ms);

async function scenario(id) {
  await page.goto(`${url}?scenario=${id}`);
  await page.waitForFunction(() => window.aeolus && document.getElementById('loading')?.classList.contains('hidden'), null, { timeout: 120000 });
  await page.evaluate(() => {
    const a = window.aeolus;
    a.body = (n) => a.sim.bodies.find((b) => b.name === n);
    /** Sub-point of `s` on body `b` (body-fixed lat/lon). */
    a.subPoint = (b, s) => {
      const d = { x: s.pos.x - b.pos.x, y: s.pos.y - b.pos.y, z: s.pos.z - b.pos.z };
      const n = Math.hypot(d.x, d.y, d.z);
      const f = b.frame();
      const dot = (u) => (u.x * d.x + u.y * d.y + u.z * d.z) / n;
      return { lat: Math.asin(Math.max(-1, Math.min(1, dot(f.z)))), lon: Math.atan2(dot(f.y), dot(f.x)) };
    };
    /** Orbit camera around `b`, `phase` degrees away from the direction of `s` (0 = full phase). */
    a.orbitView = (b, s, phase, elev = 12, distR = null) => {
      const cam = a.renderer.cam;
      a.sim.setFocus(b.id);
      cam.focus(b, { instant: true, dist: distR ? b.radius * distR : undefined });
      const d = { x: s.pos.x - b.pos.x, y: s.pos.y - b.pos.y };
      const lon = Math.atan2(d.y, d.x) + (phase * Math.PI) / 180;
      // Physics (x, y, z) -> render (x, z, -y); az measured from render +z toward +x.
      const rx = Math.cos(lon),
        rz = -Math.sin(lon);
      cam.az = Math.atan2(rx, rz);
      cam.el = (elev * Math.PI) / 180;
      a.app.select(b.id);
    };
    /** Stand on body `b` at an angular offset from the sub-stellar point. */
    a.land = (b, s, dLat, dLon, alt, heading, pitch) => {
      const cam = a.renderer.cam;
      a.sim.speed = 1; // real time, so the landing site keeps its time of day
      a.sim.setFocus(b.id);
      cam.focus(b, { instant: true });
      const sp = a.subPoint(b, s);
      cam.mode = 'surface';
      cam.lat = sp.lat + dLat;
      cam.lon = sp.lon + dLon;
      cam.alt = alt;
      cam.heading = heading;
      cam.pitch = pitch;
      a.app.select(b.id);
    };
  });
  await wait(1500);
}

/** Wait (bounded) for the eye adaptation to settle. */
async function settle(maxMs = 20000) {
  const t0 = Date.now();
  await wait(1500);
  // Software rendering manages ~1 frame/s, so jump to the metered exposure a few times
  // instead of waiting for the (real-time) adaptation.
  const frames = () => page.evaluate(() => window.aeolus.renderer.eye.frame);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.aeolus.renderer.eye.snap());
    // Let the eye re-meter a couple of times (it measures every third frame).
    const f0 = await frames();
    const t1 = Date.now();
    while ((await frames()) < f0 + 7 && Date.now() - t1 < 15000) await wait(300);
  }
  while (Date.now() - t0 < maxMs) {
    const d = await page.evaluate(() => {
      const e = window.aeolus.renderer.eye;
      return window.aeolus.view.mode === 'realistic' ? Math.abs(Math.log(e.exposure / e.target)) : 0;
    });
    if (d < 0.2) break;
    await wait(700);
  }
  await wait(800);
}

function act(fn, arg) {
  return page.evaluate(([src, arg]) => new Function('a', 'arg', `return (${src})(a, arg);`)(window.aeolus, arg), [fn.toString(), arg]);
}

const shots = [
  { name: 'solar-overview', scenario: 'solar', run: () => act((a) => a.app.focusBody(a.body('Earth'))) },
  { name: 'earth-orbit-realistic', run: () => act((a) => { a.setView('mode', 'realistic'); a.sim.speed = 60; a.orbitView(a.body('Earth'), a.body('Sun'), 55, 15); }) },
  { name: 'earth-orbit-enhanced', run: () => act((a) => { a.setView('mode', 'enhanced'); a.orbitView(a.body('Earth'), a.body('Sun'), 55, 15); }) },
  { name: 'earth-night-enhanced', run: () => act((a) => { a.setView('mode', 'enhanced'); a.orbitView(a.body('Earth'), a.body('Sun'), 165, 10); }) },
  { name: 'earth-limb', run: () => act((a) => { a.setView('mode', 'realistic'); a.orbitView(a.body('Earth'), a.body('Sun'), 80, 4, 1.25); }) },
  { name: 'sun-close-realistic', run: () => act((a) => { a.setView('mode', 'realistic'); a.orbitView(a.body('Sun'), a.body('Earth'), 20, 10, 4); }) },
  { name: 'sun-close-enhanced', run: () => act((a) => { a.setView('mode', 'enhanced'); a.orbitView(a.body('Sun'), a.body('Earth'), 20, 10, 4); }) },
  { name: 'earth-landed-day', run: () => act((a) => { a.setView('mode', 'realistic'); a.sim.speed = 1; a.land(a.body('Earth'), a.body('Sun'), 0.3, -0.8, 900, 1.4, 0.22); }) },
  { name: 'earth-landed-evening', run: () => act((a) => { a.setView('mode', 'realistic'); a.land(a.body('Earth'), a.body('Sun'), 0.2, -1.47, 1800, -1.57, 0.06); }) },
  { name: 'earth-landed-night', run: () => act((a) => { a.setView('mode', 'realistic'); a.land(a.body('Earth'), a.body('Sun'), 0.1, Math.PI, 2500, 0.3, 0.6); }) },
  { name: 'mars-landed', run: () => act((a) => { a.setView('mode', 'realistic'); a.land(a.body('Mars'), a.body('Sun'), 0.25, -0.7, 800, 1.2, 0.04); }) },
  { name: 'jupiter-orbit', run: () => act((a) => { a.setView('mode', 'realistic'); a.orbitView(a.body('Jupiter'), a.body('Sun'), 40, 8); }) },
  { name: 'jupiter-dive-top', run: () => act((a) => a.land(a.body('Jupiter'), a.body('Sun'), 0.15, -0.5, 60e3, 1.6, -0.1)) },
  { name: 'jupiter-dive-deep', run: () => act((a) => a.land(a.body('Jupiter'), a.body('Sun'), 0.15, -0.5, -20e3, 1.6, 0.05)) },
  { name: 'saturn-black-bg', run: () => act((a) => { a.setView('background', 'black'); a.orbitView(a.body('Saturn'), a.body('Sun'), 35, 22); }) },
  { name: 'earth-map', run: () => act((a) => { a.setView('background', 'milkyway'); a.orbitView(a.body('Earth'), a.body('Sun'), 30, 10); a.app.mapPanel.classList.remove('hidden'); }) },
  { name: 'earth-city-lights', run: () => act((a) => { a.app.mapPanel.classList.add('hidden'); a.setView('mode', 'realistic'); a.setView('orbits', false); a.orbitView(a.body('Earth'), a.body('Sun'), 175, 20, 1.45); }) },
  { name: 'earth-city-lights-enhanced', run: () => act((a) => { a.setView('mode', 'enhanced'); a.setView('orbits', false); a.orbitView(a.body('Earth'), a.body('Sun'), 150, 25, 2.2); }) },
  { name: 'ember-hearth', scenario: 'ember', run: () => act((a) => { a.setView('mode', 'realistic'); a.setView('orbits', true); a.orbitView(a.body('Hearth'), a.body('Ember'), 50, 15); }) },
  { name: 'ember-hz', run: () => act((a) => { a.setView('hz', true); a.orbitView(a.body('Ember'), a.body('Hearth'), 0, 70, 260); a.setView('mode', 'enhanced'); }) },
];

// --only=a,b runs the shots whose names contain any of the terms (loading their scenarios).
const only = args.only ? String(args.only).split(',') : null;
let current = null;
let declared = 'solar';
for (const s of shots) {
  if (s.scenario) declared = s.scenario;
  if (only && !only.some((t) => s.name.includes(t))) continue;
  if (current !== declared) {
    await scenario(declared);
    current = declared;
  }
  const t0 = Date.now();
  await s.run();
  await settle();
  await page.screenshot({ path: `${outDir}/${s.name}.png`, timeout: 240000 });
  const eye = await page.evaluate(() => {
    const e = window.aeolus.renderer.eye;
    return `exposure ${e.exposure.toExponential(2)} (target ${e.target.toExponential(2)}, Lavg ${e.sceneLuminance.toExponential(2)}, Lhi ${e.highlight.toExponential(2)})`;
  });
  console.log(`${s.name.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s  ${eye}`);
}

await browser.close();
await server.close();
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, 40)) console.error(p.slice(0, 2000));
  process.exit(1);
}
console.log(`\nOK — screenshots in ${outDir}`);

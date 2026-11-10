import { AU, DAY, G, HOUR, KYR, L_SUN, M_EARTH, M_JUP, M_SUN, MINUTE, MYR, GYR, R_EARTH, YEAR } from '../core/constants';
import { clamp } from '../core/math';
import { V3 } from '../core/vec3';
import { displaySettings, fmtDate, fmtDistance, fmtDuration, fmtMass, fmtPct, fmtPpm, fmtPressure, fmtRadius, fmtRate, fmtTemp, sig } from '../core/format';
import type { Body } from '../physics/body';
import { kindLabel } from '../physics/classify';
import { orbitFromState, orbitPeriod } from '../physics/orbits';
import { habitableZone } from '../stars/habitableZone';
import { classifyBody } from '../physics/classify';
import { brownDwarf, msLifetime, PHASE_LABEL, phaseStartAges, spectralClass, whiteDwarf } from '../stars/stellar';
import { GASES, GAS_ORDER, type GasId } from '../climate/atmosphere';
import { GasGiantClimate } from '../climate/gasGiant';
import { BIOMES, LIFE_STAGES, TerrestrialClimate } from '../climate/terrestrial';
import { TERRAIN_STYLES, type TerrainStyle } from '../climate/terrain';
import { pigmentName, plantPigment } from '../climate/life';
import { ERA_LABEL } from '../climate/civilization';
import { stormCategory } from '../climate/storms';
import { makeGiant, makeRocky, makeSmallBody, makeStar, placeOnOrbit, refreshStar, setObliquity } from '../sim/factory';
import { SCENARIOS, findScenario, type Scenario } from '../sim/scenarios';
import { randomPlanet, STAR_PRESETS, systemScenario, tuneTemperate, type StarPreset, type SystemOptions } from '../sim/generator';
import { CHALLENGES, updateChallenge, type ChallengeState } from '../sim/challenges';
import { deleteSlot, listSlots, loadSim, loadSlot, saveSlot, serializeSim } from '../sim/save';
import type { Simulation } from '../sim/simulation';
import type { Renderer } from '../render/renderer';
import { LAYERS, setView, view, type LayerId } from '../render/viewSettings';
import { drawChart } from './charts';
import { clear, h, kv, section, slider } from './dom';
import { ClimateMap } from './map';

const SPEEDS = [1, 10, MINUTE, 10 * MINUTE, HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY, YEAR, 10 * YEAR, 100 * YEAR, KYR, 10 * KYR, 100 * KYR, MYR, 10 * MYR, 100 * MYR, GYR];

interface Template {
  id: string;
  label: string;
  group: 'Stars' | 'Planets' | 'Moons & small bodies';
  color: string;
  make: () => Body;
}

let seedCounter = Math.floor(Math.random() * 1e6);
const seed = () => ++seedCounter;

const TEMPLATES: Template[] = [
  { id: 'O', label: 'O-type giant', group: 'Stars', color: '#9bb0ff', make: () => makeStar({ name: 'O star', mass: 25, age: 2e6 }) },
  { id: 'B', label: 'B star', group: 'Stars', color: '#aabfff', make: () => makeStar({ name: 'B star', mass: 6, age: 3e7 }) },
  { id: 'A', label: 'A star', group: 'Stars', color: '#cad7ff', make: () => makeStar({ name: 'A star', mass: 2, age: 3e8 }) },
  { id: 'F', label: 'F star', group: 'Stars', color: '#f8f7ff', make: () => makeStar({ name: 'F star', mass: 1.3, age: 1.5e9 }) },
  { id: 'G', label: 'Sun-like G', group: 'Stars', color: '#fff4ea', make: () => makeStar({ name: 'G star', mass: 1, age: 4.6e9 }) },
  { id: 'K', label: 'K dwarf', group: 'Stars', color: '#ffd2a1', make: () => makeStar({ name: 'K dwarf', mass: 0.75, age: 5e9 }) },
  { id: 'M', label: 'M dwarf', group: 'Stars', color: '#ffad69', make: () => makeStar({ name: 'M dwarf', mass: 0.2, age: 5e9 }) },
  { id: 'RG', label: 'Red giant', group: 'Stars', color: '#ff8a50', make: () => makeStar({ name: 'Red giant', mass: 1.2, age: msLifetime(1.2) * 1.135 }) },
  { id: 'WD', label: 'White dwarf', group: 'Stars', color: '#dfe8ff', make: () => makeStar({ name: 'White dwarf', mass: 0.6, age: 1e8, remnant: 'WD' }) },
  { id: 'NS', label: 'Neutron star', group: 'Stars', color: '#aaccff', make: () => makeStar({ name: 'Pulsar', mass: 1.4, age: 1e4, remnant: 'NS' }) },
  { id: 'BH', label: 'Black hole', group: 'Stars', color: '#333', make: () => makeStar({ name: 'Black hole', mass: 10, age: 1e6, remnant: 'BH' }) },
  { id: 'BD', label: 'Brown dwarf', group: 'Stars', color: '#a0522d', make: () => makeStar({ name: 'Brown dwarf', mass: 0.04, age: 1e9 }) },
  { id: 'earth', label: 'Earth-like', group: 'Planets', color: '#4f86c6', make: () => makeRocky({ name: 'Terra', mass: M_EARTH, rotationHours: 24, atmosphere: { N2: 78000, O2: 21000, Ar: 900, CO2: 40 }, waterGEL: 2600, biosphere: true, terrain: 'earthlike', seed: seed(), initialTemp: 285, iceCapLat: 70, color: '#4f86c6' }) },
  { id: 'ocean', label: 'Ocean world', group: 'Planets', color: '#2f6fb3', make: () => makeRocky({ name: 'Thalassa', mass: 1.3 * M_EARTH, rotationHours: 20, atmosphere: { N2: 90000, CO2: 300 }, waterGEL: 6000, terrain: 'oceanic', seed: seed(), initialTemp: 280, color: '#2f6fb3' }) },
  { id: 'desert', label: 'Desert world', group: 'Planets', color: '#d9b06a', make: () => makeRocky({ name: 'Arrakis', mass: 0.9 * M_EARTH, rotationHours: 22, atmosphere: { N2: 70000, O2: 15000, CO2: 400 }, waterGEL: 80, terrain: 'continental', seed: seed(), initialTemp: 295, color: '#d9b06a' }) },
  { id: 'super', label: 'Super-Earth', group: 'Planets', color: '#6a8fa8', make: () => makeRocky({ name: 'Super-Earth', mass: 5 * M_EARTH, rotationHours: 30, atmosphere: { N2: 3e5, CO2: 2e3 }, waterGEL: 3000, terrain: 'earthlike', seed: seed(), initialTemp: 290, color: '#6a8fa8' }) },
  { id: 'mars', label: 'Mars-like', group: 'Planets', color: '#c1440e', make: () => makeRocky({ name: 'Rust', mass: 0.11 * M_EARTH, rotationHours: 24.6, atmosphere: { CO2: 600, N2: 20 }, waterGEL: 20, terrain: 'marslike', seed: seed(), dust: 0.3, initialTemp: 210, iceCapLat: 80, color: '#c1440e' }) },
  { id: 'venus', label: 'Venus-like', group: 'Planets', color: '#e8cf8f', make: () => makeRocky({ name: 'Hothouse', mass: 0.82 * M_EARTH, rotationHours: -2000, atmosphere: { CO2: 8.8e6, N2: 3e5, SO2: 1400 }, waterGEL: 0.02, terrain: 'venuslike', seed: seed(), initialTemp: 730, color: '#e8cf8f' }) },
  { id: 'ice', label: 'Ice world', group: 'Planets', color: '#cfe3f0', make: () => makeRocky({ name: 'Hoth', mass: 0.6 * M_EARTH, rotationHours: 18, atmosphere: { N2: 50000, CO2: 50 }, waterGEL: 1500, terrain: 'oceanic', seed: seed(), initialTemp: 220, iceCapLat: 0, color: '#cfe3f0' }) },
  { id: 'lava', label: 'Lava world', group: 'Planets', color: '#ff6a2a', make: () => makeRocky({ name: 'Vulcan', mass: 2 * M_EARTH, rotationHours: 30, atmosphere: { CO2: 1e4 }, terrain: 'lavaworld', seed: seed(), initialTemp: 1800, color: '#ff6a2a' }) },
  { id: 'deepocean', label: 'Deep-ocean world', group: 'Planets', color: '#1d4f8f', make: () => makeRocky({ name: 'Abyss', mass: 2 * M_EARTH, composition: { iron: 0.15, rock: 0.35, ice: 0.5, gas: 0 }, rotationHours: 22, atmosphere: { N2: 1.5e5, CO2: 3000 }, waterGEL: 150000, terrain: 'oceanic', seed: seed(), initialTemp: 285, color: '#1d4f8f' }) },
  { id: 'carbon', label: 'Carbon world', group: 'Planets', color: '#3a3430', make: () => makeRocky({ name: 'Graphite', mass: 1.4 * M_EARTH, rotationHours: 30, atmosphere: { CO2: 4e4, CH4: 2000, N2: 3e4 }, waterGEL: 0, terrain: 'venuslike', seed: seed(), haze: 0.6, initialTemp: 330, color: '#3a3430' }) },
  { id: 'gas', label: 'Gas giant', group: 'Planets', color: '#d9b98c', make: () => makeGiant({ name: 'Gas giant', mass: M_JUP, rotationHours: 10, seed: seed() }) },
  { id: 'icegiant', label: 'Ice giant', group: 'Planets', color: '#8fc3e0', make: () => makeGiant({ name: 'Ice giant', mass: 17 * M_EARTH, rotationHours: 16, seed: seed(), ice: true }) },
  { id: 'ringed', label: 'Ringed giant', group: 'Planets', color: '#e2c48f', make: () => makeGiant({ name: 'Ringed giant', mass: 0.3 * M_JUP, rotationHours: 10.5, seed: seed(), rings: { inner: 7.4e7, outer: 1.35e8, opacity: 0.85 } }) },
  { id: 'moon', label: 'Rocky moon', group: 'Moons & small bodies', color: '#b8b5ae', make: () => makeRocky({ name: 'Moon', mass: 7e22, rotationHours: 600, terrain: 'moonlike', seed: seed(), initialTemp: 250, tidallyLocked: true, color: '#b8b5ae' }) },
  { id: 'icymoon', label: 'Icy moon', group: 'Moons & small bodies', color: '#d9d2c0', make: () => makeRocky({ name: 'Icy moon', mass: 5e22, composition: { iron: 0.1, rock: 0.45, ice: 0.45, gas: 0 }, rotationHours: 80, terrain: 'europalike', seed: seed(), waterGEL: 60e3, initialTemp: 100, tidallyLocked: true, color: '#d9d2c0' }) },
  { id: 'asteroid', label: 'Asteroid 10 km', group: 'Moons & small bodies', color: '#8d8478', make: () => makeSmallBody('Asteroid', 1.4e15, 5e3, false, seed()) },
  { id: 'comet', label: 'Comet 5 km', group: 'Moons & small bodies', color: '#cfe3f0', make: () => makeSmallBody('Comet', 1.5e14, 2.5e3, true, seed()) },
  { id: 'killer', label: 'Planet-killer 500 km', group: 'Moons & small bodies', color: '#8d8478', make: () => makeRocky({ name: 'Planetoid', mass: 1.5e21, rotationHours: 8, terrain: 'asteroid', seed: seed(), initialTemp: 200, color: '#8d8478' }) },
];

type Tab = 'overview' | 'climate' | 'atmosphere' | 'life' | 'edit' | 'star';

export class App {
  private sim: Simulation;
  private r: Renderer;
  private root: HTMLElement;
  selectedId: number | null = null;
  private tab: Tab = 'overview';
  private armed: Template | null = null;
  private impactor: { size: number; icy: boolean } | null = null;
  private inspector!: HTMLElement;
  private inspBody!: HTMLElement;
  private inspHead!: HTMLElement;
  private tabsEl!: HTMLElement;
  private dateEl!: HTMLElement;
  private speedEl!: HTMLElement;
  private speedSlider!: HTMLInputElement;
  private playBtn!: HTMLButtonElement;
  private badgesEl!: HTMLElement;
  private toastsEl!: HTMLElement;
  private mapPanel!: HTMLElement;
  private map = new ClimateMap();
  private mapInfo!: HTMLElement;
  private stationChart!: HTMLCanvasElement;
  private hintEl!: HTMLElement;
  private challengeEl!: HTMLElement;
  private flightEl!: HTMLElement;
  private challenge: ChallengeState | null = null;
  private refreshClock = 0;
  private mapClock = 0;
  private liveRefresh: (() => void) | null = null;
  private lastSelected: number | null = -1;
  private lastTab: Tab | null = null;

  constructor(root: HTMLElement, sim: Simulation, renderer: Renderer) {
    this.root = root;
    this.sim = sim;
    this.r = renderer;
    this.build();
    this.bindInput();
    sim.events.on('notify', (n) => this.toast(n.msg, n.level, n.bodyId));
    sim.events.on('bodyRemoved', (b) => {
      if (this.selectedId === b.id) this.select(sim.focusId);
    });
    sim.events.on('reset', () => {
      this.selectedId = sim.focusId;
      this.lastSelected = -1;
      this.map.station = null;
    });
  }

  // ------------------------------------------------------------------ layout

  private build(): void {
    const r = this.root;
    // Top bar.
    r.appendChild(
      h(
        'div',
        { class: 'topbar panel' },
        h('div', { class: 'brand' }, 'AEOLUS', h('small', null, 'climate sandbox')),
        h('button', { onclick: () => this.scenarioModal() }, 'Scenarios'),
        h('button', { class: 'primary', onclick: () => this.systemBuilderModal(), title: 'Generate your own star system' }, '✨ Create'),
        h('button', { onclick: () => this.challengeModal() }, 'Challenges'),
        h('button', { onclick: () => this.saveModal() }, 'Save / Load'),
        h('button', { onclick: () => this.settingsModal() }, 'Settings'),
        h('button', { onclick: () => this.helpModal() }, '?'),
      ),
    );
    // Toolbox.
    const tb = h('div', { class: 'toolbox panel' });
    for (const group of ['Stars', 'Planets', 'Moons & small bodies'] as const) {
      tb.appendChild(h('h3', null, group));
      const cards = h('div', { class: 'cards' });
      if (group === 'Planets') {
        const d = h('div', { class: 'card wide', title: 'Set mass, orbit, air, water, terrain and life, then add it' }, h('span', { class: 'dot', style: 'background:conic-gradient(#4f86c6,#d9b06a,#c1440e,#8fc3e0,#4f86c6)' }), '✎ Design a planet…');
        d.addEventListener('click', () => this.planetDesignerModal());
        for (const [kind, label, bg] of [
          ['rocky', '🎲 Random rocky', '#9a7b5a'],
          ['gas', '🎲 Random giant', '#d9b98c'],
        ] as const) {
          const r = h('div', { class: 'card', title: `Generate a random ${kind === 'gas' ? 'gas or ice giant' : 'rocky planet'} on a stable orbit around the current star` }, h('span', { class: 'dot', style: `background:${bg}` }), label);
          r.addEventListener('click', () => this.addRandomPlanet(kind));
          cards.appendChild(r);
        }
        cards.appendChild(d);
      }
      for (const t of TEMPLATES.filter((x) => x.group === group)) {
        const card = h('div', { class: 'card', title: `Click, then click in space to place a ${t.label}` }, h('span', { class: 'dot', style: `background:${t.color}` }), t.label);
        card.addEventListener('click', () => this.arm(t, card));
        cards.appendChild(card);
      }
      tb.appendChild(cards);
    }
    tb.appendChild(h('h3', null, 'Impacts'));
    const imp = h('div', { class: 'cards' });
    for (const [label, size, icy] of [
      ['Asteroid 1 km', 500, false],
      ['Chicxulub 10 km', 5000, false],
      ['Giant 100 km', 50000, false],
      ['Mars-sized', 3.39e6, false],
      ['Ice comet 10 km', 5000, true],
      ['Ice comet 100 km', 50000, true],
    ] as [string, number, boolean][]) {
      const card = h('div', { class: 'card', title: icy ? 'Terraforming: an icy comet delivers water and CO₂ (arm, then click a planet)' : 'Arm, then click a planet to hit it' }, h('span', { class: 'dot', style: `background:${icy ? '#9fd8ff' : '#ff8a50'}` }), label);
      card.addEventListener('click', () => this.armImpactor(size, card, icy));
      imp.appendChild(card);
    }
    tb.appendChild(imp);
    this.hintEl = h('div', { class: 'hint hidden' });
    tb.appendChild(this.hintEl);
    r.appendChild(tb);
    // Inspector.
    this.inspHead = h('div', { class: 'insp-head' });
    this.tabsEl = h('div', { class: 'tabs' });
    this.inspBody = h('div', { class: 'insp-body' });
    this.inspector = h('div', { class: 'inspector panel' }, this.inspHead, this.tabsEl, this.inspBody);
    r.appendChild(this.inspector);
    // Time bar.
    this.playBtn = h('button', { class: 'primary', onclick: () => this.togglePause(), title: 'Pause / resume (Space)' }, '⏸') as HTMLButtonElement;
    this.speedSlider = h('input', { type: 'range', min: 0, max: SPEEDS.length - 1, step: 1, value: 6 }) as HTMLInputElement;
    this.speedSlider.addEventListener('input', () => {
      this.sim.speed = SPEEDS[+this.speedSlider.value];
      this.sim.paused = false;
    });
    this.dateEl = h('div', { class: 'date' });
    this.speedEl = h('div', { class: 'speed' });
    this.badgesEl = h('div', { class: 'badges' });
    r.appendChild(
      h(
        'div',
        { class: 'timebar panel' },
        this.playBtn,
        h('button', { onclick: () => this.stepSpeed(-1), title: 'Slower ( , )' }, '«'),
        this.speedSlider,
        h('button', { onclick: () => this.stepSpeed(1), title: 'Faster ( . )' }, '»'),
        this.speedEl,
        this.dateEl,
        this.badgesEl,
      ),
    );
    // View bar.
    const layerSel = h('select', { title: 'Data layer on planets and the map' }) as HTMLSelectElement;
    for (const l of LAYERS) layerSel.appendChild(h('option', { value: l.id }, l.label));
    layerSel.addEventListener('change', () => setView('layer', layerSel.value as LayerId));
    const toggle = (label: string, key: 'orbits' | 'labels' | 'hz' | 'wind' | 'clouds' | 'bloom', title: string) => {
      const b = h('button', { title }, label) as HTMLButtonElement;
      const sync = () => b.setAttribute('aria-pressed', String(view[key]));
      b.addEventListener('click', () => {
        setView(key, !view[key]);
        sync();
      });
      sync();
      return b;
    };
    const modeBtn = h('button', { title: 'Realistic: physical brightness with eye adaptation. Enhanced: everything visible.' }) as HTMLButtonElement;
    const syncMode = () => (modeBtn.textContent = view.mode === 'realistic' ? '👁 Realistic' : '✨ Enhanced');
    modeBtn.addEventListener('click', () => {
      setView('mode', view.mode === 'realistic' ? 'enhanced' : 'realistic');
      syncMode();
    });
    syncMode();
    const bgSel = h('select', { title: 'Background' }, h('option', { value: 'milkyway' }, 'Milky Way'), h('option', { value: 'stars' }, 'Stars only'), h('option', { value: 'black' }, 'Pure black')) as HTMLSelectElement;
    bgSel.addEventListener('change', () => setView('background', bgSel.value as any));
    r.appendChild(
      h(
        'div',
        { class: 'viewbar panel' },
        h('div', { class: 'row wrap' }, modeBtn, bgSel),
        h('div', { class: 'row wrap' }, toggle('Orbits', 'orbits', 'Orbit paths (O)'), toggle('Labels', 'labels', 'Names (N)'), toggle('HZ', 'hz', 'Habitable zones'), toggle('Wind', 'wind', 'Wind particles (W in orbit view)'), toggle('Clouds', 'clouds', 'Cloud layers'), toggle('Bloom', 'bloom', 'Glare/bloom')),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Layer'), layerSel, h('button', { onclick: () => this.mapPanel.classList.toggle('hidden'), title: 'Climate map (M)' }, '🗺 Map')),
      ),
    );
    // Map panel.
    this.mapInfo = h('div', { class: 'muted', style: 'font-size:12px' });
    this.stationChart = h('canvas', { class: 'chart', style: 'height:90px' }) as HTMLCanvasElement;
    this.map.onStation = () => this.toast('Weather station placed — readings are being logged.', 'info');
    this.mapPanel = h('div', { class: 'mappanel panel hidden' }, h('div', { class: 'row sp' }, h('b', null, 'Climate map'), h('button', { onclick: () => this.mapPanel.classList.add('hidden') }, '×')), this.map.canvas, this.mapInfo, this.stationChart);
    r.appendChild(this.mapPanel);
    // Toasts, challenge HUD, flight HUD.
    this.toastsEl = h('div', { class: 'toasts' });
    r.appendChild(this.toastsEl);
    this.challengeEl = h('div', { class: 'challenge panel hidden' });
    r.appendChild(this.challengeEl);
    this.flightEl = h('div', { class: 'flight panel hidden' });
    r.appendChild(this.flightEl);
  }

  loadScenario(sc: Scenario): void {
    this.sim.loadScenario(sc);
    this.selectedId = this.sim.focusId;
    const f = this.sim.focus();
    if (f) this.r.cam.focus(f, { instant: true });
    this.syncSpeedSlider();
    this.challenge = null;
    this.challengeEl.classList.add('hidden');
  }

  // ------------------------------------------------------------------ input

  private bindInput(): void {
    const canvas = this.r.renderer.domElement;
    let down: { x: number; y: number; moved: boolean; id: number } | null = null;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      this.launch = this.armed && pointers.size === 1 ? this.launchStart(e.clientX, e.clientY) : null;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.r.cam.zoom((pinch - d) * 4);
        pinch = d;
        if (down) down.moved = true;
        return;
      }
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) down.moved = true;
      if (down?.moved && this.launch) this.launchDrag(e.clientX, e.clientY);
      else if (down?.moved) this.r.cam.drag(dx, dy);
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (down && down.moved && this.launch && this.armed && down.id === e.pointerId) this.launchRelease(e.shiftKey);
      else if (down && !down.moved && down.id === e.pointerId) this.click(e.clientX, e.clientY, e.shiftKey);
      this.launch = null;
      this.r.setLaunchPreview(null);
      down = null;
      pinch = 0;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('dblclick', (e) => {
      const b = this.r.pick(e.clientX, e.clientY);
      if (b) this.focusBody(b);
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.r.cam.zoom(e.deltaY * (e.deltaMode === 1 ? 30 : 1));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const k = e.key.toLowerCase();
      this.r.cam.keys.add(k === ' ' ? ' ' : k);
      if (e.shiftKey) this.r.cam.keys.add('shift');
      if (this.r.cam.mode === 'surface' && ['w', 'a', 's', 'd', 'q', 'e', ' '].includes(k)) {
        e.preventDefault();
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        this.togglePause();
      } else if (k === '.') this.stepSpeed(1);
      else if (k === ',') this.stepSpeed(-1);
      else if (k === 'f' && this.selected()) this.focusBody(this.selected()!);
      else if (k === 'l') this.toggleLanding();
      else if (k === 'm') this.mapPanel.classList.toggle('hidden');
      else if (k === 'o') setView('orbits', !view.orbits);
      else if (k === 'n') setView('labels', !view.labels);
      else if (k === 'v') setView('mode', view.mode === 'realistic' ? 'enhanced' : 'realistic');
      else if (k === 'escape') this.disarm();
      else if (k === 'delete' || k === 'backspace') {
        const b = this.selected();
        if (b && b.id !== this.sim.focusId) this.sim.removeBody(b);
      } else if (k === 'h' || k === '?') this.helpModal();
    });
    window.addEventListener('keyup', (e) => {
      this.r.cam.keys.delete(e.key.toLowerCase());
      if (!e.shiftKey) this.r.cam.keys.delete('shift');
    });
  }

  // ------------------------------------------------------------------ drag to launch

  private launch: { p: V3; primary: Body | null; vel: V3 } | null = null;

  /** The body that dominates gravity at a point (for a new body of mass m). */
  private attractorAt(p: V3, m: number): Body | null {
    let best: Body | null = null,
      bestA = 0;
    for (const o of this.sim.bodies) {
      const a = o.mass / Math.max(o.pos.distTo(p), 1) ** 2;
      if (a > bestA && o.mass > m) {
        bestA = a;
        best = o;
      }
    }
    return best;
  }

  private launchStart(x: number, y: number): { p: V3; primary: Body | null; vel: V3 } | null {
    const focus = this.sim.focus();
    const p = this.r.planePoint(x, y, focus ? focus.pos : new V3());
    if (!p || !this.armed) return null;
    return { p, primary: this.attractorAt(p, 0), vel: new V3() };
  }

  /** Dragging sets the velocity: the arrow's length relative to the distance from the attractor. */
  private launchDrag(x: number, y: number): void {
    const L = this.launch;
    if (!L) return;
    const focus = this.sim.focus();
    const q = this.r.planePoint(x, y, focus ? focus.pos : new V3());
    if (!q) return;
    const d = V3.sub(q, L.p);
    const pr = L.primary;
    const r = pr ? L.p.distTo(pr.pos) : 1e11;
    const vc = pr ? Math.sqrt((G * pr.mass) / r) : 1e4;
    // An arrow as long as 40% of the distance to the attractor means circular-orbit speed.
    L.vel = d.clone().scale(vc / (0.4 * r));
    this.r.setLaunchPreview({ from: L.p, vel: L.vel, primary: pr });
    const v = L.vel.len();
    let fate = 'drifts freely';
    if (pr) {
      const o = orbitFromState(V3.sub(L.p, pr.pos), L.vel, G * pr.mass, 0);
      if (o.e >= 1) fate = `escapes ${pr.name}`;
      else if (o.a * (1 - o.e) < pr.radius) fate = `hits ${pr.name}`;
      else fate = `orbits ${pr.name}: e = ${o.e.toFixed(2)}, period ${fmtDuration(orbitPeriod(o))}`;
    }
    this.hintEl.textContent = `Launch at ${sig(v / 1e3, 3)} km/s (${sig(v / vc, 2)}× circular speed) — ${fate}. Release to place.`;
  }

  private launchRelease(keepArmed: boolean): void {
    const L = this.launch;
    if (!L || !this.armed) return;
    this.place(this.armed, 0, 0, keepArmed, L);
  }

  private click(x: number, y: number, keepArmed = false): void {
    if (this.impactor) {
      const target = this.r.pick(x, y);
      if (target && !target.isStarLike) this.launchImpactor(target, this.impactor.size, this.impactor.icy);
      return;
    }
    if (this.armed) {
      this.place(this.armed, x, y, keepArmed);
      return;
    }
    const b = this.r.pick(x, y);
    if (b) this.select(b.id);
  }

  private toggleLanding(): void {
    const cam = this.r.cam;
    const b = cam.target;
    if (!b || b.isStarLike) return;
    if (cam.mode === 'surface') {
      cam.exitSurface();
      cam.dist = b.radius * 3;
    } else {
      // Arrive ~2.5 km above the ground (for giants: above the cloud tops).
      const ground = cam.groundHeight ? cam.groundHeight(b, cam.lat, cam.lon) : 0;
      cam.enterSurface(Math.max(ground, 0) + 2500);
    }
  }

  // ------------------------------------------------------------------ tools

  private arm(t: Template, card: HTMLElement): void {
    if (this.armed === t) return this.disarm();
    this.disarm();
    this.armed = t;
    card.classList.add('active');
    this.r.renderer.domElement.classList.add('placing');
    this.hintEl.textContent = `Click in space to place a ${t.label} on a circular orbit — or drag to launch it with your own speed and direction (a preview shows where it will go). Esc to cancel.`;
    this.hintEl.classList.remove('hidden');
  }

  private armImpactor(size: number, card: HTMLElement, icy = false): void {
    if (this.impactor?.size === size && this.impactor.icy === icy) return this.disarm();
    this.disarm();
    this.impactor = { size, icy };
    card.classList.add('active');
    this.r.renderer.domElement.classList.add('placing');
    this.hintEl.textContent = 'Click a planet or moon to send the impactor at 20 km/s. Watch the crater, the fireball and the impact winter.';
    this.hintEl.classList.remove('hidden');
  }

  private disarm(): void {
    this.armed = null;
    this.impactor = null;
    this.root.querySelectorAll('.card.active').forEach((c) => c.classList.remove('active'));
    this.r.renderer.domElement.classList.remove('placing');
    this.hintEl.classList.add('hidden');
  }

  /**
   * Place a body from a template where the click ray meets the focus body's orbital plane.
   * A plain click puts it on a circular orbit around the strongest attractor there; a drag
   * (`launch`) gives it the velocity you drew. Shift keeps the tool armed.
   */
  private place(t: Template, x: number, y: number, keepArmed = false, launch: { p: V3; primary: Body | null; vel: V3 } | null = null): void {
    const focus = this.sim.focus();
    const p = launch ? launch.p : this.r.planePoint(x, y, focus ? focus.pos : new V3());
    if (!p) {
      this.toast('Click on the orbital plane (not toward the horizon).', 'warn');
      return;
    }
    const b = t.make();
    b.pos.copy(p);
    for (const o of this.sim.bodies)
      if (o.pos.distTo(p) < o.radius * 1.5) {
        this.toast('Too close to another body.', 'warn');
        return;
      }
    const best = this.attractorAt(p, b.mass);
    if (best) {
      const r = V3.sub(p, best.pos);
      if (launch) b.vel.copy(best.vel).add(launch.vel);
      else {
        const speed = Math.sqrt((G * (best.mass + b.mass)) / r.len());
        b.vel.copy(best.vel).addScaled(new V3(0, 0, 1).cross(r).normalize(), speed);
      }
      if (b.tidallyLocked) b.setSpinAxis(new V3(0, 0, 1));
      else b.setSpinAxis(V3.rotate(new V3(0, 0, 1), new V3(1, 0, 0), (Math.random() * 30 * Math.PI) / 180));
    } else if (launch) b.vel.copy(launch.vel);
    let n = 1;
    const base = b.name;
    while (this.sim.bodies.some((o) => o.name === b.name)) b.name = `${base} ${++n}`;
    this.sim.addBody(b);
    this.select(b.id);
    this.toast(`${b.name} ${launch ? 'launched' : 'added'}${best ? (launch ? ` near ${best.name}` : ` orbiting ${best.name}`) : ''}.`, 'success', b.id);
    if (!keepArmed) this.disarm();
  }

  private launchImpactor(target: Body, radius: number, icy = false): void {
    const mass = (4 / 3) * Math.PI * radius ** 3 * (icy ? 900 : 2700);
    const imp = radius > 1e5 ? makeRocky({ name: 'Impactor', mass, radius, rotationHours: 10, terrain: 'asteroid', seed: seed(), initialTemp: 200 }) : makeSmallBody(`Impactor ${(radius * 2) / 1e3} km`, mass, radius, icy, seed());
    // Approach from a random direction on the camera-facing hemisphere.
    const toCam = V3.sub(this.r.cam.pos, target.pos).normalize();
    const side = V3.perpendicular(toCam);
    const dir = toCam.clone().addScaled(side, (Math.random() - 0.5) * 0.8).normalize();
    const start = target.radius * 2.5 + radius * 3;
    imp.pos.copy(target.pos).addScaled(dir, start);
    // Planet-sized impactors arrive off-centre: a glancing giant impact can form a moon.
    if (radius > 1e6) imp.pos.addScaled(side, 0.65 * (target.radius + radius));
    // Asteroids and comets arrive at 20 km/s; planet-sized bodies at just over escape speed.
    const vImp = radius > 1e6 ? 1.1 * Math.sqrt((2 * G * (target.mass + mass)) / (target.radius + radius)) : 2e4;
    imp.vel.copy(target.vel).addScaled(dir, -vImp);
    this.sim.addBody(imp);
    if (this.sim.speed > 600) this.sim.speed = 60;
    this.syncSpeedSlider();
    this.toast(`Impactor launched at ${target.name}: ${sig((2 * radius) / 1e3, 3)} km wide at 20 km/s.`, 'warn', target.id);
    this.disarm();
  }

  // ------------------------------------------------------------------ selection & focus

  selected(): Body | null {
    return this.sim.getBody(this.selectedId);
  }

  select(id: number | null): void {
    this.selectedId = id;
    this.r.selectedId = id;
  }

  focusBody(b: Body): void {
    this.sim.setFocus(b.id);
    this.r.cam.focus(b);
    this.select(b.id);
  }

  private togglePause(): void {
    this.sim.paused = !this.sim.paused;
  }

  private stepSpeed(dir: number): void {
    const i = clamp(+this.speedSlider.value + dir, 0, SPEEDS.length - 1);
    this.speedSlider.value = String(i);
    this.sim.speed = SPEEDS[i];
    this.sim.paused = false;
  }

  private syncSpeedSlider(): void {
    let best = 0;
    for (let i = 0; i < SPEEDS.length; i++) if (Math.abs(Math.log(SPEEDS[i] / this.sim.speed)) < Math.abs(Math.log(SPEEDS[best] / this.sim.speed))) best = i;
    this.speedSlider.value = String(best);
  }

  // ------------------------------------------------------------------ per-frame

  update(dt: number): void {
    const sim = this.sim;
    this.playBtn.textContent = sim.paused ? '▶' : '⏸';
    this.dateEl.textContent = fmtDate(sim.epochMs, sim.time);
    this.speedEl.innerHTML = '';
    this.speedEl.appendChild(document.createTextNode(sim.paused ? 'paused' : fmtRate(sim.speed)));
    if (!sim.paused && sim.limited) this.speedEl.appendChild(h('div', { class: 'muted', style: 'font-size:10px' }, `actual ${fmtRate(sim.actualSpeed)}`));
    const f = sim.focus();
    const tier = f?.climate instanceof TerrestrialClimate ? f.climate.mode : null;
    clear(this.badgesEl);
    this.badgesEl.appendChild(h('span', { class: 'badge', title: 'Gravity integrator' }, sim.mode === 'nbody' ? 'N-body' : 'Kepler'));
    if (tier) this.badgesEl.appendChild(h('span', { class: `badge ${tier === 'weather' ? 'good' : tier === 'simple' ? 'warn' : ''}`, title: 'Climate model tier for the focused world (faster time → simpler physics)' }, tier === 'weather' ? 'Weather' : tier === 'seasonal' ? 'Seasonal' : 'Simple climate'));
    this.badgesEl.appendChild(h('span', { class: 'badge muted' }, `${Math.round(this.r.fps)} fps`));
    // Inspector.
    if (this.selectedId === null || !this.selected()) this.selectedId = sim.focusId;
    if (this.selectedId !== this.lastSelected || this.tab !== this.lastTab) {
      this.renderInspector();
      this.lastSelected = this.selectedId;
      this.lastTab = this.tab;
    }
    this.refreshClock -= dt;
    if (this.refreshClock <= 0) {
      this.liveRefresh?.();
      this.refreshClock = 0.35;
    }
    // Map & station.
    this.mapClock -= dt;
    if (!this.mapPanel.classList.contains('hidden') && this.mapClock <= 0) {
      this.drawMap();
      this.mapClock = 0.33;
    }
    // Challenge.
    if (this.challenge) {
      updateChallenge(this.challenge, sim, sim.paused ? 0 : sim.actualSpeed * dt);
      this.renderChallenge();
    }
    // Flight altimeter.
    const cam = this.r.cam;
    if (cam.mode === 'surface' && cam.target) {
      this.flightEl.classList.remove('hidden');
      const t = cam.target;
      const ground = cam.groundHeight ? cam.groundHeight(t, cam.lat, cam.lon) : 0;
      let extra = '';
      if (t.climate instanceof GasGiantClimate) {
        const P = Math.exp(-cam.alt / 27e3);
        extra = ` · ~${sig(Math.max(P, 0.01), 2)} bar · ${fmtTemp(t.climate.stats.T1bar * Math.pow(Math.max(P, 0.05), 0.286))}`;
      } else if (t.climate instanceof TerrestrialClimate) {
        const c = t.climate;
        const T = c.grid.sample(c.Ts, cam.lat, cam.lon);
        extra = ` · ${fmtTemp(T)} · ${fmtPressure(c.P * Math.exp(-(cam.alt - ground) / 8000))}`;
      }
      this.flightEl.textContent = `${(cam.lat * 57.2958).toFixed(2)}°, ${(cam.lon * 57.2958).toFixed(2)}° · altitude ${fmtDistance(cam.alt - ground)}${extra} · WASD fly, Q/E down/up, Shift fast, L leave`;
    } else this.flightEl.classList.add('hidden');
  }

  private drawMap(): void {
    const f = this.sim.focus();
    const c = f?.climate instanceof TerrestrialClimate ? f.climate : null;
    if (!c || !f) {
      this.mapInfo.textContent = 'The map shows the focused rocky world. Focus a planet or moon (double-click).';
      return;
    }
    const il = this.sim.illuminators(f);
    const main = il.sort((a, b) => b.flux - a.flux)[0];
    const subLon = main ? Math.atan2(main.dir[1], main.dir[0]) : null;
    const subLat = main ? Math.asin(clamp(main.dir[2], -1, 1)) : 0;
    this.map.draw(c, view.layer, Number.isFinite(main?.synodic ?? 0) || !main ? subLon : subLon, subLat);
    this.map.sampleStation(this.sim.time);
    this.mapInfo.textContent = `${f.name} — ${LAYERS.find((l) => l.id === view.layer)?.label}. ${this.map.stationText()}`;
    const s = this.map.station;
    if (s && s.t.length > 1) drawChart(this.stationChart, s.t, [{ values: s.T.map((x) => x - 273.15), color: '#ff9f6b', label: 'T' }], { fmt: (v) => `${v.toFixed(0)}°`, xfmt: (t) => fmtDate(this.sim.epochMs, t) });
  }

  private recentToasts = new Map<string, number>();
  private toast(msg: string, level: string, bodyId?: number): void {
    // The same message within 15 s (e.g. a state flickering at extreme warp) is shown once.
    const now = performance.now();
    if ((this.recentToasts.get(msg) ?? -1e9) > now - 15000) return;
    this.recentToasts.set(msg, now);
    if (this.recentToasts.size > 200) for (const [k, t] of this.recentToasts) if (t < now - 15000) this.recentToasts.delete(k);
    const el = h('div', { class: `toast ${level}` }, msg);
    if (bodyId !== undefined) el.addEventListener('click', () => {
      const b = this.sim.getBody(bodyId);
      if (b) this.focusBody(b);
    });
    this.toastsEl.prepend(el);
    while (this.toastsEl.children.length > 5) this.toastsEl.lastElementChild?.remove();
    setTimeout(() => el.remove(), level === 'danger' ? 9000 : 6000);
  }

  // ------------------------------------------------------------------ inspector

  private renderInspector(): void {
    const b = this.selected();
    clear(this.inspHead);
    clear(this.tabsEl);
    clear(this.inspBody);
    this.liveRefresh = null;
    if (!b) {
      this.inspBody.appendChild(h('div', { class: 'muted' }, 'Click a body to inspect it. Double-click to fly to it.'));
      return;
    }
    const primary = this.sim.primaryOf(b);
    const nameIn = h('input', { type: 'text', value: b.name }) as HTMLInputElement;
    nameIn.addEventListener('change', () => (b.name = nameIn.value || b.name));
    this.inspHead.appendChild(
      h('div', { class: 'insp-title' }, h('span', { class: 'dot', style: `background:${b.color};width:22px;height:22px` }), h('div', { class: 'grow' }, nameIn, h('div', { class: 'kind' }, kindLabel(b, primary)))),
    );
    const isFocus = b.id === this.sim.focusId;
    this.inspHead.appendChild(
      h(
        'div',
        { class: 'row wrap', style: 'margin-top:8px' },
        h('button', { class: isFocus ? 'active' : 'primary', onclick: () => this.focusBody(b) }, isFocus ? 'Focused' : 'Fly to'),
        !b.isStarLike ? h('button', { onclick: () => { this.focusBody(b); setTimeout(() => this.toggleLanding(), 1700); } }, b.isGiant ? 'Dive in' : 'Land') : null,
        h('button', { onclick: () => this.duplicate(b) }, 'Duplicate'),
        h('button', { class: 'danger', onclick: () => this.sim.removeBody(b) }, 'Delete'),
      ),
    );
    const tabs: [Tab, string][] = [['overview', 'Overview']];
    if (b.star) tabs.push(['star', 'Star']);
    if (b.climate) tabs.push(['climate', 'Climate']);
    if (b.climate instanceof TerrestrialClimate) tabs.push(['atmosphere', 'Atmosphere'], ['life', 'Life']);
    tabs.push(['edit', 'Edit']);
    if (!tabs.some(([t]) => t === this.tab)) this.tab = 'overview';
    for (const [t, label] of tabs) {
      const btn = h('button', { class: t === this.tab ? 'active' : '' }, label);
      btn.addEventListener('click', () => {
        this.tab = t;
      });
      this.tabsEl.appendChild(btn);
    }
    const body = this.inspBody;
    const live = h('div');
    body.appendChild(live);
    const refreshers: Record<Tab, () => void> = {
      overview: () => this.overview(live, b),
      star: () => this.starTab(live, b),
      climate: () => this.climateTab(live, b),
      atmosphere: () => {},
      life: () => this.lifeTab(live, b),
      edit: () => {},
    };
    if (this.tab === 'atmosphere') this.atmosphereTab(body, b);
    if (this.tab === 'edit') this.editTab(body, b);
    if (this.tab === 'life') this.lifeControls(body, b);
    if (this.tab === 'star') this.starControls(body, b);
    this.liveRefresh = () => {
      if (!b.alive) return;
      clear(live);
      refreshers[this.tab]();
    };
    this.liveRefresh();
  }

  private overview(el: HTMLElement, b: Body): void {
    const p = this.sim.primaryOf(b);
    const rows: [string, string][] = [
      ['Mass', fmtMass(b.mass)],
      ['Radius', fmtRadius(b.radius)],
      ['Density', `${sig(b.density() / 1000, 3)} g/cm³`],
      ['Surface gravity', `${sig(b.surfaceGravity(), 3)} m/s² (${sig(b.surfaceGravity() / 9.81, 2)} g)`],
      ['Escape velocity', `${sig(b.escapeVelocity() / 1000, 3)} km/s`],
      ['Rotation', b.tidallyLocked ? 'tidally locked' : `${fmtDuration(Math.abs(b.rotationPeriod))}${b.rotationPeriod < 0 ? ' (retrograde)' : ''}`],
    ];
    if (p) {
      const o = orbitFromState(V3.sub(b.pos, p.pos), V3.sub(b.vel, p.vel), G * (p.mass + b.mass), 0);
      rows.push(['Orbits', p.name]);
      if (o.e < 1) {
        rows.push(['Semi-major axis', fmtDistance(o.a)]);
        rows.push(['Eccentricity', o.e.toFixed(4)]);
        rows.push(['Period', fmtDuration(orbitPeriod(o))]);
        rows.push(['Obliquity', `${((Math.acos(clamp(b.spinAxis.dot(o.W), -1, 1)) * 180) / Math.PI).toFixed(1)}°`]);
        if (Number.isFinite(b.precessionPeriod)) rows.push(['Axial precession', fmtDuration(b.precessionPeriod)]);
      } else rows.push(['Trajectory', 'unbound (escaping)']);
      rows.push(['Distance', fmtDistance(b.pos.distTo(p.pos))]);
    }
    if (!b.isStarLike) {
      const il = this.sim.illuminators(b);
      const flux = il.reduce((s, x) => s + x.flux, 0);
      rows.push(['Starlight', `${sig(flux, 3)} W/m² (${sig(flux / 1361, 3)}× Earth)`]);
      rows.push(['Equilibrium T', fmtTemp(Math.pow((flux * 0.7) / (4 * 5.670374419e-8), 0.25))]);
      if (b.tidalHeat > 1e-4) rows.push(['Tidal heating', `${sig(b.tidalHeat, 3)} W/m²`]);
      if (b.insolationFactor !== 1) rows.push(['Sunshade/mirror', `${(b.insolationFactor * 100).toFixed(0)}%`]);
    }
    if (b.climate instanceof TerrestrialClimate && b.climate.driftMyr > 1) rows.push(['Continental drift', `${b.climate.driftMyr.toFixed(0)} Myr of plate motion`]);
    el.appendChild(kv(rows));
    if (b.description) el.appendChild(h('p', { class: 'muted', style: 'margin:10px 0 0;line-height:1.4' }, b.description));
    const c = b.climate;
    if (c instanceof TerrestrialClimate) {
      const s = c.stats;
      el.appendChild(section('Climate snapshot'));
      const hab = s.habitable;
      el.appendChild(
        h(
          'div',
          { class: 'row wrap' },
          h('span', { class: 'badge' }, fmtTemp(s.meanT)),
          h('span', { class: 'badge' }, fmtPressure(s.P)),
          h('span', { class: `badge ${hab > 0.3 ? 'good' : hab > 0.02 ? 'warn' : 'bad'}` }, `Habitable ${fmtPct(hab)}`),
          s.runaway ? h('span', { class: 'badge bad' }, 'Runaway greenhouse') : null,
          s.snowball ? h('span', { class: 'badge warn' }, 'Snowball') : null,
          s.subsurfaceOcean ? h('span', { class: 'badge good' }, 'Subsurface ocean') : null,
          c.civ ? h('span', { class: 'badge good' }, `${sig(c.civ.totalPop / 1e9, 3)} billion people`) : null,
        ),
      );
    }
  }

  private starTab(el: HTMLElement, b: Body): void {
    const s = b.star!;
    const ageYr = s.age / YEAR;
    const rows: [string, string][] = [
      ['Type', `${spectralClass(s.T, s.phase)} — ${PHASE_LABEL[s.phase]}`],
      ['Luminosity', `${sig(s.L / 3.828e26, 3)} L☉`],
      ['Temperature', `${Math.round(s.T)} K`],
      ['Radius', fmtRadius(s.R)],
      ['Age', fmtDuration(s.age)],
    ];
    if (s.model === 'track') {
      const mi = s.initialMass / M_SUN;
      const tms = msLifetime(mi);
      rows.push(['Initial mass', `${sig(mi, 3)} M☉`]);
      rows.push(['Main-sequence life', `${fmtDuration(tms * YEAR)}`]);
      if (s.phase === 'MS') rows.push(['Remaining on MS', fmtDuration((tms - ageYr) * YEAR)]);
    }
    if (s.L > 0 && (b.kind === 'star' || b.kind === 'brownDwarf' || b.kind === 'whiteDwarf')) {
      const hz = habitableZone(s.L, s.T);
      const au = (m: number) => (m / AU < 0.1 ? `${sig((m / AU) * 1000, 3)} mAU` : `${sig(m / AU, 3)} AU`);
      rows.push(['Habitable zone', `${au(hz.inner)}–${au(hz.outer)}`]);
      const mid = Math.sqrt(hz.inner * hz.outer);
      rows.push(['Year in the zone', fmtDuration(2 * Math.PI * Math.sqrt(mid ** 3 / (G * b.mass)))]);
      if (b.kind === 'brownDwarf' || b.kind === 'whiteDwarf') {
        // Degenerate objects only cool: show where the zone will be later.
        const later = s.model === 'BD' ? brownDwarf(b.mass / M_SUN, ageYr + 1e9) : whiteDwarf(b.mass / M_SUN, ageYr + 1e9);
        const hz2 = habitableZone(later.L * L_SUN, later.T);
        rows.push(['Zone in 1 Gyr', `${au(hz2.inner)}–${au(hz2.outer)} (cooling)`]);
      }
    }
    el.appendChild(kv(rows));
  }

  private starControls(body: HTMLElement, b: Body): void {
    const s = b.star!;
    if (s.model !== 'track') return;
    body.appendChild(section('Evolve'));
    const mi = s.initialMass / M_SUN;
    const starts = phaseStartAges(mi);
    const row = h('div', { class: 'row wrap' });
    for (const [phase, age] of Object.entries(starts)) {
      row.appendChild(
        h(
          'button',
          {
            onclick: () => {
              s.age = (age as number) * YEAR * 1.0001 + (phase === 'MS' ? 0 : 1e3 * YEAR);
              refreshStar(b, 0);
              this.sim.bodyChanged(b);
              this.toast(`${b.name} jumped to ${PHASE_LABEL[phase as keyof typeof PHASE_LABEL]}.`, 'info', b.id);
            },
          },
          PHASE_LABEL[phase as keyof typeof PHASE_LABEL].replace(' star', ''),
        ),
      );
    }
    body.appendChild(row);
    body.appendChild(
      h(
        'div',
        { class: 'row wrap', style: 'margin-top:6px' },
        h('button', { onclick: () => { s.age += 1e8 * YEAR; refreshStar(b, 0); } }, '+100 Myr'),
        h('button', { onclick: () => { s.age += 1e9 * YEAR; refreshStar(b, 0); } }, '+1 Gyr'),
      ),
    );
  }

  private climateTab(el: HTMLElement, b: Body): void {
    const c = b.climate;
    if (c instanceof GasGiantClimate) {
      const s = c.stats;
      el.appendChild(
        kv([
          ['1-bar temperature', fmtTemp(s.T1bar)],
          ['Effective temperature', `${Math.round(s.Teff)} K`],
          ['Equilibrium temperature', `${Math.round(s.Teq)} K`],
          ['Cloud class (Sudarsky)', s.sudarskyLabel],
          ['Bond albedo', s.albedo.toFixed(2)],
          ['Jets per hemisphere', String(s.nJets)],
          ['Equatorial jet', `${Math.round(s.equatorialJet)} m/s`],
          ['Radiative timescale', fmtDuration(s.tauRad)],
          ['Day / night', `${Math.round(s.Tday)} / ${Math.round(s.Tnight)} K`],
          ...(b.tidallyLocked ? ([['Hot-spot offset', `${s.hotspotOffset.toFixed(0)}° east`]] as [string, string][]) : []),
        ]),
      );
      el.appendChild(section('Storms'));
      const st = h('div', { class: 'storms' });
      for (const v of c.vortices.slice(0, 6)) st.appendChild(h('div', null, `${v.name} at ${((v.lat * 180) / Math.PI).toFixed(0)}°, ${sig((2 * v.a) / 1e3, 3)} km across`));
      el.appendChild(st);
      const cv = h('canvas', { class: 'chart' }) as HTMLCanvasElement;
      el.appendChild(section('History'));
      el.appendChild(cv);
      requestAnimationFrame(() => drawChart(cv, c.history.t, [{ values: c.history.series.T ?? [], color: '#ff9f6b', label: 'T' }], { fmt: (v) => `${v.toFixed(0)}K`, xfmt: (t) => fmtDate(this.sim.epochMs, t) }));
      return;
    }
    if (!(c instanceof TerrestrialClimate)) return;
    const s = c.stats;
    el.appendChild(
      kv([
        ['Mean surface temperature', fmtTemp(s.meanT)],
        ['Range', `${fmtTemp(s.minT)} … ${fmtTemp(s.maxT)}`],
        ['Surface pressure', fmtPressure(s.P)],
        ['Greenhouse warming', `${s.greenhouse >= 0 ? '+' : ''}${s.greenhouse.toFixed(1)} K`],
        ['Bond albedo', s.albedo.toFixed(3)],
        ['Cloud cover', fmtPct(s.cloudFrac)],
        ['Precipitation', `${s.precip.toFixed(2)} mm/day`],
        ['Ocean cover', fmtPct(s.oceanFrac)],
        ['Ice & snow cover', fmtPct(s.iceFrac)],
        ['Sea level', Number.isFinite(s.seaLevel) ? `${s.seaLevel.toFixed(0)} m` : 'no ocean'],
        ['Water inventory', `${sig(s.waterGEL, 3)} m global layer`],
        ['Habitable surface', fmtPct(s.habitable)],
        ['Human-habitable', fmtPct(s.humanHabitable)],
        ['Circulation', `${s.nCells} cell${s.nCells > 1 ? 's' : ''}/hemisphere, Hadley edge ${((s.hadleyEdge * 180) / Math.PI).toFixed(0)}°`],
        ['Model tier', c.mode === 'weather' ? 'Weather (full)' : c.mode === 'seasonal' ? 'Seasonal' : 'Simple (fast time)'],
      ]),
    );
    if (c.storms.storms.length) {
      el.appendChild(section('Active weather systems'));
      const st = h('div', { class: 'storms' });
      for (const x of c.storms.storms.filter((x) => x.vmax > 15).slice(0, 8))
        st.appendChild(h('div', null, `${x.name}: ${stormCategory(x)}, ${Math.round(x.vmax)} m/s at ${((x.lat * 180) / Math.PI).toFixed(0)}°, ${((x.lon * 180) / Math.PI).toFixed(0)}°`));
      el.appendChild(st);
    }
    el.appendChild(section('History'));
    const sel = h('select', null, ...['T', 'CO2', 'ice', 'P', 'precip', 'seaLevel', 'habitable', 'albedo', 'veg', 'water'].map((k) => h('option', { value: k }, k))) as HTMLSelectElement;
    sel.value = (this as any)._histKey ?? 'T';
    sel.addEventListener('change', () => ((this as any)._histKey = sel.value));
    const cv = h('canvas', { class: 'chart' }) as HTMLCanvasElement;
    el.appendChild(h('div', { class: 'row' }, h('span', { class: 'muted grow' }, 'Global mean'), sel));
    el.appendChild(cv);
    const key = sel.value;
    const vals = c.history.series[key] ?? [];
    const fmt = key === 'T' ? (v: number) => `${(v - 273.15).toFixed(1)}°` : key === 'CO2' ? (v: number) => `${sig(v, 3)}Pa` : (v: number) => sig(v, 3);
    requestAnimationFrame(() => drawChart(cv, c.history.t, [{ values: vals, color: '#6fc3ff', label: key }], { fmt, xfmt: (t) => fmtDate(this.sim.epochMs, t) }));
  }

  private atmosphereTab(body: HTMLElement, b: Body): void {
    const c = b.climate as TerrestrialClimate;
    const info = h('div');
    const refreshInfo = () => {
      clear(info);
      const pp = c.bulk?.pp;
      const P = c.P;
      const rows: [string, string][] = [['Total pressure', fmtPressure(P)]];
      if (pp) for (const id of GAS_ORDER) if (pp[id] > 1e-6) rows.push([`${GASES[id].name} (${GASES[id].formula})`, `${fmtPressure(pp[id])} · ${fmtPpm(pp[id] / Math.max(P, 1e-9))}`]);
      rows.push([c.vol.id === 'H2O' ? 'Water vapour' : 'Methane vapour', `${sig(c.stats.vapourGEL * 1000, 3)} kg/m²`]);
      info.appendChild(kv(rows));
    };
    refreshInfo();
    body.appendChild(info);
    body.appendChild(section('Add or remove gases'));
    body.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, 'Changes apply instantly; the climate responds over time. Hold the simulation at a faster speed to see the new equilibrium.'));
    const gasList: GasId[] = ['N2', 'O2', 'CO2', 'CH4', 'Ar', 'H2', 'SO2', 'NH3', 'CFC'];
    for (const id of gasList) {
      const g = GASES[id];
      const steps = id === 'CFC' ? [0.01, 0.1, 1] : id === 'CH4' || id === 'NH3' || id === 'SO2' ? [1, 100, 1e4] : [100, 1e4, 1e5];
      const row = h('div', { class: 'row', style: 'margin:3px 0' }, h('span', { class: 'swatch', style: `background:${g.color}` }), h('span', { class: 'grow', title: g.description }, `${g.name}`));
      for (const s of steps) row.appendChild(h('button', { onclick: () => { c.addGasPressure(id, s); refreshInfo(); } }, `+${fmtPressure(s)}`));
      row.appendChild(
        h('button', { class: 'danger', title: `Remove all ${g.formula}`, onclick: () => { c.gas[id] = 0; c.version++; refreshInfo(); } }, '0'),
      );
      body.appendChild(row);
    }
    body.appendChild(section(c.vol.id === 'H2O' ? 'Water' : 'Methane'));
    const wrow = h('div', { class: 'row wrap' });
    for (const gel of [1, 10, 100, 1000]) wrow.appendChild(h('button', { onclick: () => { c.addVolatile(gel); refreshInfo(); } }, `+${gel} m`));
    wrow.appendChild(h('button', { class: 'danger', onclick: () => { c.addVolatile(-c.stats.waterGEL); refreshInfo(); } }, 'Dry out'));
    body.appendChild(wrow);
    body.appendChild(section('Atmosphere'));
    body.appendChild(
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'danger', onclick: () => { c.stripAtmosphere(1); refreshInfo(); } }, 'Strip atmosphere'),
        h('button', { title: 'Pinatubo-size eruption (VEI 6)', onclick: () => this.erupt(b, c, 6) }, '🌋 Eruption'),
        h('button', { title: 'Tambora-size eruption (VEI 7)', onclick: () => this.erupt(b, c, 7) }, '🌋 Colossal'),
        h('button', { class: 'danger', title: 'Supervolcano (VEI 8): years of volcanic winter', onclick: () => this.erupt(b, c, 8) }, '🌋 Supervolcano'),
        h('button', { onclick: () => { c.setPartialPressures({ N2: 78084, O2: 20946, Ar: 934, CO2: 42 }); refreshInfo(); } }, 'Earth-like air'),
      ),
    );
  }

  /** Trigger an eruption at a high land point of a world. */
  private erupt(b: Body, c: TerrestrialClimate, vei: number): void {
    let best = -Infinity,
      bk = 0;
    for (let t = 0; t < 40; t++) {
      const k = Math.floor(Math.random() * c.grid.N);
      const s = c.elev[k] + (c.ocean[k] < 0.5 ? 3000 : 0) + Math.random() * 2000;
      if (s > best) {
        best = s;
        bk = k;
      }
    }
    c.eruption(c.grid.lat[Math.floor(bk / c.grid.nLon)], c.grid.lon[bk % c.grid.nLon], vei);
    this.sim.events.emit('eruption', { body: b, ...c.eruptions[c.eruptions.length - 1] });
    c.eruptions.length = 0;
  }

  private lifeTab(el: HTMLElement, b: Body): void {
    const c = b.climate as TerrestrialClimate;
    const pig = plantPigment(c.hostTeff);
    const css = `rgb(${pig.map((x) => Math.round(Math.min(1, x * 3) * 255)).join(',')})`;
    // Biome shares of the land.
    const shares = new Array(BIOMES.length).fill(0);
    let landW = 0;
    for (let k = 0; k < c.grid.N; k++) {
      const w = c.grid.cellArea[Math.floor(k / c.grid.nLon)];
      const bi = c.biomeAt(k);
      if (bi === 0) continue;
      shares[bi] += w;
      landW += w;
    }
    const top = shares
      .map((s, i) => [i, s] as [number, number])
      .filter(([, s]) => s > 0.02 * landW)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([i, s]) => `${BIOMES[i]} ${Math.round((100 * s) / Math.max(landW, 1e-9))}%`)
      .join(', ');
    el.appendChild(
      kv([
        ['Life', `${LIFE_STAGES[c.lifeStage]}${c.lifeStage > 0 && c.lifeStage < 4 ? ' (evolving)' : ''}`],
        ['Biomes', top || '—'],
        ['Vegetation cover (land)', fmtPct(c.stats.vegetation / Math.max(1 - c.stats.oceanFrac, 1e-3))],
        ['Plant colour', h('span', { class: 'v' }, h('span', { class: 'swatch', style: `background:${css}` }), ` ${pigmentName(c.hostTeff)}`)],
        ['Biomass carbon', `${sig(c.vegetationCarbon() / 1e12, 3)} Gt C`],
      ]),
    );
    const civ = c.civ;
    el.appendChild(section('Civilization'));
    if (!civ) {
      el.appendChild(h('div', { class: 'muted' }, c.biosphere ? 'No civilization (yet). Intelligent life may emerge on long-habitable worlds.' : 'No life.'));
      return;
    }
    const ppm = ((c.bulk?.pp.CO2 ?? 0) / Math.max(c.P, 1)) * 1e6;
    el.appendChild(
      kv([
        ['Era', ERA_LABEL[civ.era]],
        ['Population', `${sig(civ.totalPop / 1e9, 3)} billion`],
        ['Peak population', `${sig(civ.peakPop / 1e9, 3)} billion`],
        ['CO₂ emissions', `${sig((civ.emissions * YEAR) / 1e12, 3)} Gt/yr`],
        ['Cumulative CO₂', `${sig(civ.cumulativeCO2 / 1e12, 4)} Gt`],
        ['Atmospheric CO₂', `${sig(ppm, 4)} ppm`],
        ['Technology', civ.tech.toFixed(2)],
        ['Carbon tax', civ.carbonTax ? 'yes' : 'no'],
        ['Geoengineering', civ.geoengineering > 0 ? `aerosol τ ${civ.geoengineering.toFixed(3)}` : 'none'],
        ['Stage', civ.era === 'collapsed' ? 'collapsed' : civ.tech >= 2.45 ? 'interstellar' : civ.tech >= 2.1 ? 'spacefaring' : civ.tech >= 2 ? 'post-carbon' : civ.tech >= 1 ? 'industrial' : 'agrarian'],
      ]),
    );
    // Terraforming projects and colony ships of this world.
    const ag = this.sim.agency;
    const mine = ag.projects.filter((p) => p.by === b.id);
    const ships = ag.voyages.filter((v) => v.from === b.id);
    const onMe = ag.projects.find((p) => p.target === b.id);
    if (mine.length || ships.length || onMe) {
      el.appendChild(section('Projects'));
      const rows: [string, string][] = [];
      for (const p of mine) rows.push(['Terraforming', `${this.sim.getBody(p.target)?.name ?? '?'} (for ${fmtDuration(this.sim.time - p.started)})`]);
      if (onMe) rows.push(['Being terraformed by', onMe.owner === 'Global civilization' ? this.sim.getBody(onMe.by)?.name ?? onMe.owner : onMe.owner]);
      for (const v of ships) rows.push(['Colony ship', `to ${this.sim.getBody(v.toStar)?.name ?? '?'}, arrives in ${fmtDuration(Math.max(0, v.arrive - this.sim.time))}`]);
      el.appendChild(kv(rows));
    }
  }

  private lifeControls(body: HTMLElement, b: Body): void {
    const c = b.climate as TerrestrialClimate;
    body.appendChild(section('Interventions'));
    body.appendChild(
      h(
        'div',
        { class: 'row wrap' },
        c.lifeStage > 0
          ? h('button', { class: 'danger', onclick: () => { c.lifeStage = 0; c.biosphere = false; c.veg.fill(0); this.lastSelected = -1; } }, 'Sterilize')
          : h('button', { title: 'Start evolution from scratch: microbes, then (over ~1–2 Gyr) oxygen, plants and animals', onclick: () => { c.lifeStage = 1; this.lastSelected = -1; this.toast(`Microbes seeded on ${b.name}. Speed up time to watch evolution.`, 'success', b.id); } }, 'Seed microbes'),
        c.lifeStage < 4 ? h('button', { class: 'primary', onclick: () => { c.lifeStage = 4; c.biosphere = true; this.lastSelected = -1; this.toast(`A full biosphere seeded on ${b.name}. Plants spread where it is warm and wet.`, 'success', b.id); } }, 'Seed plants & animals') : null,
        !c.civ
          ? h('button', { onclick: () => { c.seedCivilization('preindustrial'); this.lastSelected = -1; } }, 'Seed civilization')
          : h('button', { onclick: () => { c.civ!.tech = Math.max(c.civ!.tech, 1.85); this.toast('Clean-energy push: emissions will fall as the transition completes.', 'success', b.id); } }, 'Clean-energy push'),
        c.civ ? h('button', { class: 'danger', onclick: () => { c.removeCivilization(); this.lastSelected = -1; } }, 'Remove civilization') : null,
        h('button', { title: 'Direct air capture: remove 100 Gt of CO₂', onclick: () => { c.gas.CO2 = Math.max(0, c.gas.CO2 - 1e14); } }, 'Capture 100 Gt CO₂'),
      ),
    );
    const civ = c.civ;
    if (civ && civ.era !== 'collapsed') {
      body.appendChild(section('Policies'));
      const tax = h('input', { type: 'checkbox' }) as HTMLInputElement;
      tax.checked = civ.carbonTax;
      tax.addEventListener('change', () => {
        civ.carbonTax = tax.checked;
        this.toast(tax.checked ? 'Carbon tax: fossil emissions drop and clean energy arrives sooner.' : 'Carbon tax repealed.', 'info', b.id);
      });
      body.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin:4px 0' }, tax, 'Carbon tax'));
      const auto = h('input', { type: 'checkbox' }) as HTMLInputElement;
      auto.checked = civ.autoPolicy;
      auto.addEventListener('change', () => (civ.autoPolicy = auto.checked));
      body.appendChild(h('label', { class: 'row', style: 'cursor:pointer;margin:4px 0', title: 'The civilization reacts to warming by itself: a carbon tax after ~1.5 °C, geoengineering after ~3 °C' }, auto, 'Decides its own climate policy'));
      body.appendChild(
        slider('Geoengineering (stratospheric sulfate)', {
          min: 0,
          max: 0.15,
          step: 0.005,
          value: civ.geoengineering,
          fmt: (v) => (v <= 0 ? 'off' : `τ ${v.toFixed(3)}`),
          onInput: (v) => (civ.geoengineering = v),
          title: 'Reflects sunlight to cool the planet while it lasts; stopping it suddenly brings back the warming at once',
        }),
      );
      body.appendChild(h('div', { class: 'row wrap' }, h('button', { class: 'danger', onclick: () => { civ.nuclearWar(); this.lastSelected = -1; } }, '☢ Nuclear war')));
    }
  }

  private editTab(body: HTMLElement, b: Body): void {
    const sim = this.sim;
    const logS = (label: string, value: number, min: number, max: number, fmt: (v: number) => string, apply: (v: number) => void) =>
      slider(label, { min: Math.log10(min), max: Math.log10(max), value: Math.log10(Math.max(value, min)), fmt: (x) => fmt(Math.pow(10, x)), onInput: () => {}, onCommit: (x) => apply(Math.pow(10, x)) });
    body.appendChild(section('Physical'));
    body.appendChild(
      logS('Mass', b.mass, 1e15, 100 * M_SUN, fmtMass, (m) => {
        b.mass = m;
        if (b.star && b.star.model === 'track') b.star.initialMass = m;
        sim.bodyChanged(b);
        this.lastSelected = -1;
      }),
    );
    if (!b.isStarLike) {
      body.appendChild(
        slider('Day length (h)', {
          min: 2,
          max: 2000,
          step: 1,
          value: Math.min(2000, Math.abs(b.rotationPeriod) / 3600),
          fmt: (v) => `${v.toFixed(0)} h`,
          onInput: () => {},
          onCommit: (v) => {
            b.tidallyLocked = false;
            b.rotationPeriod = v * 3600 * Math.sign(b.rotationPeriod || 1);
          },
        }),
      );
      const p = sim.primaryOf(b);
      if (p) {
        const o = orbitFromState(V3.sub(b.pos, p.pos), V3.sub(b.vel, p.vel), G * (p.mass + b.mass), 0);
        const obl = (Math.acos(clamp(b.spinAxis.dot(o.W), -1, 1)) * 180) / Math.PI;
        body.appendChild(
          slider('Axial tilt', {
            min: 0,
            max: 180,
            step: 0.5,
            value: obl,
            fmt: (v) => `${v.toFixed(1)}°`,
            onInput: () => {},
            onCommit: (v) => {
              const ref = V3.perpendicular(o.W);
              b.setSpinAxis(o.W.clone().scale(Math.cos((v * Math.PI) / 180)).addScaled(ref, Math.sin((v * Math.PI) / 180)));
            },
          }),
        );
        body.appendChild(section('Orbit'));
        body.appendChild(
          logS('Semi-major axis', Math.max(o.a, p.radius * 1.5), Math.max(p.radius * 1.2, 1e6), 1000 * AU, fmtDistance, (a) => {
            const r = V3.sub(b.pos, p.pos).normalize().scale(a);
            b.pos.copy(p.pos).add(r);
            const t = o.W.cross(r).normalize();
            b.vel.copy(p.vel).addScaled(t, Math.sqrt((G * (p.mass + b.mass)) / a));
            sim.bodyChanged(b);
          }),
        );
        body.appendChild(
          h(
            'div',
            { class: 'row wrap' },
            h('button', { onclick: () => { b.tidallyLocked = !b.tidallyLocked; this.lastSelected = -1; } }, b.tidallyLocked ? 'Unlock rotation' : 'Tidally lock'),
            h('button', { onclick: () => { b.vel.sub(p.vel).scale(1.1).add(p.vel); sim.bodyChanged(b); } }, 'Boost +10%'),
            h('button', { onclick: () => { b.vel.sub(p.vel).scale(0.9).add(p.vel); sim.bodyChanged(b); } }, 'Brake −10%'),
          ),
        );
      }
      body.appendChild(section('Engineering'));
      body.appendChild(
        slider('Starlight (sunshade < 100% < mirror)', {
          min: 0.3,
          max: 2,
          step: 0.01,
          value: b.insolationFactor,
          fmt: (v) => `${(v * 100).toFixed(0)}%`,
          onInput: (v) => (b.insolationFactor = v),
        }),
      );
      body.appendChild(
        logS('Internal heat flux', Math.max(b.internalHeat, 1e-3), 1e-3, 1e3, (v) => `${sig(v, 3)} W/m²`, (v) => (b.internalHeat = v)),
      );
      const c = b.climate;
      if (c instanceof TerrestrialClimate) {
        body.appendChild(section('Terrain (procedural)'));
        const styleSel = h('select', null, ...TERRAIN_STYLES.map((t) => h('option', { value: t.id }, t.label))) as HTMLSelectElement;
        styleSel.value = c.style;
        body.appendChild(
          h(
            'div',
            { class: 'row' },
            styleSel,
            h('button', { onclick: () => { c.regenerateTerrain(styleSel.value as TerrainStyle, Math.floor(Math.random() * 1e9)); this.toast(`New terrain generated for ${b.name}.`, 'info', b.id); } }, '🎲 Regenerate'),
          ),
        );
        body.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, `${c.craters.length} impact crater(s) recorded.`));
      }
    }
  }

  /** Add a copy of a body on the same orbit, 0.6 rad further along. */
  private duplicate(b: Body): void {
    const clone = b.isGiant ? makeGiant({ name: `${b.name} II`, mass: b.mass, radius: b.radius, rotationHours: Math.abs(b.rotationPeriod) / 3600, seed: seed(), palette: b.giant?.palette, rings: b.rings ? { inner: b.rings.inner, outer: b.rings.outer, opacity: b.rings.opacity } : undefined }) : b.star ? makeStar({ name: `${b.name} II`, mass: b.star.initialMass / M_SUN, age: b.star.age / YEAR }) : b.world ? makeRocky({ name: `${b.name} II`, mass: b.mass, radius: b.radius, rotationHours: Math.abs(b.rotationPeriod) / 3600, atmosphere: (b.climate as TerrestrialClimate | null)?.bulk?.pp ?? b.world.atmosphere, waterGEL: b.world.waterGEL, biosphere: b.world.biosphere, terrain: b.world.terrain, seed: seed(), color: b.color }) : null;
    if (!clone) return;
    const p = this.sim.primaryOf(b);
    const off = V3.sub(b.pos, p ? p.pos : new V3());
    const ang = 0.6;
    const r2 = V3.rotate(off, new V3(0, 0, 1), ang);
    clone.pos.copy(p ? p.pos : new V3()).add(r2);
    clone.vel.copy(p ? p.vel : new V3()).add(V3.rotate(V3.sub(b.vel, p ? p.vel : new V3()), new V3(0, 0, 1), ang));
    this.sim.addBody(clone);
    this.select(clone.id);
  }

  // ------------------------------------------------------------------ modals

  private modal(content: HTMLElement): HTMLElement {
    const bg = h('div', { class: 'modal-bg' });
    const m = h('div', { class: 'modal panel' }, content);
    bg.appendChild(m);
    bg.addEventListener('click', (e) => {
      if (e.target === bg) bg.remove();
    });
    this.root.appendChild(bg);
    return bg;
  }

  private scenarioModal(): void {
    const grid = h('div', { class: 'grid' });
    const bg = this.modal(h('div', null, h('h2', null, 'Scenarios'), h('div', { class: 'muted' }, 'Every surface is generated procedurally; orbits, stars and atmospheres are physical.'), grid));
    const create = h('div', { class: 'item create' }, h('b', null, '✨ Create your own system…'), h('span', null, 'Pick a star — Sun-like, red dwarf, brown dwarf, white dwarf or binary — and generate a planetary system, or start empty and design planets.'));
    create.addEventListener('click', () => {
      bg.remove();
      this.systemBuilderModal();
    });
    grid.appendChild(create);
    for (const sc of SCENARIOS) {
      const it = h('div', { class: 'item' }, h('b', null, sc.name), h('span', null, sc.description));
      it.addEventListener('click', () => {
        bg.remove();
        this.withLoading(() => this.loadScenario(sc));
      });
      grid.appendChild(it);
    }
  }

  // ------------------------------------------------------------------ creation tools

  private sysOpts: SystemOptions = { seed: Math.floor(Math.random() * 1e6), star: 'G', planets: -1, habitable: true, life: true, civilization: 'none', moons: true, belt: false };

  /** Procedural star-system generator. */
  private systemBuilderModal(): void {
    const o = this.sysOpts;
    const chips = h('div', { class: 'chips' });
    const note = h('div', { class: 'muted', style: 'min-height:2.6em;margin:6px 0 2px;font-size:12px' });
    const renderChips = () => {
      clear(chips);
      for (const p of STAR_PRESETS) {
        const c = h('button', { class: o.star === p.id ? 'active' : '' }, p.label);
        c.addEventListener('click', () => {
          o.star = p.id as StarPreset;
          renderChips();
        });
        chips.appendChild(c);
      }
      note.textContent = STAR_PRESETS.find((p) => p.id === o.star)?.note ?? '';
    };
    renderChips();
    const chk = (label: string, key: 'habitable' | 'life' | 'moons' | 'belt', title = '') => {
      const el = h('input', { type: 'checkbox' }) as HTMLInputElement;
      el.checked = o[key];
      el.addEventListener('change', () => (o[key] = el.checked));
      return h('label', { class: 'row', style: 'cursor:pointer', title }, el, label);
    };
    const civ = h('select', null, h('option', { value: 'none' }, 'No civilization'), h('option', { value: 'preindustrial' }, 'Pre-industrial civilization'), h('option', { value: 'modern' }, 'Modern civilization')) as HTMLSelectElement;
    civ.value = o.civilization;
    civ.addEventListener('change', () => (o.civilization = civ.value as SystemOptions['civilization']));
    const seedIn = h('input', { type: 'number', value: String(o.seed), style: 'width:120px' }) as HTMLInputElement;
    seedIn.addEventListener('change', () => (o.seed = Math.max(1, Math.floor(+seedIn.value || 1))));
    const go = (planets?: number) => {
      bg.remove();
      const opts = { ...o, planets: planets ?? o.planets };
      this.withLoading(() => {
        const sc = systemScenario(opts);
        this.loadScenario(sc);
        this.toast(`${sc.summary}`, 'success', this.sim.focusId ?? undefined);
      });
      o.seed = Math.floor(Math.random() * 1e6);
    };
    const bg = this.modal(
      h(
        'div',
        null,
        h('h2', null, 'Create a star system'),
        h('div', { class: 'muted' }, 'Planets form where physics puts them: rocky worlds inside the snow line, giants beyond it, habitable worlds where their star’s light keeps water liquid.'),
        section('Star'),
        chips,
        note,
        slider('Age', { min: 0, max: 12, step: 0.1, value: o.ageGyr ?? 0, fmt: (v) => (v <= 0 ? 'typical for the type' : `${v.toFixed(1)} Gyr`), onInput: (v) => (o.ageGyr = v) }),
        section('Planets'),
        slider('Number of planets', { min: -1, max: 12, step: 1, value: o.planets, fmt: (v) => (v < 0 ? 'natural (3–9)' : v === 0 ? 'none — start empty' : String(v)), onInput: (v) => (o.planets = v) }),
        h('div', { class: 'row wrap', style: 'gap:14px;margin:6px 0' }, chk('Guarantee a habitable world', 'habitable', 'Places a temperate, watery world where its star makes it possible'), chk('Life', 'life'), chk('Moons', 'moons'), chk('Asteroid belt', 'belt')),
        h('div', { class: 'row', style: 'margin:6px 0' }, civ),
        (() => {
          const el = h('input', { type: 'checkbox' }) as HTMLInputElement;
          el.checked = (o.secondLy ?? 0) > 0;
          el.addEventListener('change', () => (o.secondLy = el.checked ? 0.5 : 0));
          return h('label', { class: 'row', style: 'cursor:pointer;margin:6px 0', title: 'Another star with its own planets, half a light-year away — a destination for colony ships' }, el, 'Add a second star system 0.5 light-years away');
        })(),
        h('div', { class: 'row', style: 'margin:10px 0 4px' }, h('span', { class: 'muted' }, 'Seed'), seedIn, h('button', { onclick: () => { o.seed = Math.floor(Math.random() * 1e6); seedIn.value = String(o.seed); } }, '🎲')),
        h('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' }, h('button', { onclick: () => go(0) }, 'Just the star'), h('button', { class: 'primary', onclick: () => go() }, 'Generate system')),
      ),
    );
  }

  /** Random planet around the selected/focused body's star, on an orbit that stays stable. */
  private addRandomPlanet(kind: 'rocky' | 'gas'): void {
    const sel = this.selected() ?? this.sim.focus();
    const starOf = (b: Body | null): Body | null => {
      for (let x = b, n = 0; x && n < 6; x = this.sim.primaryOf(x), n++) if (x.star && x.star.L > 0) return x;
      return null;
    };
    const host = starOf(sel) ?? this.sim.bodies.filter((b) => b.star && b.star.L > 0).sort((a, b) => b.star!.L - a.star!.L)[0];
    if (!host) {
      this.toast('Add a star first — a planet needs something to orbit.', 'warn');
      return;
    }
    const existing = this.sim.bodies.filter((b) => b !== host && !b.isStarLike && this.sim.primaryOf(b) === host).map((b) => ({ a: b.pos.distTo(host.pos), m: b.mass }));
    const b = randomPlanet(kind, host, existing, seed() * 7919 + Date.now() % 100000);
    if (!b) {
      this.toast(`No stable orbit left around ${host.name}.`, 'warn');
      return;
    }
    let n = 1;
    const base = b.name;
    while (this.sim.bodies.some((o) => o.name === base && o !== b) && n < 50) b.name = `${base} ${++n}`;
    this.withLoading(() => {
      this.sim.addBody(b);
      const hz = habitableZone(host.star!.L, host.star!.T);
      const d = b.pos.distTo(host.pos);
      if (b.world && b.world.waterGEL > 100 && (b.world.atmosphere.N2 ?? 0) > 1e4 && d > hz.inner && d < hz.outer) tuneTemperate(this.sim, b);
      this.focusBody(b);
      const c = b.climate instanceof TerrestrialClimate ? b.climate : null;
      this.toast(`${b.name}: ${kindLabel(b, host)} at ${d / AU < 0.1 ? `${sig((d / AU) * 1000, 3)} mAU` : `${sig(d / AU, 3)} AU`}${c ? `, ${fmtTemp(c.stats.meanT)}` : ''}.`, 'success', b.id);
    });
  }

  /** Custom planet: everything the climate model needs, placed on an orbit of your choice. */
  private planetDesignerModal(): void {
    const hosts = this.sim.bodies.filter((b) => (b.star && b.star.L > 0) || b.isGiant || (b.world && b.mass > 1e23));
    if (!hosts.length) {
      this.toast('Add a star first — a planet needs something to orbit.', 'warn');
      return;
    }
    const sel = this.selected();
    let defaultHost = (sel && hosts.includes(sel) && sel.star ? sel : null) ?? (sel ? this.sim.primaryOf(sel) : null) ?? hosts.find((b) => b.star) ?? hosts[0];
    if (!hosts.includes(defaultHost)) defaultHost = hosts.find((b) => b.star) ?? hosts[0];
    const st = {
      name: ['Nova', 'Terra Nova', 'Hespera', 'Ilia', 'Vesper', 'Calypso', 'Oberia', 'Teyla'][Math.floor(Math.random() * 8)],
      kind: 'rocky' as 'rocky' | 'gas' | 'ice',
      host: defaultHost as Body,
      a: 0,
      e: 0.01,
      inc: 0.5,
      massE: 1,
      dayH: 24,
      locked: false,
      tilt: 23,
      water: 2500,
      atm: 'earth' as 'none' | 'mars' | 'earth' | 'venus' | 'titan' | 'hydrogen',
      pBar: 1,
      co2ppm: 420,
      terrain: 'earthlike' as TerrainStyle,
      life: true,
      civ: 'none' as 'none' | 'preindustrial' | 'modern',
      tune: true,
      rings: false,
      palette: 'auto' as 'auto' | 'jupiter' | 'saturn' | 'uranus' | 'neptune',
    };
    const hzOf = (b: Body) => (b.star && b.star.L > 0 ? habitableZone(b.star.L, b.star.T) : null);
    const lumOf = (b: Body): number => {
      if (b.star) return b.star.L;
      // A planet host: use its star's light.
      const p = this.sim.primaryOf(b);
      return p?.star?.L ?? 0;
    };
    const defaultA = (b: Body) => {
      const hz = hzOf(b);
      if (hz) return Math.sqrt(hz.inner * hz.outer) * 0.85;
      return b.radius * 12;
    };
    st.a = defaultA(st.host);
    const info = h('div', { class: 'kv', style: 'margin-top:4px' });
    const rockyBox = h('div');
    const giantBox = h('div');
    const aBox = h('div');
    const fmtA = (m: number) => (st.host.star ? (m / AU < 0.1 ? `${sig((m / AU) * 1000, 3)} mAU` : `${sig(m / AU, 3)} AU`) : `${sig(m / st.host.radius, 3)} R(host) · ${fmtDistance(m)}`);
    const updateInfo = () => {
      clear(info);
      const L = lumOf(st.host);
      const dStar = st.host.star ? st.a : this.sim.primaryOf(st.host) ? st.host.pos.distTo(this.sim.primaryOf(st.host)!.pos) : st.a;
      const S = L / (4 * Math.PI * dStar * dStar) / 1361;
      const mHost = st.host.mass;
      const P = 2 * Math.PI * Math.sqrt(st.a ** 3 / (G * mHost));
      const teq = Math.pow((S * 1361 * 0.7) / (4 * 5.670374e-8), 0.25);
      const starHost = st.host.star ? st.host : this.sim.primaryOf(st.host);
      const hz = starHost ? hzOf(starHost) : null;
      let zone = '—';
      if (hz) zone = dStar < hz.optimisticInner ? 'too hot (inside the habitable zone)' : dStar > hz.optimisticOuter ? 'too cold (beyond the habitable zone)' : dStar < hz.inner || dStar > hz.outer ? 'edge of the habitable zone' : 'in the habitable zone ✓';
      const lockR = 0.3 * AU * Math.cbrt((starHost?.mass ?? mHost) / M_SUN);
      const rows: [string, string][] = [
        ['Starlight', `${sig(S * 1361, 3)} W/m² (${sig(S, 3)}× Earth)`],
        ['Equilibrium temperature', fmtTemp(teq)],
        ['Habitable zone', zone],
        ['Orbital period', fmtDuration(P)],
      ];
      if (st.host.star && st.a < lockR) rows.push(['Tides', 'close enough to become tidally locked']);
      for (const [k, v] of rows) {
        info.appendChild(h('span', { class: 'k' }, k));
        info.appendChild(h('span', { class: 'v' }, v));
      }
    };
    const renderA = () => {
      clear(aBox);
      const hz = st.host.star ? hzOf(st.host) : null;
      const lo = st.host.star ? Math.max(st.host.radius * 3, (hz ? hz.inner : AU) * 0.08) : st.host.radius * 2.5;
      const hi = st.host.star ? (hz ? hz.outer : AU) * 40 : st.host.radius * 300;
      st.a = clamp(st.a, lo, hi);
      aBox.appendChild(
        slider('Orbit distance', { min: Math.log(lo), max: Math.log(hi), step: 0.001, value: Math.log(st.a), fmt: (v) => fmtA(Math.exp(v)), onInput: (v) => { st.a = Math.exp(v); updateInfo(); } }),
      );
      updateInfo();
    };
    const hostSel = h('select', null, ...hosts.map((b) => h('option', { value: String(b.id) }, `${b.name} (${kindLabel(b, this.sim.primaryOf(b))})`))) as HTMLSelectElement;
    hostSel.value = String(st.host.id);
    hostSel.addEventListener('change', () => {
      st.host = hosts.find((b) => String(b.id) === hostSel.value) ?? st.host;
      st.a = defaultA(st.host);
      renderA();
    });
    const atmSel = h('select', null, ...([['none', 'No atmosphere'], ['mars', 'Thin CO₂ (Mars-like)'], ['earth', 'Nitrogen–oxygen (Earth-like)'], ['venus', 'Thick CO₂ (Venus-like)'], ['titan', 'Nitrogen + methane (Titan-like)'], ['hydrogen', 'Hydrogen envelope']] as [string, string][]).map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
    atmSel.value = st.atm;
    atmSel.addEventListener('change', () => {
      st.atm = atmSel.value as typeof st.atm;
      st.pBar = { none: 0, mars: 0.006, earth: 1, venus: 92, titan: 1.5, hydrogen: 30 }[st.atm];
      renderRocky();
    });
    const terrSel = h('select', null, ...TERRAIN_STYLES.map((t) => h('option', { value: t.id }, t.label))) as HTMLSelectElement;
    terrSel.value = st.terrain;
    terrSel.addEventListener('change', () => (st.terrain = terrSel.value as TerrainStyle));
    const civSel = h('select', null, h('option', { value: 'none' }, 'No civilization'), h('option', { value: 'preindustrial' }, 'Pre-industrial'), h('option', { value: 'modern' }, 'Modern')) as HTMLSelectElement;
    civSel.addEventListener('change', () => (st.civ = civSel.value as typeof st.civ));
    const check = (label: string, get: () => boolean, set: (v: boolean) => void, title = '') => {
      const el = h('input', { type: 'checkbox' }) as HTMLInputElement;
      el.checked = get();
      el.addEventListener('change', () => set(el.checked));
      return h('label', { class: 'row', style: 'cursor:pointer;margin:4px 0', title }, el, label);
    };
    const renderRocky = () => {
      clear(rockyBox);
      const parts: (HTMLElement | null)[] = [
        h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Atmosphere'), atmSel),
        st.atm !== 'none' ? slider('Surface pressure', { min: Math.log(0.001), max: Math.log(200), step: 0.01, value: Math.log(Math.max(st.pBar, 0.001)), fmt: (v) => fmtPressure(Math.exp(v) * 1e5), onInput: (v) => (st.pBar = Math.exp(v)) }) : null,
        st.atm === 'earth' ? slider('CO₂', { min: Math.log(1), max: Math.log(3e5), step: 0.01, value: Math.log(st.co2ppm), fmt: (v) => fmtPpm(Math.exp(v) * 1e-6), onInput: (v) => (st.co2ppm = Math.exp(v)) }) : null,
        slider('Water inventory (global ocean depth)', { min: 0, max: Math.log10(20000), step: 0.01, value: Math.log10(1 + st.water), fmt: (v) => (v <= 0.01 ? 'dry' : `${sig(10 ** v - 1, 2)} m`), onInput: (v) => (st.water = 10 ** v - 1) }),
        h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Terrain'), terrSel),
        h('div', { class: 'row wrap', style: 'gap:14px' }, check('Life', () => st.life, (v) => (st.life = v)), check('Auto-tune CO₂ to a temperate climate', () => st.tune, (v) => (st.tune = v), 'Adjusts CO₂ like a carbonate–silicate thermostat so the world starts temperate (when that is possible)')),
        h('div', { class: 'row', style: 'margin:4px 0' }, civSel),
      ];
      for (const el of parts) if (el) rockyBox.appendChild(el);
    };
    const renderGiant = () => {
      clear(giantBox);
      const pal = h('select', null, ...['auto', 'jupiter', 'saturn', 'uranus', 'neptune'].map((p) => h('option', { value: p }, p === 'auto' ? 'Colours from temperature' : `${p[0].toUpperCase()}${p.slice(1)}-like`))) as HTMLSelectElement;
      pal.value = st.palette;
      pal.addEventListener('change', () => (st.palette = pal.value as typeof st.palette));
      giantBox.append(h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Appearance'), pal), check('Rings', () => st.rings, (v) => (st.rings = v)));
    };
    const massBox = h('div');
    const renderMass = () => {
      clear(massBox);
      const giant = st.kind !== 'rocky';
      const lo = giant ? (st.kind === 'ice' ? 5 : 20) : 0.01;
      const hi = giant ? (st.kind === 'ice' ? 60 : 4000) : 12;
      st.massE = clamp(st.massE, lo, hi);
      massBox.appendChild(slider('Mass', { min: Math.log(lo), max: Math.log(hi), step: 0.001, value: Math.log(st.massE), fmt: (v) => (Math.exp(v) > 30 ? `${sig((Math.exp(v) * M_EARTH) / M_JUP, 3)} M♃` : `${sig(Math.exp(v), 3)} M⊕`), onInput: (v) => (st.massE = Math.exp(v)) }));
      rockyBox.classList.toggle('hidden', giant);
      giantBox.classList.toggle('hidden', !giant);
    };
    const kindSel = h('select', null, h('option', { value: 'rocky' }, 'Rocky planet'), h('option', { value: 'gas' }, 'Gas giant'), h('option', { value: 'ice' }, 'Ice giant')) as HTMLSelectElement;
    kindSel.addEventListener('change', () => {
      st.kind = kindSel.value as typeof st.kind;
      if (st.kind === 'gas') st.massE = 318;
      else if (st.kind === 'ice') st.massE = 17;
      else st.massE = 1;
      renderMass();
    });
    const nameIn = h('input', { type: 'text', value: st.name }) as HTMLInputElement;
    nameIn.addEventListener('input', () => (st.name = nameIn.value || 'New world'));
    const create = () => {
      const seedv = seed();
      let b: Body;
      if (st.kind === 'rocky') {
        const P = st.pBar * 1e5;
        const atm: Record<string, number> = {};
        if (st.atm === 'mars') Object.assign(atm, { CO2: P * 0.95, N2: P * 0.03, Ar: P * 0.02 });
        if (st.atm === 'earth') {
          const co2 = Math.min(P * 0.5, (st.co2ppm * 1e-6) * P);
          Object.assign(atm, { N2: (P - co2) * (st.life ? 0.78 : 0.98), Ar: (P - co2) * 0.01, CO2: co2 });
          if (st.life) atm.O2 = (P - co2) * 0.21;
        }
        if (st.atm === 'venus') Object.assign(atm, { CO2: P * 0.965, N2: P * 0.035, SO2: P * 1.5e-4 });
        if (st.atm === 'titan') Object.assign(atm, { N2: P * 0.95, CH4: P * 0.05 });
        if (st.atm === 'hydrogen') Object.assign(atm, { H2: P * 0.9, He: P * 0.1 });
        const dStar = st.host.star ? st.a : st.host.pos.distTo(this.sim.primaryOf(st.host)?.pos ?? st.host.pos);
        const L = lumOf(st.host);
        const teq = Math.pow(Math.max(L, 1) / (4 * Math.PI * dStar * dStar) * 0.7 / (4 * 5.670374e-8), 0.25);
        b = makeRocky({
          name: st.name,
          mass: st.massE * M_EARTH,
          rotationHours: st.dayH,
          atmosphere: atm,
          waterGEL: st.water < 0.5 ? 0 : st.water,
          volatile: st.atm === 'titan' ? 'CH4' : 'H2O',
          biosphere: st.life && st.water > 1,
          terrain: st.terrain,
          seed: seedv,
          haze: st.atm === 'titan' ? 0.7 : undefined,
          initialTemp: clamp(teq * (st.atm === 'venus' ? 2.5 : 1.1), 40, 2500),
          tidallyLocked: st.locked,
          civilization: st.civ === 'none' ? null : st.civ,
          color: st.water > 3000 ? '#2f6fb3' : st.atm === 'venus' ? '#e8cf8f' : st.water > 100 ? '#4f86c6' : '#b9a58a',
        });
      } else {
        const mass = st.massE * M_EARTH;
        b = makeGiant({ name: st.name, mass, rotationHours: st.locked ? 24 : Math.min(st.dayH, 40), seed: seedv, ice: st.kind === 'ice', palette: st.palette === 'auto' ? undefined : st.palette, tidallyLocked: st.locked });
        if (st.rings) b.rings = { inner: b.radius * 1.3, outer: b.radius * 2.3, mass: 1.5e19, seed: seedv, color: [0.85, 0.78, 0.66], opacity: 0.85 };
      }
      b.kind = classifyBody(b);
      let n = 1;
      const base = b.name;
      while (this.sim.bodies.some((o) => o.name === b.name)) b.name = `${base} ${++n}`;
      placeOnOrbit(b, st.host, { a: st.a, e: st.e, i: st.inc, node: Math.random() * 360, peri: Math.random() * 360, M: Math.random() * 360 });
      setObliquity(b, st.host, st.locked ? 0 : st.tilt, Math.random() * 360);
      bg.remove();
      this.withLoading(() => {
        this.sim.addBody(b);
        const starHost = st.host.star ? st.host : this.sim.primaryOf(st.host);
        const hzT = starHost?.star && starHost.star.L > 0 ? habitableZone(starHost.star.L, starHost.star.T) : null;
        const dS = starHost ? b.pos.distTo(starHost.pos) : 0;
        const inHZ = !!hzT && dS > hzT.optimisticInner * 0.9 && dS < hzT.optimisticOuter * 1.1;
        if (st.kind === 'rocky' && st.tune && st.atm === 'earth' && st.water > 1 && inHZ) tuneTemperate(this.sim, b);
        this.focusBody(b);
        const c = b.climate instanceof TerrestrialClimate ? b.climate : null;
        this.toast(`${b.name} created${c ? `: ${fmtTemp(c.stats.meanT)} average, ${fmtPressure(c.P)}` : ''}.`, 'success', b.id);
      });
    };
    const bg = this.modal(
      h(
        'div',
        { class: 'designer' },
        h('h2', null, 'Design a planet'),
        h('div', { class: 'cols' },
          h('div', null,
            h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Name'), nameIn),
            h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Type'), kindSel),
            massBox,
            section('Orbit'),
            h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, 'Orbits'), hostSel),
            aBox,
            slider('Eccentricity', { min: 0, max: 0.7, step: 0.005, value: st.e, fmt: (v) => v.toFixed(3), onInput: (v) => (st.e = v) }),
            slider('Inclination', { min: 0, max: 45, step: 0.5, value: st.inc, fmt: (v) => `${v.toFixed(1)}°`, onInput: (v) => (st.inc = v) }),
            section('Spin'),
            slider('Day length', { min: Math.log(4), max: Math.log(5000), step: 0.01, value: Math.log(st.dayH), fmt: (v) => fmtDuration(Math.exp(v) * HOUR), onInput: (v) => (st.dayH = Math.exp(v)) }),
            slider('Axial tilt', { min: 0, max: 180, step: 0.5, value: st.tilt, fmt: (v) => `${v.toFixed(1)}°`, onInput: (v) => (st.tilt = v) }),
            check('Tidally locked (one side always faces the host)', () => st.locked, (v) => (st.locked = v)),
          ),
          h('div', null,
            section('Surface & air'),
            rockyBox,
            giantBox,
            section('Where it will sit'),
            info,
          ),
        ),
        h('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' }, h('button', { onclick: () => bg.remove() }, 'Cancel'), h('button', { class: 'primary', onclick: create }, 'Create planet')),
      ),
    );
    renderRocky();
    renderGiant();
    renderMass();
    renderA();
  }

  private withLoading(fn: () => void): void {
    const l = document.getElementById('loading');
    l?.classList.remove('hidden');
    setTimeout(() => {
      fn();
      l?.classList.add('hidden');
    }, 40);
  }

  private challengeModal(): void {
    const grid = h('div', { class: 'grid' });
    const bg = this.modal(h('div', null, h('h2', null, 'Challenges'), h('div', { class: 'muted' }, 'Reach the goal and hold it for the required simulated time.'), grid));
    for (const ch of CHALLENGES) {
      const it = h('div', { class: 'item' }, h('b', null, ch.name), h('span', null, ch.description));
      it.addEventListener('click', () => {
        bg.remove();
        this.withLoading(() => {
          this.loadScenario(findScenario(ch.scenario));
          const t = this.sim.bodies.find((x) => x.name === ch.target);
          if (t) this.focusBody(t);
          ch.setup?.(this.sim);
          this.challenge = { challenge: ch, heldFor: 0, won: false, failed: false, last: { ok: false, progress: 0, status: '' } };
          this.toast(`Challenge: ${ch.name}. Tip: ${ch.hints[0]}`, 'info');
        });
      });
      grid.appendChild(it);
    }
  }

  private renderChallenge(): void {
    const st = this.challenge!;
    const el = this.challengeEl;
    el.classList.remove('hidden');
    clear(el);
    const ch = st.challenge;
    const holdFrac = clamp(st.heldFor / ch.hold, 0, 1);
    el.appendChild(h('div', { class: 'row sp' }, h('span', { class: 'title' }, `🎯 ${ch.name}`), h('button', { onclick: () => { this.challenge = null; el.classList.add('hidden'); } }, '×')));
    el.appendChild(h('div', { class: 'muted', style: 'font-size:12px;margin:3px 0' }, st.last.status));
    el.appendChild(h('div', { class: 'bar' }, h('i', { style: `width:${(st.won ? 100 : st.last.progress * 100).toFixed(0)}%` })));
    el.appendChild(
      h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px' }, st.won ? '🏆 Complete!' : st.failed ? 'Failed.' : st.last.ok ? `Holding: ${fmtDuration(st.heldFor)} / ${fmtDuration(ch.hold)} (${(holdFrac * 100).toFixed(0)}%)` : `Hint: ${ch.hints[Math.floor(this.sim.time / (30 * DAY)) % ch.hints.length]}`),
    );
  }

  private saveModal(): void {
    const list = h('div', { class: 'grid' });
    const nameIn = h('input', { type: 'text', value: `System ${new Date().toLocaleString()}` }) as HTMLInputElement;
    const bg = this.modal(
      h(
        'div',
        null,
        h('h2', null, 'Save / Load'),
        h('div', { class: 'row', style: 'margin:10px 0' }, nameIn, h('button', { class: 'primary', onclick: () => { if (saveSlot(this.sim, nameIn.value)) { this.toast('Saved.', 'success'); bg.remove(); } else this.toast('Could not save (storage full?). Use Export instead.', 'warn'); } }, 'Save')),
        h(
          'div',
          { class: 'row' },
          h('button', { onclick: () => this.exportFile() }, 'Export file…'),
          h('button', { onclick: () => this.importFile(bg) }, 'Import file…'),
        ),
        h('div', { class: 'section' }, 'Saved systems'),
        list,
      ),
    );
    for (const s of listSlots()) {
      const it = h('div', { class: 'item' }, h('b', null, s.name), h('span', null, new Date(s.savedAt).toLocaleString()));
      it.addEventListener('click', () => {
        bg.remove();
        this.withLoading(() => {
          if (loadSlot(this.sim, s.name)) {
            const f = this.sim.focus();
            if (f) this.r.cam.focus(f, { instant: true });
            this.syncSpeedSlider();
          }
        });
      });
      const del = h('button', { class: 'danger', style: 'margin-top:6px', onclick: (e: Event) => { e.stopPropagation(); deleteSlot(s.name); it.remove(); } }, 'Delete');
      it.appendChild(h('div', null, del));
      list.appendChild(it);
    }
    if (!list.children.length) list.appendChild(h('div', { class: 'muted' }, 'No saved systems yet.'));
  }

  private exportFile(): void {
    const blob = new Blob([serializeSim(this.sim)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `aeolus-${Date.now()}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  private importFile(bg: HTMLElement): void {
    const input = h('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      if (!f) return;
      const text = await f.text();
      bg.remove();
      this.withLoading(() => {
        try {
          loadSim(this.sim, text);
          const fb = this.sim.focus();
          if (fb) this.r.cam.focus(fb, { instant: true });
          this.syncSpeedSlider();
        } catch (e) {
          this.toast(`Could not load: ${(e as Error).message}`, 'danger');
        }
      });
    });
    input.click();
  }

  private settingsModal(): void {
    const s = this.sim.settings;
    const sel = <T extends string>(label: string, value: T, options: [T, string][], on: (v: T) => void) => {
      const el = h('select', null, ...options.map(([v, l]) => h('option', { value: v }, l))) as HTMLSelectElement;
      el.value = value;
      el.addEventListener('change', () => on(el.value as T));
      return h('div', { class: 'row sp', style: 'margin:6px 0' }, h('span', null, label), el);
    };
    const chk = (label: string, value: boolean, on: (v: boolean) => void) => {
      const el = h('input', { type: 'checkbox' }) as HTMLInputElement;
      el.checked = value;
      el.addEventListener('change', () => on(el.checked));
      return h('label', { class: 'row', style: 'margin:6px 0;cursor:pointer' }, el, label);
    };
    this.modal(
      h(
        'div',
        null,
        h('h2', null, 'Settings'),
        section('Display'),
        sel('Temperature unit', displaySettings.temp, [['C', '°C'], ['K', 'Kelvin'], ['F', '°F']], (v) => (displaySettings.temp = v)),
        sel('Brightness', view.mode, [['realistic', 'Realistic (eye adaptation)'], ['enhanced', 'Enhanced (always visible)']], (v) => setView('mode', v)),
        slider('Exposure bias', { min: -4, max: 4, step: 0.25, value: view.ev, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)} EV`, onInput: (v) => setView('ev', v) }),
        slider('Eye adaptation limit (night brightness)', {
          min: 2,
          max: 5.5,
          step: 0.1,
          value: Math.log10(view.adaptLimit),
          fmt: (v) => (v < 3 ? 'very dark nights' : v < 4.3 ? 'natural' : v < 5 ? 'bright nights' : 'night vision'),
          onInput: (v) => setView('adaptLimit', Math.pow(10, v)),
          title: 'How far the eye may adapt to darkness. Stars stay visible at any setting.',
        }),
        section('Simulation'),
        sel('Gravity', s.physics, [['auto', 'Auto (N-body, Kepler at extreme speed)'], ['nbody', 'Always N-body'], ['kepler', 'Always Kepler orbits']], (v) => (s.physics = v)),
        slider('N-body accuracy (smaller = more precise)', { min: 0.003, max: 0.05, step: 0.001, value: s.accuracy, fmt: (v) => v.toFixed(3), onInput: (v) => (s.accuracy = v) }),
        sel('Focused climate resolution', s.climateQuality, [['low', 'Low (24×48)'], ['medium', 'Medium (36×72)'], ['high', 'High (48×96)'], ['ultra', 'Ultra (64×128)']], (v) => {
          s.climateQuality = v;
          const f = this.sim.focus();
          if (f?.climate instanceof TerrestrialClimate) f.climate.setResolution(v);
        }),
        chk('Collisions & impacts', s.collisions, (v) => (s.collisions = v)),
        chk('Storms and cyclones', s.storms, (v) => (s.storms = v)),
        chk('Geology (volcanic CO₂, weathering)', s.geology, (v) => (s.geology = v)),
        chk('Civilizations', s.civilizations, (v) => (s.civilizations = v)),
      ),
    );
  }

  private helpModal(): void {
    this.modal(
      h(
        'div',
        null,
        h('h2', null, 'Aeolus — planetary climate sandbox'),
        h('p', { class: 'muted', style: 'line-height:1.5' }, 'Every rocky world runs a live climate model (radiation, greenhouse gases, clouds, winds, rain, snow, sea ice, sea level, storms, vegetation, civilizations). Gas giants have banded jets and storms. Stars evolve. Change anything and watch the climate respond. Faster time automatically switches to simpler physics (Weather → Seasonal → Simple).'),
        section('Controls'),
        h(
          'div',
          { class: 'keys' },
          h('kbd', null, 'Drag'), h('span', null, 'Orbit the camera / look around when landed'),
          h('kbd', null, 'Wheel'), h('span', null, 'Zoom — keep zooming in to land or dive into clouds'),
          h('kbd', null, 'Click'), h('span', null, 'Select a body'),
          h('kbd', null, 'Double-click'), h('span', null, 'Fly to a body'),
          h('kbd', null, 'L'), h('span', null, 'Land / take off'),
          h('kbd', null, 'W A S D'), h('span', null, 'Fly when landed (Shift = fast, Q/E = down/up)'),
          h('kbd', null, 'Space'), h('span', null, 'Pause / resume'),
          h('kbd', null, ', .'), h('span', null, 'Slower / faster'),
          h('kbd', null, 'V'), h('span', null, 'Realistic ↔ Enhanced brightness'),
          h('kbd', null, 'M'), h('span', null, 'Climate map (click it to place a weather station)'),
          h('kbd', null, 'O / N'), h('span', null, 'Toggle orbits / names'),
          h('kbd', null, 'Del'), h('span', null, 'Delete the selected body'),
          h('kbd', null, 'Esc'), h('span', null, 'Cancel a placement tool'),
          h('kbd', null, 'Place + drag'), h('span', null, 'With a toolbox item armed: click = circular orbit, drag = launch at your own speed and direction (the green line is the predicted path)'),
          h('kbd', null, '✨ Create'), h('span', null, 'Generate a star system around any star — even a brown dwarf'),
          h('kbd', null, '✎ Design'), h('span', null, 'Build a planet by hand: mass, orbit, air, water, terrain, life'),
        ),
        section('Ideas'),
        h('ul', { class: 'muted', style: 'line-height:1.6;padding-left:18px' },
          h('li', null, 'Push Earth toward the Sun (Edit → orbit) and watch the oceans boil away.'),
          h('li', null, 'Add CO₂ and engineered gases to Mars, then speed time up.'),
          h('li', null, 'Fire a 10 km asteroid at Earth: crater, fireball, impact winter.'),
          h('li', null, 'Hit a rocky planet with a Mars-sized body at a glancing angle: the debris gathers into a moon.'),
          h('li', null, 'Run the Earth & Moon for a few million years: tides push the Moon outward and the day gets longer.'),
          h('li', null, 'Jump the Sun to the red-giant phase from the Star tab.'),
          h('li', null, 'Land on Titan, or dive into Jupiter’s cloud decks.'),
          h('li', null, 'Switch to Realistic brightness, fly close to the Sun — then look at the night side of a planet.'),
        ),
      ),
    );
  }
}

export { R_EARTH };

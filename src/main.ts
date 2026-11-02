import './styles.css';
import { Simulation } from './sim/simulation';
import { findScenario } from './sim/scenarios';
import { Renderer } from './render/renderer';
import { App } from './ui/app';
import { setView, view } from './render/viewSettings';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const uiRoot = document.getElementById('ui') as HTMLDivElement;
const loading = document.getElementById('loading') as HTMLDivElement;

const sim = new Simulation();
const renderer = new Renderer(canvas, sim, overlay);
const app = new App(uiRoot, sim, renderer);
// Handy for the browser console and the headless smoke test.
(window as any).aeolus = { sim, renderer, app, view, setView };

window.addEventListener('resize', () => renderer.resize());

function start(): void {
  const params = new URLSearchParams(location.search);
  const sc = findScenario(params.get('scenario') ?? 'solar');
  app.loadScenario(sc);
  loading.classList.add('hidden');
  let last = performance.now();
  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;
    sim.update(dt);
    app.update(dt);
    renderer.render(dt);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// Let the loading screen paint before the (synchronous) world generation.
setTimeout(start, 30);

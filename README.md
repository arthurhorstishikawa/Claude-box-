# Aeolus — a planetary climate sandbox

Aeolus is a browser space sandbox, in the spirit of Universe Sandbox, that puts **climate and
weather** first. Stars evolve, planets orbit under real N-body gravity, and every rocky world
runs a live climate model: radiation, greenhouse gases, clouds, winds, rain and snow, sea ice,
sea level, storms, vegetation and civilizations. Gas giants get banded jets, vortices and
cloud decks you can dive into.

Change anything — push a planet closer to its star, add CO₂, crash an asteroid into it, let a
civilization industrialize — and watch the climate respond.

## Highlights

- **Physical stars**: main sequence through giants, white dwarfs, neutron stars and black
  holes; blackbody colours; brown dwarfs that cool forever, so their habitable zones creep
  inward.
- **Climate on every world**: two-layer radiative–convective columns coupled by heat
  transport; gray-gas greenhouse effect (CO₂, H₂O, CH₄, NH₃, SO₂, CFCs, collision-induced
  absorption); clouds; Hadley cells, jets and ITCZ; hydrology with oceans, lakes, snow and
  glaciers; sea ice; CO₂/N₂ frost; storms and hurricanes; the carbonate–silicate cycle;
  atmospheric escape.
- **Model tiers by time speed**: full *weather* at slow speeds, *seasonal* means when faster,
  and a *simple* latitude-band energy-balance model for geological time scales.
- **Life and civilizations**: vegetation whose pigment matches the star's light (black plants
  under brown dwarfs, red under M dwarfs, green under the Sun) and changes albedo; biosphere
  oxygen and methane; civilizations that grow, burn fossil fuels, clear forests, warm their
  world — and can collapse because of it. City lights show up on night sides.
- **Impacts** release energy, heat the atmosphere, loft dust (impact winter) and **carve
  craters** into the procedural terrain.
- **Procedural worlds**: every surface — continents, plate boundaries, volcanoes, ice shells,
  dunes — is generated, never copied from real maps.
- **Create your own systems**: the ✨ *Create* button builds a procedural planetary system
  around any kind of star (Sun-like, K, M, ultracool, brown dwarf, white dwarf, binary). Planets
  form where physics puts them (rocky inside the snow line, giants beyond it), are spaced for
  long-term stability, and a guaranteed habitable world gets its CO₂ tuned against the climate
  model. *Design a planet* lets you set mass, orbit, spin, air, water, terrain, life and
  civilization by hand.
- **Rendering**: HDR with **human-eye adaptation** in *Realistic* mode (fly close to a star
  and everything else vanishes; on a planet's night side your eye adapts and the stars and
  Milky Way come out), an *Enhanced* mode that keeps everything visible, Milky Way / stars /
  black backgrounds, physically based atmospheric scattering (blue skies, red sunsets,
  Martian butterscotch), volumetric clouds, landing on rocky planets and diving through gas
  giant cloud decks.

## Scenarios

The Solar System today, Earth & Moon, TRAPPIST-1, a Proxima b eyeball world, twin suns,
Alpha Centauri, a hot Jupiter and lava world, Snowball Earth, Early Mars, Earth in a billion
years, a red-giant Sun, a rogue-star flyby, a starless rogue planet, a brown-dwarf habitable
zone, and an empty system to build from scratch. Challenges: terraform Mars, cool Venus,
escape Snowball Earth, keep a modern civilization below +2 °C, wake a frozen eyeball world,
and outlast the brightening Sun.

## Controls

| Input | Action |
| --- | --- |
| Drag / wheel / pinch | Orbit and zoom (zoom all the way in to land) |
| Double-click a body | Focus it |
| `L` | Land / take off (dive into a gas giant) |
| `W A S D`, `Q` `E`, `Shift` | Fly over a surface (`Shift` = fast) |
| `Space` | Pause (climb, when flying) |
| `,` `.` | Slower / faster time |
| `V` | Realistic ↔ Enhanced brightness |
| `M` | Climate map (click it to place a weather station) |
| `O` `N` | Orbits, names |
| `Del` | Delete the selected body |
| `H` | Help |

## Development

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

`npm run smoke` serves the app, drives a headless Chromium (software WebGL) through a set of
views — space, a landed sunrise, night skies, a gas-giant dive, a brown-dwarf system — and
writes screenshots to `smoke-out/`. It needs Playwright with Chromium installed.

Built with TypeScript, Three.js and Vite. Physics and climate code is plain TypeScript with no
rendering dependencies (see `src/physics`, `src/climate`, `src/stars`), covered by Vitest.

## Deploying

`.github/workflows/deploy.yml` tests, builds and publishes the site to GitHub Pages on every
push to `main`. Enable it once under **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

See [`docs/PLAN.md`](docs/PLAN.md) for the design notes behind the models.

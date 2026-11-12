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
- **Oceans, ice ages and drifting continents**: wind-driven ocean gyres with western boundary
  currents carry heat poleward; axial precession (≈26 kyr for Earth) shifts the seasons over
  millennia; on plate-tectonic worlds the continents drift ~5 cm/yr and collide over millions
  of years; volcanoes erupt (or set one off) and their sulfate haze cools the planet.
- **Evolution**: seed microbes on a wet world and watch the stages unfold over billions of
  years — methane-making microbes, oxygenic photosynthesis (a Great Oxidation Event, sometimes
  followed by a snowball), land plants, complex animals, and finally intelligence. Biomes
  (tundra, boreal and temperate forest, grassland, desert, savanna, rainforest) are mapped from
  the climate. Civilizations can adopt a carbon tax, geoengineer the stratosphere, wage nuclear
  war (nuclear winter), and settle other worlds of their system once they are spacefaring.
- **Civilizations with agency**: they react to their own warming (a carbon tax, then
  geoengineering), go carbon-free, shade or warm their home world as their star changes,
  terraform the best neighbouring planet (thicker air, greenhouse gases or sunshades, comet
  water, oxygen, life) and settle it, evacuate a dying home world, and finally send colony
  ships at 3% of light speed to other star systems — tick *Add a second star system* in
  ✨ Create, or load the *Reaching the stars* scenario.
- **Empires and war**: every civilization flies an empire's flag. Empires expand from world to
  world and star to star, meet when they share a star system, and grow wary or hostile. At war
  they bombard and invade each other's worlds, raid terraforming stations and send war fleets
  between the stars; worlds change hands, colonies break away, weary empires make peace and
  beaten ones fall. Diplomacy buttons in the Life tab let you declare war or make peace
  yourself; load *Rival empires* to watch it unfold.
- **Stars that live**: red dwarfs flare (rare superflares slowly erode close-in atmospheres).
- **Checked against the real Solar System**: a validation suite holds Earth (288 K, albedo
  0.30, 33 K of greenhouse warming, ~60% cloud, ~2.7 mm of rain a day), Venus, Mars, Titan,
  the Moon, Mercury, the Galilean moons and the giant planets to reference values, and checks
  that the climate comes out the same whether time runs slowly or fast.
- **Tides and giant impacts**: tides heat Io, lock close-in worlds, push the Moon outward by
  centimetres a year and lengthen the day; a glancing planet-sized impact leaves a moon behind.
- **Launch anything**: arm a toolbox item and *drag* to throw it — a preview line shows the
  orbit (or the escape, or the crash) before you let go. A plain click still gives a circular
  orbit.
- **Impacts** release energy, heat the atmosphere, loft dust (impact winter) and **carve
  craters** into the procedural terrain.
- **Procedural worlds**: every surface — continents, plate boundaries, volcanoes, ice shells,
  dunes — is generated, never copied from real maps.
- **Create your own systems**: the ✨ *Create* button builds a procedural planetary system
  around any kind of star (Sun-like, K, M, ultracool, brown dwarf, white dwarf, binary). Planets
  form where physics puts them (rocky inside the snow line, giants beyond it), are spaced for
  long-term stability, and a guaranteed habitable world gets its CO₂ tuned against the climate
  model. In the toolbox, **🎲 Random rocky** and **🎲 Random giant** drop a random planet onto a
  stable orbit around the current star (type, air and water follow from where it lands), and
  *Design a planet* lets you set everything by hand.
- **On the ground**: forests coloured by the star-matched pigment (turning in autumn), rain,
  snow and lightning from the local weather, aurorae over magnetized worlds, and eclipse
  shadows from moons and planets (with a copper-red lunar eclipse).
- **Rendering**: HDR with **human-eye adaptation** in *Realistic* mode (fly close to a star
  and everything else vanishes; on a planet's night side your eye adapts and the stars and
  Milky Way come out), an *Enhanced* mode that keeps everything visible, Milky Way / stars /
  black backgrounds, physically based atmospheric scattering (blue skies, red sunsets,
  Martian butterscotch), volumetric clouds, landing on rocky planets and diving through gas
  giant cloud decks. At night the eye dark-adapts in two stages and switches to rod vision:
  colours drain to a silvery blue, a full Moon lights the landscape, starlight and airglow
  barely do. Thick atmospheres scatter light many times: they look milky and soft-edged
  from space and veil the ground below.

## Scenarios

The Solar System today, Earth & Moon, TRAPPIST-1, a Proxima b eyeball world, twin suns,
Alpha Centauri, a hot Jupiter and lava world, Snowball Earth, Early Mars, Earth in a billion
years, a red-giant Sun, a rogue-star flyby, a starless rogue planet, a brown-dwarf habitable
zone, Reaching the stars, Rival empires, and an empty system to build from scratch. Challenges: terraform Mars, cool Venus,
escape Snowball Earth, keep a modern civilization below +2 °C, wake a frozen eyeball world,
and outlast the brightening Sun.

## Controls

| Input | Action |
| --- | --- |
| Drag / wheel / pinch | Orbit and zoom (zoom all the way in to land) |
| Double-click a body | Focus it |
| Toolbox item, then click / drag | Place on a circular orbit / launch with your own velocity |
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

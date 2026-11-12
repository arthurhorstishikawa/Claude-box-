# Aeolus — Planetary Climate Sandbox: Design Plan

A browser-based space sandbox in the spirit of "universe simulators", but built around one
idea: **every world has weather and climate**. Move a planet, change its star, add CO₂,
smash a moon into it — and watch oceans freeze, deserts spread, hurricanes form, or the
oceans boil away.

## 1. Platform & stack

| Concern      | Choice                                                              |
| ------------ | ------------------------------------------------------------------- |
| Language     | TypeScript (strict)                                                 |
| Rendering    | Three.js (WebGL2), custom GLSL shaders, logarithmic depth, bloom    |
| Build/dev    | Vite                                                                |
| Tests        | Vitest (physics + climate calibration), Playwright smoke/screenshot |
| UI           | Vanilla TS + CSS (no framework), canvas charts/maps                 |
| Hosting      | GitHub Pages via Actions (`.github/workflows/deploy.yml`)           |

Everything is simulated in SI units with float64 on the CPU. Rendering uses a floating
origin (camera-relative positions) so a 1 km detail and a 40 AU orbit coexist without jitter.

## 2. Architecture

```
src/
  core/      constants, vectors, noise, RNG, formatting
  data/      Solar-System physical/orbital data
  physics/   bodies, N-body + Kepler integrators, orbits, collisions, mass-radius
  stars/     stellar evolution, blackbody colour/spectra, habitable zones
  climate/   terrestrial climate model, circulation, storms, gas-giant model, terrain, biomes
  sim/       simulation orchestration, scenarios, challenges, save/load
  render/    Three.js scene, camera, body views + shaders, orbits, labels, particles
  ui/        panels, inspector, map view, charts, toolbox, notifications
```

The simulation is fully headless (testable in Node). The renderer and UI only read state
and issue commands.

## 3. Physics

### Gravity
* **N-body** leapfrog (kick-drift-kick) with an adaptive global step chosen from the tightest
  pair (`η·sqrt(r³/GM)` and `r/v_rel`), sub-stepped inside a per-frame work budget.
* **Kepler mode** for extreme time warps (millions–billions of years per second): bodies ride
  analytic orbits in a hierarchy (moon → planet → star, circumbinary planets around the binary
  barycentre). Star mass loss widens orbits adiabatically (`a·M = const`). The game switches
  automatically and shows which mode is active.
* Collisions merge bodies (momentum conserved), convert impact energy into heat (magma
  oceans, impact winters, steam atmospheres), deliver water from icy impactors and spawn
  debris. Roche-limit crossings shred bodies into rings.
* **Impacts leave craters**: crater size from pi-scaling laws (impactor size, speed, density,
  target gravity), carved into the target's terrain at the true impact point (bowl, rim, central
  peak, ejecta blanket and bright rays), with a glowing melt sheet that cools, local heating,
  vaporised ocean water, and dust/soot "impact winters" for large events. Planet-scale impacts
  resurface the world into a magma ocean. Craters are saved with the system.
* Tidal heating (Io-style) feeds a planet's internal heat flux; tidal locking is supported.
* **Tidal evolution**: tides raised on the primary move its satellites (outward when they
  orbit slower than the primary spins, inward otherwise) and exchange angular momentum with
  the primary's spin: the Moon recedes at a few cm/yr and Earth's day lengthens. Stellar mass
  loss widens orbits adiabatically in both gravity modes.
* **Giant impacts make moons**: an oblique collision between a rocky planet and a body of at
  least 2% of its mass leaves part of the debris in orbit as a new moon and resets the planet's
  spin from the impact's angular momentum.
* Mass–radius relations per class (rocky, ice giant, gas giant, brown dwarf, star, white
  dwarf, neutron star, black hole). Gaining mass can turn a gas giant into a brown dwarf or
  ignite it as a star.

### Stars
* Main-sequence relations (L, R, Teff vs mass) with brightening over the main sequence
  (the faint young Sun is 30% dimmer).
* Post-main-sequence tracks: subgiant → red giant → helium burning → AGB → planetary nebula
  → white dwarf cooling; massive stars: supergiant → core-collapse supernova → neutron
  star/black hole. Mass loss, engulfment of inner planets and supernova blast/fluence
  (atmosphere stripping, vaporisation) are simulated.
* Blackbody colours from CIE colour-matching functions; spectral fractions drive physics
  (Rayleigh scattering strength and ice albedo depend on the star's colour — ice is darker
  under red dwarfs). XUV luminosity (saturated when young) drives atmospheric escape.
* Habitable-zone limits (Kopparapu et al. 2013) are drawn around every star.

## 4. Climate & weather (the core)

Every rocky world (planets, moons, dwarf planets) runs a **gridded latitude–longitude climate
model**; the focused world runs at high resolution, others at lower resolution with a
round-robin CPU budget so dozens of worlds stay live.

Per cell: surface temperature, atmosphere/deep temperature (two heat reservoirs), water vapour,
clouds, precipitation, snow/land ice, sea ice, soil moisture, vegetation, CO₂/N₂ frost, winds,
pressure anomaly.

* **Radiation**: insolation from every star with correct geometry (spin axis, obliquity,
  seasons, day/night, eclipses), adapting to the time step (instantaneous → daily mean →
  annual mean). Albedo from oceans, land, vegetation, snow, sea ice, clouds, Rayleigh
  scattering, hazes and sulfuric cloud decks. Gray-atmosphere greenhouse
  (`Ts⁴ ≈ Te⁴(1 + ¾τ)`) with τ from CO₂, H₂O, CH₄, NH₃, SO₂, H₂ collision-induced absorption,
  engineered gases and clouds, calibrated on Earth, Venus, Mars and Titan.
* **Water vapour feedback & runaway greenhouse**: moist atmospheres cannot radiate more than
  ~282 W/m², so a planet pushed too close to its star boils its oceans into a steam
  atmosphere and then loses water to space.
* **Heat transport**: implicit (ADI) diffusion — stable at any time step — with a diffusivity
  that scales with atmospheric mass, gravity, molecular weight and rotation rate (slow
  rotators like Venus are nearly isothermal; tidally locked thin atmospheres collapse).
  Ocean heat transport in a slab ocean.
* **Circulation**: Hadley-cell width from Held–Hou theory (1 cell on Venus/Titan, 3 on
  Earth, more on fast rotators), ITCZ following the thermal equator, trade winds, westerlies,
  thermal lows/highs (monsoons), frictional-geostrophic winds, superrotation, day→night flow on
  tidally locked worlds.
* **Hydrology**: evaporation (bulk formula), Clausius–Clapeyron saturation, condensation with
  orographic rain shadows, rain vs snow, snowmelt, glaciers that flow, sea ice thermodynamics,
  soil moisture, runoff, and **sea level from water conservation** (ice ages expose land
  bridges). Titan runs a methane cycle with the same machinery. Mars-style CO₂ frost caps and
  seasonal pressure cycles, Pluto/Triton N₂ frost, atmospheric collapse.
* **Consistency across time speeds**: the three model tiers share one calibration, and the
  step-size dependent pieces are corrected for (the sun moves across the sky within long steps,
  evaporation uses day-averaged sunlight, vapour is transported before it condenses, the band
  model has its own cloud diagnosis and equilibrium sea ice). The tier follows the *typical*
  step length with hysteresis, long seasonal steps are split so the seasons stay resolved, and
  when the band model takes over from the full model it starts from the annual-mean pattern
  and carries a per-band flux adjustment, so warping time continues the same climate instead
  of drifting to the band model's own. `tests/validation.test.ts` holds
  the Solar System to reference values (Earth's temperature, albedo, greenhouse effect, cloud
  cover, rainfall and ice; Venus, Mars, Titan, the Moon, Mercury, the Galilean moons, the
  giants; Io's tidal heat; precession; lunar recession) and checks that half-day and week-long
  steps agree, that the hand-over to the band model keeps the temperature, and that uneven
  step lengths do not ratchet the planet into an ice age.
* **Weather systems**: tropical cyclones (genesis over warm oceans, potential intensity,
  steering, landfall decay, hypercanes on hot worlds), extratropical cyclones in baroclinic
  zones, Martian dust storms, long-lived gas-giant vortices.
* **Long-term**: carbonate–silicate weathering thermostat (snowball Earth escape over Myr),
  volcanic outgassing, energy-limited atmospheric escape, magma oceans after giant impacts,
  dynamic vegetation, biome classification.
* **Gas giants**: zonal jets from the Rhines scale, banded clouds coloured by Sudarsky class
  (ammonia → water → clear → alkali → silicate), internal heat, radiative-timescale-controlled
  day/night contrast with hot-spot offsets on hot Jupiters, persistent vortices.
* **Habitability**: per-cell liquid-water habitability, "shirt-sleeve" human habitability
  (O₂, CO₂, T, P), Earth Similarity Index.

### Procedural worlds
All terrain is procedural and seeded — no real-world maps. Earth-like worlds use a
plate-tectonics recipe (continental/oceanic plates, collision mountain belts, coastal ranges and
trenches, island arcs, mid-ocean ridges, rifts, continental shelves). Other recipes: Mars-like
(hemispheric dichotomy, shield-volcano province, impact basins, canyon systems), cratered
(Moon/Mercury with maria), icy (cracked Europa-like, cratered Ganymede/Callisto-like), Venus-like
volcanic plains with highland blocks, Io-like volcanic, Titan-like dunes and polar basins,
Pluto-like ice plains. Sea level (and therefore coastlines) follows from the water inventory
and the generated hypsometry. Any world's terrain can be re-rolled from the inspector.

## 5. Rendering

* **HDR with eye adaptation.** *Realistic* mode uses physical brightness (lighting ∝ real flux,
  star surfaces at true radiance) and auto-exposure measured from the frame: approach a star and
  everything else vanishes in the glare; on a planet's night side the eye adapts and distant
  stars and the Milky Way appear. *Enhanced* mode compresses the range so everything stays visible.
* **Night vision.** Dark adaptation has two stages (cones within seconds, then the slower rods).
  A final pass blends each pixel from full colour to blue-grey rod vision by its absolute
  luminance (cones fade below ~1 cd/m², rods alone below ~0.005 cd/m²; scotopic luminance after
  Larson et al. 1997), so a moonlit landscape looks silvery-blue rather than like a dim day.
* **Night light.** Starlight and airglow (~2·10⁻⁸ of sunlight), and moonlight: the brightest moon
  or planet seen from the world you are on is added as a second light, with its phase (Lambert
  sphere) and albedo: a full Moon gives ~2·10⁻⁶ of sunlight (~0.25 lux).
* **Twilight.** After sunset the air in the planet's shadow is lit by light scattered twice in
  the still-sunlit upper air. Sky, ground skylight and clouds follow measured twilight: the sky
  dims ~300× from −6° to −12° solar elevation (≈1° per e-fold; zenith ~3 cd/m² at −6°, ~0.01 at
  −12°, night by −18°), brighter toward the sunset, with the Earth's shadow rising opposite.
* **Backgrounds:** procedural starfield + Milky Way, stars only, or pure black.
* **Physically based atmospheric scattering** (Rayleigh + Mie single scattering, ray-marched)
  from space and from inside: blue skies, red sunsets, butterscotch Martian skies with blue
  sunsets, orange Titan haze, aerial perspective on terrain. Optically thick air adds a
  multiple-scattering glow (an isotropic source from the diffuse light field, two-stream
  attenuated), which turns thick atmospheres milky and veils the ground; the haze is drawn up
  to where it is too thin to see edge-on, so thick atmospheres have soft, extended limbs.
  Earth-like air (vertical optical depth ≲ 0.4) is unchanged. Trees, clouds and ground share
  the same lighting (no sun below the horizon, reddened sunlight, skylight, aerial perspective).
* **Water and coasts:** oceans mirror the sky with Fresnel reflection (2% looking down, nearly
  all at grazing angles; blue sky, grey overcast, dark at night), carry three octaves of
  animated waves (swell, wind waves, chop) that fade before they alias, show sandy bottoms in
  the shallows and surf on the last metres before the shore. Beaches line gentle coasts; steep
  slopes and cliffs are bare rock. Volumetric clouds take more ray-march steps when seen from
  inside or below the layer, with wider per-pixel jitter, so grazing views do not band.
* **Land on rocky worlds:** quadtree LOD terrain (cube-sphere patches displaced on the GPU from the
  procedural elevation + detail noise), ocean surface, flight/walk camera near the ground.
* **Fly into clouds:** volumetric cloud layers ray-marched from the live climate cloud field on
  rocky planets; on gas giants you can descend through the ammonia, NH₄SH and water cloud decks
  into the deep murk (with pressure/temperature readouts). Distant views use cheaper cloud shells.

* Terrestrial planets: GPU-composed surface from elevation + live climate fields (oceans, sea
  ice, snow, vegetation, deserts, lava), bump-mapped terrain, specular oceans, cloud layer
  driven by the model (moving with the winds, storms rendered as spirals), physically-inspired
  atmospheric scattering coloured by composition and star colour, eclipse shadows.
* Gas giants: procedural turbulent bands, vortices, ring systems with shadows, thermal glow.
* Stars: granulation, limb darkening, sunspots, corona and bloom; white dwarfs, neutron stars
  with pulsar beams, black holes with gravitational lensing.
* Starfield + Milky Way, orbit paths and trails, habitable-zone rings, labels, debris and
  supernova effects, animated wind particles on the globe.
* Data layers on the globe and a 2D map: temperature, precipitation, clouds, wind, pressure
  (isobars), ice, biomes, habitability, insolation, elevation.

## 6. Gameplay

* **Sandbox tools**: add stars/planets/moons/asteroids/comets/black holes by clicking in the
  scene (auto circular orbit), edit mass, orbit, spin, tilt, atmosphere gases, water, internal
  heat, sunshades/mirrors; seed life; bombard with comets; delete/duplicate.
* **Time**: pause to 1 Gyr per second, automatic integrator switching.
* **Scenarios**: Solar System (today), Earth & Moon, TRAPPIST-1, Proxima b eyeball world,
  twin suns, Alpha Centauri, hot Jupiter & lava world, Snowball Earth, early Mars, Earth in a
  billion years, red-giant Sun, rogue star flyby, starless rogue planet, brown-dwarf habitable
  zone, reaching the stars, rival empires, empty system.
* **Custom systems** (✨ Create): choose a star (G, K, M, ultracool, brown dwarf, F, A, white
  dwarf, close binary) and generate a planetary system: period ratios of ~1.4–2.4, rocky
  worlds inside the snow line, giants beyond it (rarer around small stars), ice giants and icy
  dwarfs farther out, moons inside 0.35 Hill radii, an optional belt. Neighbours are spaced at
  least 8–10 mutual Hill radii apart for long-term stability. A guaranteed habitable world is
  placed at the Earth-equivalent flux for the star's spectrum, and its CO₂ is tuned by
  geometric bisection against the climate model (a stand-in for the carbonate–silicate
  thermostat). **🎲 Random rocky / giant** adds one random planet to the current system on an
  orbit ≥ 8–10 mutual Hill radii from its neighbours; **Design a planet** sets mass, orbit,
  spin, tilt, air, water, terrain, life and civilization by hand.
* **Brown dwarfs** have habitable zones too: they glow from contraction heat and fade as
  L ∝ age^−1.3, so their zones (and worlds' climates) slide inward over time. White dwarfs
  likewise. HZ rings, inspector values and a "zone in 1 Gyr" readout show it.
* **City lights** are the lit urban fraction of land (urban dwellers × ~380 m² of lit ground
  each), rendered as clusters at metro, town and street scales whose mean matches that
  fraction — not a continent-wide glow.
* **Challenges**: terraform Mars, cool Venus, escape Snowball Earth, save Earth from the
  brightening Sun, make an eyeball world habitable. Objectives must be sustained for a
  period of simulated time.
* **Empires and war.** Every civilization belongs to an empire (name, flag colour, capital,
  temperament). Colonies keep their founders' flag; colonies in other star systems may declare
  independence. Empires *present* in the same star system (worlds, or settlers terraforming in
  orbit) make contact; tension then drifts with their temperaments, rises by a step whenever
  one settles or terraforms in the other's system, and decays through diplomacy. Above a
  threshold the more warlike side declares war. In war, armed worlds bombard enemy worlds of
  the same system (casualties ∝ relative strength, dust that cools the climate, rare all-out
  strikes = nuclear winter), raid enemy terraforming stations, and invade worlds they
  overwhelm 4:1; interstellar empires send war fleets at 3% c, which conquer a world if 1.5×
  stronger or are destroyed inflicting losses. Strength = population × technology. Losses
  breed war-weariness; peace follows when both are weary, one is beaten, or after 400 years of
  stalemate. Empires with no worlds left fall. An invasion must overcome the whole system's
  defence (the world plus half the armed strength of its owner's other worlds there); the
  conquerors leave a garrison that fades over ~two centuries, and a newly occupied world cannot
  change hands again for 80 years — so conquests stick instead of flipping back and forth. Terraformed colonies keep steering their own
  climate (mirrors, sunshades, CO₂ drawdown), and hopeless projects are abandoned after 3000
  years. The Life tab shows the empire, its relations and diplomacy buttons; labels carry
  flags (⚔ at war); fleets are drawn in red. Scenario *Rival empires*.
* **Analysis**: weather stations (click the map), time-series charts, climate diagrams.
* **Save/load** to browser storage and JSON files.

## 7. Milestones

1. Scaffold, plan, constants, maths, noise.
2. Physics core (N-body, Kepler mode, collisions, classification) + tests.
3. Stars (evolution, colour, HZ) + tests.
4. Climate model (terrestrial + gas giant + storms + hydrology) + calibration tests.
5. Simulation orchestration + scenarios + challenges.
6. Renderer, shaders, effects.
7. UI (toolbox, inspector, time bar, map, charts, notifications, help, settings).
8. Headless browser smoke tests & screenshot review; performance tuning.
9. README, Pages deployment.
10. Custom system generator, planet designer, brown-dwarf habitable zones.

## 8. Future ideas

Web Worker climate, ocean currents (gyres), Milankovitch secular perturbations, plate
tectonics, multiplayer sharing of systems, VR.

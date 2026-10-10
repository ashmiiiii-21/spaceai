# AstraPlan

AI-based intelligent space mission planning, launch vehicle selection and digital mission simulation.
B.Tech final-year project — team: Sathya Narayan, Ashmita P S, Pavithra Rajendran, Sreya Lekshmi. Guide: Ms Aswathy T K.

Base paper: Pirayeshshirazinezhad et al., "Designing Monte Carlo Simulation and an Optimal Machine Learning to Optimize and Model Space Missions", IEEE Access, 2022.

## What the app does

Six modules, run as one pipeline, entirely in the browser (no server, no build step):

1. **Mission input** – payload, orbit, lifetime, budget, required success probability, objective weights. Seven sample missions.
2. **Physics engine** – Hohmann transfers, plane changes, rocket equation, exponential atmosphere and drag decay, J2 nodal drift, eclipse geometry, solar array and battery sizing, parametric mass and cost models, launch vehicle capacity curves for 10 vehicles.
3. **Monte Carlo engine** – thousands of sampled missions (mass growth, Isp, solar activity, degradation, cost growth, schedule slip, launch and bus failures) → success probability, cost P50/P90, failure causes, sensitivity.
4. **Optimisation + ML** – simulated annealing over vehicle, propulsion, altitude, inclination, array oversizing and propellant margin; Pareto front; three surrogate models (DNN, Gaussian process, SVR) trained on optimiser-labelled synthetic missions.
5. **Recommendation & XAI** – ranked alternatives, additive score decomposition, exact Shapley values from the cost surrogate, counterfactuals, plain-language narrative.
6. **Digital mission simulation** – phased timeline (ascent, transfer burns or electric spiral, commissioning, operations with eclipse cycles and station keeping, disposal) with live telemetry; Earth, cislunar, heliocentric and Mars views.
7. **Final analysis** – system outputs (launch vehicle, orbit, configuration, cost, risk, performance) and export.

## Files

- `index.html` – the page
- `css/style.css` – styles (dark and light themes)
- `js/data.js` – mission database: launch vehicles, propulsion, orbits, presets, atmosphere
- `js/physics.js` – physics engine
- `js/engines.js` – evaluator, cost, risk, Monte Carlo, optimiser, ML surrogates, XAI
- `js/charts.js` – canvas chart library
- `js/sim.js` – digital mission simulation
- `js/app.js` – UI and pipeline orchestration
- `vercel.json` – Vercel settings

## Run locally

Double-click `index.html`, or run `npx serve .` in this folder and open http://localhost:3000.

## Host on Vercel

1. Push this folder (with `index.html` at the top level) to a GitHub repository.
2. In Vercel: Add New → Project → import the repository.
3. Framework preset **Other**, no build command, output directory empty. Deploy.

## Deep links

Add `#geo`, `#mars`, `#moon`, `#cube`, `#nav`, `#leo` or `#eo` to the URL to open a sample mission, or `#sim`, `#rec` etc. to open a page.

## Honest limits

Launch vehicle figures are approximate public values for preliminary design, not quotes. Mass, power and cost are parametric (pre-Phase A). Transfers are impulsive two-body manoeuvres; no launch windows or n-body effects.

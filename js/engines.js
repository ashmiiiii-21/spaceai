/* =========================================================================
   AI ENGINES
   evaluate()      full design evaluation: physics → cost → risk → performance → score
   monteCarlo()    uncertainty & mission risk analysis
   optimize()      simulated annealing + exhaustive seed + Pareto front
   ml              dataset generation, DNN, Gaussian process, SVR surrogates
   xai             score decomposition, exact Shapley values, counterfactuals
   ========================================================================= */
(function () {
  var P = MP.physics, C = MP.CONST;
  var E = MP.engine = {};

  /* ---------- seeded random ---------- */
  E.rng = function (seed) {
    var s = seed >>> 0 || 1;
    var r = function () { s += 0x6D2B79F5; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    r.gauss = function () { var u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    r.tri = function (a, b, c) { var u = r(), f = (c - a) / (b - a); return u < f ? a + Math.sqrt(u * (b - a) * (c - a)) : b - Math.sqrt((1 - u) * (b - a) * (b - c)); };
    r.pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    return r;
  };
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  E.clamp = clamp;

  E.PROP_NONE = { id: 'none', name: 'No propulsion', isp: 0, baseMass: 0, tankFrac: 0, cost: 0, pFail: 0, maxDv: 0, impulsive: true };
  E.props = function () { return [E.PROP_NONE].concat(MP.PROPULSION); };
  E.vehicle = function (id) { for (var i = 0; i < MP.VEHICLES.length; i++) if (MP.VEHICLES[i].id === id) return MP.VEHICLES[i]; return null; };
  E.prop = function (id) { var ps = E.props(); for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; };

  /* ---------- cost model (USD millions) ---------- */
  E.cost = function (m, v, prop, mass, drop, pert) {
    pert = pert || {};
    var cls = m.orbit, o = MP.ORBITS[cls], t = MP.MISSION_TYPES[m.type], deep = cls === 'LUNAR' || cls === 'MARS';
    var g = pert.cost || 1;
    var payload = 0.15 * m.payload * t.costMult * g;
    var bus = 0.08 * Math.pow(mass.bus - (mass.sub.propulsionDry || 0), 0.95) * (deep ? 1.8 : 1) * (1 + 0.25 * (o.env - 1)) * g;
    var propulsion = prop.cost * (1 + mass.prop / 300) * g;
    var ait = 0.12 * (payload + bus + propulsion);
    var launch = v.rideshare ? Math.max(v.minCharge, v.perKg * mass.wet) : v.price;
    var cruiseYrs = cls === 'MARS' ? 0.75 : 0;
    var slipYrs = (pert.slipMonths || 0) / 12;
    var ops = (0.4 + 0.0015 * mass.dry) * o.opsCost * (m.life + cruiseYrs + slipYrs * 0.5);
    var insurance = 0.07 * (launch + payload + bus + propulsion);
    var pm = 0.10 * (payload + bus + propulsion + ait);
    var total = payload + bus + propulsion + ait + launch + ops + insurance + pm;
    return { payload: payload, bus: bus, propulsion: propulsion, ait: ait, launch: launch, ops: ops, insurance: insurance, pm: pm, total: total };
  };

  /* ---------- risk model ---------- */
  E.LAMBDA = { LEO: 0.015, SSO: 0.015, MEO: 0.009, GEO: 0.008, LUNAR: 0.04, MARS: 0.05 };
  var Phi = function (z) { var t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z >= 0 ? 1 - p : p; };
  E.risk = function (m, v, prop, drop, ep, transferMonths, massMargin) {
    var cls = m.orbit, o = MP.ORBITS[cls];
    var pLaunch = v.reliability;
    // probability that mass growth during development stays inside the launch margin (growth ≈ N(11%, 7.5%))
    var pGrowth = massMargin == null ? 1 : massMargin <= 0 ? 0.01 : Phi((massMargin - 0.11) / 0.075);
    var pDeploy = 0.985;
    var pProp = prop.id === 'none' ? 1 : 1 - prop.pFail * (1 + (ep ? transferMonths / 12 * 0.15 : 0));
    var lam = E.LAMBDA[cls];
    var pBus = Math.exp(-lam * m.life);
    var pTransfer = cls === 'MARS' ? 0.96 : cls === 'LUNAR' ? 0.97 : 1;
    var pTotal = pLaunch * pDeploy * pProp * pBus * pTransfer * pGrowth;
    return { pLaunch: pLaunch, pDeploy: pDeploy, pProp: pProp, pBus: pBus, pTransfer: pTransfer, pGrowth: pGrowth, pTotal: pTotal, lambda: lam,
      factors: [['Launch success (' + v.name + ')', pLaunch], ['Mass growth within launch margin', pGrowth], ['Deployment & early operations', pDeploy], ['Propulsion system', pProp],
                ['Bus survival over ' + m.life + ' yr', pBus]].concat(pTransfer < 1 ? [['Deep-space cruise & insertion', pTransfer]] : []) };
  };

  /* ---------- performance score 0..1 ---------- */
  E.perf = function (m, pw, dragInfo, dvMargin) {
    var cls = m.orbit, o = MP.ORBITS[cls];
    var sPm = clamp(0.5 + pw.margin, 0, 1);
    var sLife = (cls === 'LEO' || cls === 'SSO') ? clamp(dragInfo.lifetime / (1.5 * m.life), 0, 1) : 1;
    var sDv = clamp(0.5 + dvMargin, 0, 1);
    var sEnv = clamp(1.4 - o.env * 0.5, 0, 1);
    var r = C.RE + m.alt, parts;
    switch (m.type) {
      case 'eo': { var sAlt = clamp((900 - m.alt) / 600, 0, 1), sCov = cls === 'SSO' ? 1 : clamp(m.inc / 90, 0, 1);
        parts = [['Ground resolution (altitude)', 0.45, sAlt], ['Global coverage (inclination)', 0.25, sCov], ['Power margin', 0.2, sPm], ['Orbit lifetime', 0.1, sLife]]; break; }
      case 'comms': { var sC = cls === 'GEO' ? 1 : P.isEarthBound(cls) ? clamp(((1 - C.RE / r) / 2) / 0.42, 0, 1) : 0.3;
        parts = [['Coverage footprint', 0.5, sC], ['Power margin', 0.3, sPm], ['Orbit lifetime', 0.2, sLife]]; break; }
      case 'nav': { var sN = cls === 'MEO' ? clamp(1 - Math.abs(m.alt - 22000) / 15000, 0, 1) : 0.2;
        parts = [['Constellation geometry (MEO altitude)', 0.5, sN], ['Power margin', 0.3, sPm], ['Orbit lifetime', 0.2, sLife]]; break; }
      case 'sci': parts = [['Power margin', 0.4, sPm], ['Benign radiation environment', 0.3, sEnv], ['Orbit lifetime', 0.3, sLife]]; break;
      case 'tech': parts = [['Power margin', 0.5, sPm], ['Orbit lifetime', 0.5, sLife]]; break;
      default: parts = [['Power margin', 0.4, sPm], ['Orbit lifetime', 0.3, sLife], ['Δv margin', 0.3, sDv]];
    }
    var score = 0; parts.forEach(function (p) { score += p[1] * p[2]; });
    return { score: score, parts: parts };
  };

  /* ---------- full evaluation ---------- */
  E.DEFAULT_WEIGHTS = { cost: 0.4, risk: 0.35, perf: 0.25 };
  /* design = {vehicle, prop, alt, inc, arrayOversize, propMargin}; pert = Monte Carlo perturbations */
  E.evaluate = function (mission, design, weights, pert) {
    weights = weights || E.DEFAULT_WEIGHTS; pert = pert || {};
    var v = E.vehicle(design.vehicle), prop = E.prop(design.prop);
    var m = Object.assign({}, mission, { alt: design.alt != null ? design.alt : mission.alt, inc: design.inc != null ? design.inc : mission.inc, arrayOversize: design.arrayOversize || 1 });
    if (m.orbit === 'SSO') m.inc = P.ssoInc(m.alt);
    if (m.orbit === 'GEO') { m.alt = 35786; m.inc = 0; }
    var r = { mission: m, vehicle: v, prop: prop, violations: [], feasible: true };
    var drop = P.capacity(v, m); r.drop = drop;
    if (!drop.feasible) { r.feasible = false; r.violations.push({ k: 'vehicle', msg: v.name + ': ' + drop.reason, w: 5 }); }
    var activity = pert.activity || 1.0;
    var ep = !prop.impulsive;
    // first pass mass estimate for drag with payload scaling
    var pw = P.powerBudget(m, prop, pert);
    var est = m.payload * 3.5;
    var drag = (m.orbit === 'LEO' || m.orbit === 'SSO') ? { dvPerYear: P.dragAccel(m.alt, est, activity) * C.YEAR, lifetime: P.lifetime(m.alt, est, activity) } : { dvPerYear: 0, lifetime: 1e4 };
    var dv = P.dvBudget(m, v, prop, drop, drag);
    var dvNeed = prop.id === 'none' ? 0 : dv.total * (1 + (design.propMargin || 0));
    var dvReq = dv.required;
    if (prop.id === 'none' && dvReq > 1) { r.feasible = false; r.violations.push({ k: 'prop', msg: 'Mission needs ' + Math.round(dvReq) + ' m/s but no propulsion fitted', w: 4 }); }
    if (prop.id !== 'none' && dvNeed / 1000 > prop.maxDv) { r.feasible = false; r.violations.push({ k: 'prop', msg: prop.name + ' cannot provide ' + Math.round(dvNeed) + ' m/s', w: 4 }); }
    var mass = P.massBudget(m, prop, dvNeed, pw, pert); r.mass = mass;
    // refine drag with real mass
    if (m.orbit === 'LEO' || m.orbit === 'SSO') { drag = { dvPerYear: P.dragAccel(m.alt, mass.wet, activity) * C.YEAR, lifetime: P.lifetime(m.alt, mass.wet, activity), bc: mass.wet / (2.2 * P.dragArea(mass.wet)) }; dv = P.dvBudget(m, v, prop, drop, drag); dvNeed = prop.id === 'none' ? 0 : dv.total * (1 + (design.propMargin || 0)); }
    r.drag = drag; r.dv = dv; r.dvLoaded = dvNeed; r.power = pw;
    if ((m.orbit === 'LEO' || m.orbit === 'SSO') && drag.lifetime < m.life && !dv.skRequired) { r.feasible = false; r.violations.push({ k: 'orbit', msg: 'Orbit decays in ' + drag.lifetime.toFixed(1) + ' yr, before the ' + m.life + ' yr mission', w: 3 }); }
    if ((m.orbit === 'LEO' || m.orbit === 'SSO') && prop.id === 'none' && drag.lifetime < m.life) { r.feasible = false; r.violations.push({ k: 'orbit', msg: 'No propulsion: orbit decays in ' + drag.lifetime.toFixed(1) + ' yr', w: 3 }); }
    // capacity
    var massMargin = drop.feasible ? (drop.cap - mass.wet) / drop.cap : -1; r.massMargin = massMargin;
    if (drop.feasible && mass.wet > drop.cap) { r.feasible = false; r.violations.push({ k: 'mass', msg: 'Wet mass ' + Math.round(mass.wet) + ' kg exceeds ' + v.name + ' capacity ' + Math.round(drop.cap) + ' kg', w: 3 + 3 * (mass.wet / drop.cap - 1) }); }
    else if (drop.feasible && massMargin < 0.05) r.violations.push({ k: 'mass', msg: 'Launch mass margin only ' + (massMargin * 100).toFixed(0) + '% (10% recommended)', w: 0.5 });
    if (mass.diameter > v.fairing * 0.9) { r.feasible = false; r.violations.push({ k: 'fairing', msg: 'Spacecraft ~' + mass.diameter.toFixed(1) + ' m does not fit ' + v.fairing + ' m fairing', w: 3 }); }
    // EP transfer time
    var transferMonths = 0;
    if (ep && drop.dvSc > 0) { var F = 0.06 * pw.pEP / 1000; var mAvg = mass.wet - mass.prop * 0.4; transferMonths = (mAvg * drop.dvSc * 1000 * 1.3 / F) / 86400 / 30.4; r.transferDays = transferMonths * 30.4;
      if (transferMonths > 12) r.violations.push({ k: 'transfer', msg: 'Electric orbit raising takes ' + transferMonths.toFixed(0) + ' months', w: 0.5 + (transferMonths - 12) / 12 }); }
    else r.transferDays = drop.days;
    // cost, risk, perf
    var cost = E.cost(m, v, prop, mass, drop, pert); r.cost = cost;
    var risk = E.risk(m, v, prop, drop, ep, transferMonths, drop.feasible ? massMargin : null); r.risk = risk;
    var dvMargin = prop.id === 'none' ? 0 : (dvNeed - dv.required) / Math.max(dv.required, 1);
    var perf = E.perf(m, pw, drag, dvMargin); r.perf = perf;
    if (cost.total > m.budget) r.violations.push({ k: 'budget', msg: 'Cost $' + cost.total.toFixed(0) + 'M exceeds budget $' + m.budget + 'M', w: 1 + 2 * (cost.total / m.budget - 1) });
    if (risk.pTotal < m.minP) r.violations.push({ k: 'risk', msg: 'Success probability ' + (risk.pTotal * 100).toFixed(1) + '% below required ' + (m.minP * 100).toFixed(0) + '%', w: 1 + 4 * (m.minP - risk.pTotal) });
    // score (lower is better)
    var terms = {
      cost: weights.cost * cost.total / m.budget,
      risk: weights.risk * (1 - risk.pTotal) / Math.max(1 - m.minP, 0.05),
      perf: weights.perf * (1 - perf.score),
      penalty: 0
    };
    r.violations.forEach(function (x) { terms.penalty += x.w; });
    r.terms = terms; r.score = terms.cost + terms.risk + terms.perf + terms.penalty;
    r.design = Object.assign({}, design, { alt: m.alt, inc: m.inc });
    r.key = design.vehicle + '|' + design.prop + '|' + Math.round(m.alt) + '|' + m.inc.toFixed(1) + '|' + (design.arrayOversize || 1).toFixed(2) + '|' + (design.propMargin || 0).toFixed(2);
    r.label = v.name + ' + ' + prop.name;
    return r;
  };

  /* ---------- Monte Carlo ---------- */
  E.monteCarlo = function (mission, design, weights, n, seed, onProgress, done) {
    var rnd = E.rng(seed || 7), runs = [], i = 0, chunk = 200;
    var base = E.evaluate(mission, design, weights);
    var step = function () {
      var end = Math.min(n, i + chunk);
      for (; i < end; i++) {
        var pert = {
          payload: 1 + 0.08 * rnd.gauss(),
          bus: 1 + rnd.tri(0, 0.25, 0.08),
          isp: 1 + 0.02 * rnd.gauss(),
          activity: rnd.pick([0.5, 1, 1, 2.5]),
          degr: 1 + 0.2 * rnd.gauss(),
          cost: Math.exp(0.2 * rnd.gauss()),
          slipMonths: -4 * Math.log(1 - rnd()),
          inj: Math.abs(rnd.gauss())
        };
        var ev = E.evaluate(mission, design, weights, pert);
        var u = rnd(), outcome = 'success', failYear = null;
        var massOver = ev.drop.feasible && ev.mass.wet > ev.drop.cap;
        var propShort = ev.prop.id !== 'none' && (base.dvLoaded < ev.dv.required * (1 + 0.02 * (pert.inj > 3 ? pert.inj - 3 : 0)));
        var powerShort = ev.power.margin < -0.05;
        var life = mission.life, lam = ev.risk.lambda;
        if (massOver) outcome = 'redesign: over launch capacity';
        else if (u > ev.risk.pLaunch) outcome = 'launch failure';
        else if (rnd() > ev.risk.pDeploy) outcome = 'deployment failure';
        else if (rnd() > ev.risk.pProp) outcome = 'propulsion failure';
        else if (ev.risk.pTransfer < 1 && rnd() > ev.risk.pTransfer) outcome = 'lost during cruise / insertion';
        else if (propShort) outcome = 'propellant shortfall';
        else if (powerShort) outcome = 'power shortfall';
        else { var tf = -Math.log(1 - rnd()) / lam; if (rnd() < 0.02) tf = Math.min(tf, 0.25); if (tf < life) { outcome = 'bus failure in orbit'; failYear = tf; } }
        if (outcome === 'success' && (mission.orbit === 'LEO' || mission.orbit === 'SSO') && ev.prop.id === 'none' && ev.drag.lifetime < life) { outcome = 'early re-entry'; failYear = ev.drag.lifetime; }
        runs.push({ pert: pert, outcome: outcome, ok: outcome === 'success', cost: ev.cost.total, wet: ev.mass.wet, massMargin: ev.massMargin, powerMargin: ev.power.margin,
                    pTotal: ev.risk.pTotal, lifetime: outcome === 'success' ? life : (failYear != null ? failYear : 0), slip: pert.slipMonths });
      }
      if (onProgress) onProgress(i / n);
      if (i < n) setTimeout(step, 0); else done(E.summarizeMC(runs, mission, base));
    };
    step();
  };
  E.summarizeMC = function (runs, mission, base) {
    var n = runs.length, ok = 0, causes = {}, costs = [], wets = [], mm = [], pm = [], lifes = [];
    runs.forEach(function (r) { if (r.ok) ok++; else causes[r.outcome] = (causes[r.outcome] || 0) + 1; costs.push(r.cost); wets.push(r.wet); mm.push(r.massMargin); pm.push(r.powerMargin); lifes.push(r.lifetime); });
    var q = function (arr, p) { var s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    var mean = function (a) { var s = 0; a.forEach(function (x) { s += x; }); return s / a.length; };
    var corr = function (xs, ys) { var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0, syy = 0; for (var i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my); } return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0; };
    var inputs = [['Payload mass growth', 'payload'], ['Bus mass growth', 'bus'], ['Propellant Isp', 'isp'], ['Solar activity (drag)', 'activity'], ['Array degradation', 'degr'], ['Cost growth', 'cost'], ['Schedule slip', 'slipMonths'], ['Injection error', 'inj']];
    var oks = runs.map(function (r) { return r.ok ? 1 : 0; });
    var sens = inputs.map(function (inp) { var xs = runs.map(function (r) { return r.pert[inp[1]]; }); return { name: inp[0], success: corr(xs, oks), cost: corr(xs, costs), margin: corr(xs, mm) }; });
    sens.sort(function (a, b) { return (Math.abs(b.cost) + Math.abs(b.success) + Math.abs(b.margin)) - (Math.abs(a.cost) + Math.abs(a.success) + Math.abs(a.margin)); });
    var causeList = Object.keys(causes).map(function (k) { return { cause: k, n: causes[k], p: causes[k] / n }; }).sort(function (a, b) { return b.n - a.n; });
    return { n: n, pSuccess: ok / n, ci: 1.96 * Math.sqrt((ok / n) * (1 - ok / n) / n), causes: causeList,
      cost: { mean: mean(costs), p10: q(costs, 0.1), p50: q(costs, 0.5), p90: q(costs, 0.9), pOver: costs.filter(function (c) { return c > mission.budget; }).length / n, all: costs },
      wet: { mean: mean(wets), p90: q(wets, 0.9), all: wets }, massMargin: { all: mm, pNeg: mm.filter(function (x) { return x < 0; }).length / n, p10: q(mm, 0.1) },
      powerMargin: { all: pm, pNeg: pm.filter(function (x) { return x < 0; }).length / n }, lifetime: { mean: mean(lifes) }, sensitivity: sens, base: base, meetsTarget: ok / n >= mission.minP };
  };

  /* ---------- optimizer ---------- */
  E.designSpace = function (mission) {
    var o = MP.ORBITS[mission.orbit], flex = mission.flex || 0;
    var lo = o.altEditable ? Math.max(o.altRange[0], mission.alt - flex) : mission.alt, hi = o.altEditable ? Math.min(o.altRange[1], mission.alt + flex) : mission.alt;
    return { altLo: lo, altHi: hi, incEditable: o.incEditable && mission.orbit === 'LEO', vehicles: MP.VEHICLES.map(function (v) { return v.id; }), props: E.props().map(function (p) { return p.id; }) };
  };
  E.optimize = function (mission, weights, opts) {
    opts = opts || {};
    var rnd = E.rng(opts.seed || 42), space = E.designSpace(mission), cache = {}, evaluated = [], history = [], evals = 0;
    var ev = function (d) {
      var r = E.evaluate(mission, d, weights); evals++;
      if (!cache[r.key]) { cache[r.key] = r; evaluated.push(r); }
      return cache[r.key];
    };
    // exhaustive seed over vehicle × propulsion at the nominal orbit
    var best = null;
    space.vehicles.forEach(function (vid) { space.props.forEach(function (pid) {
      var r = ev({ vehicle: vid, prop: pid, alt: mission.alt, inc: mission.inc, arrayOversize: 1.1, propMargin: 0.05 });
      if (!best || r.score < best.score) best = r;
    }); });
    history.push({ iter: 0, score: best.score, current: best.score });
    var cur = best, iters = opts.iters || 600, T0 = 0.6, T = T0;
    for (var i = 1; i <= iters; i++) {
      T = T0 * Math.pow(0.004, i / iters);
      var d = Object.assign({}, cur.design), k = rnd();
      if (k < 0.22) d.vehicle = rnd.pick(space.vehicles);
      else if (k < 0.44) d.prop = rnd.pick(space.props);
      else if (k < 0.70 && space.altHi > space.altLo) d.alt = clamp(Math.round(d.alt + rnd.gauss() * (space.altHi - space.altLo) * 0.15), space.altLo, space.altHi);
      else if (k < 0.78 && space.incEditable) d.inc = clamp(Math.round((d.inc + rnd.gauss() * 10) * 10) / 10, 0, 98);
      else if (k < 0.89) d.arrayOversize = clamp(Math.round((d.arrayOversize + rnd.gauss() * 0.08) * 100) / 100, 1, 1.6);
      else d.propMargin = clamp(Math.round((d.propMargin + rnd.gauss() * 0.05) * 100) / 100, 0, 0.3);
      var cand = ev(d), dS = cand.score - cur.score;
      if (dS < 0 || rnd() < Math.exp(-dS / T)) cur = cand;
      if (cur.score < best.score) best = cur;
      if (i % 5 === 0) history.push({ iter: i, score: best.score, current: cur.score, T: T });
    }
    var feasible = evaluated.filter(function (r) { return r.feasible; });
    // Pareto front over distinct designs (vehicle, propulsion, altitude band): cost ↓, risk ↓, perf ↑
    var distinct = {}; feasible.forEach(function (r) { var k = r.design.vehicle + '|' + r.design.prop + '|' + Math.round(r.design.alt / 50); if (!distinct[k] || r.score < distinct[k].score) distinct[k] = r; });
    var dl = Object.keys(distinct).map(function (k) { return distinct[k]; });
    var pareto = dl.filter(function (a) { return !dl.some(function (b) { return b !== a && b.cost.total <= a.cost.total && b.risk.pTotal >= a.risk.pTotal && b.perf.score >= a.perf.score && (b.cost.total < a.cost.total || b.risk.pTotal > a.risk.pTotal || b.perf.score > a.perf.score); }); });
    pareto.sort(function (a, b) { return a.cost.total - b.cost.total; });
    // ranked unique alternatives by vehicle+prop (best variant of each)
    var byCombo = {};
    evaluated.forEach(function (r) { var k = r.design.vehicle + '|' + r.design.prop; if (!byCombo[k] || r.score < byCombo[k].score) byCombo[k] = r; });
    var ranked = Object.keys(byCombo).map(function (k) { return byCombo[k]; }).sort(function (a, b) { return a.score - b.score; });
    return { best: best, history: history, evaluated: evaluated, distinct: dl, pareto: pareto, ranked: ranked, evals: evals, space: space };
  };

  /* ---------- ML surrogates ---------- */
  var ML = E.ml = {};
  ML.featureNames = ['log payload (kg)', 'log power (W)', 'lifetime (yr)', 'altitude (norm)', 'LEO', 'SSO', 'MEO', 'GEO', 'LUNAR', 'MARS', 'min P(success)', 'mission type', 'log budget ($M)'];
  var CLS = ['LEO', 'SSO', 'MEO', 'GEO', 'LUNAR', 'MARS'], TYPES = ['eo', 'comms', 'nav', 'sci', 'tech', 'explore'];
  ML.features = function (m) {
    var f = [Math.log(m.payload), Math.log(m.power), m.life, m.orbit === 'MARS' ? 1 : Math.log(m.alt + 100) / 11];
    CLS.forEach(function (c) { f.push(m.orbit === c ? 1 : 0); });
    f.push(m.minP, TYPES.indexOf(m.type) / 5, Math.log(m.budget));
    return f;
  };
  ML.randomMission = function (rnd) {
    var cls = rnd.pick(CLS), o = MP.ORBITS[cls], alt, type;
    if (cls === 'GEO') { alt = 35786; type = rnd.pick(['comms', 'comms', 'sci']); }
    else if (cls === 'MARS') { alt = 0; type = 'explore'; }
    else if (cls === 'LUNAR') { alt = Math.round(50 + rnd() * 300); type = rnd.pick(['explore', 'sci']); }
    else if (cls === 'MEO') { alt = Math.round(8000 + rnd() * 17000); type = rnd.pick(['nav', 'nav', 'comms', 'sci']); }
    else { alt = Math.round(o.altRange[0] + rnd() * (o.altRange[1] - o.altRange[0])); type = rnd.pick(['eo', 'eo', 'tech', 'sci', 'comms']); }
    var payload = Math.round(Math.exp(Math.log(3) + rnd() * (Math.log(cls === 'GEO' ? 1500 : 900) - Math.log(3))));
    var power = Math.round(payload * (2 + rnd() * 3) + 10);
    var life = cls === 'GEO' ? Math.round(8 + rnd() * 8) : cls === 'MEO' ? Math.round(5 + rnd() * 8) : Math.round(1 + rnd() * 6);
    var inc = cls === 'LEO' ? Math.round(rnd() * 98) : cls === 'SSO' ? P.ssoInc(alt) : cls === 'MEO' ? 55 : 90;
    return { type: type, orbit: cls, alt: alt, inc: inc, flex: 0, payload: payload, power: power, life: life, budget: 1e4, minP: 0.6 + rnd() * 0.3 };
  };
  // label = best vehicle/prop over the exhaustive grid at the nominal orbit
  ML.label = function (m, weights, rnd) {
    // pass 1: cheapest feasible option sets a realistic budget; pass 2: best score under that budget
    var cMin = Infinity, all = [];
    MP.VEHICLES.forEach(function (v) { E.props().forEach(function (p) {
      var d = { vehicle: v.id, prop: p.id, alt: m.alt, inc: m.inc, arrayOversize: 1.1, propMargin: 0.05 };
      var r = E.evaluate(Object.assign({}, m, { budget: 1e5 }), d, weights); all.push(d);
      if (r.feasible && r.cost.total < cMin) cMin = r.cost.total;
    }); });
    if (!isFinite(cMin)) cMin = 100;
    if (rnd) m.budget = Math.round(cMin * (1.05 + 0.9 * rnd()));
    var best = null;
    all.forEach(function (d) { var r = E.evaluate(m, d, weights); if (!best || r.score < best.score) best = r; });
    return best;
  };
  ML.generate = function (n, weights, seed, onProgress, done) {
    var rnd = E.rng(seed || 11), rows = [], i = 0, t0 = Date.now();
    var step = function () {
      var end = Math.min(n, i + 20);
      for (; i < end; i++) { var m = ML.randomMission(rnd), b = ML.label(m, weights, rnd); rows.push({ m: m, x: ML.features(m), vehicle: MP.VEHICLES.map(function (v) { return v.id; }).indexOf(b.design.vehicle), cost: Math.log(b.cost.total), wet: Math.log(b.mass.wet), feasible: b.feasible ? 1 : 0 }); }
      if (onProgress) onProgress(i / n);
      if (i < n) setTimeout(step, 0); else done({ rows: rows, ms: Date.now() - t0, msPerLabel: (Date.now() - t0) / n });
    };
    step();
  };
  // standardisation
  ML.scaler = function (X) { var d = X[0].length, mu = new Array(d).fill(0), sd = new Array(d).fill(0); X.forEach(function (x) { for (var j = 0; j < d; j++) mu[j] += x[j] / X.length; }); X.forEach(function (x) { for (var j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) * (x[j] - mu[j]) / X.length; }); for (var j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1; return { mu: mu, sd: sd, apply: function (x) { return x.map(function (v, j) { return (v - mu[j]) / sd[j]; }); } }; };

  /* DNN: 12 → 24 → 24 → [cost, wet, 10 vehicle logits], Adam, full batch */
  ML.DNN = function (inDim, hidden, nVeh, seed) {
    var rnd = E.rng(seed || 3), self = this;
    var init = function (r, c) { var s = Math.sqrt(2 / (r + c)), W = []; for (var i = 0; i < r; i++) { var row = []; for (var j = 0; j < c; j++) row.push(rnd.gauss() * s); W.push(row); } return W; };
    this.W1 = init(inDim, hidden); this.b1 = new Array(hidden).fill(0);
    this.W2 = init(hidden, hidden); this.b2 = new Array(hidden).fill(0);
    this.W3 = init(hidden, 2 + nVeh); this.b3 = new Array(2 + nVeh).fill(0);
    this.nVeh = nVeh; this.hidden = hidden; this.inDim = inDim;
    var mats = ['W1', 'b1', 'W2', 'b2', 'W3', 'b3'], mom = {}, vel = {}, tstep = 0;
    mats.forEach(function (k) { mom[k] = JSON.parse(JSON.stringify(self[k])).map(function (r) { return Array.isArray(r) ? r.map(function () { return 0; }) : 0; }); vel[k] = JSON.parse(JSON.stringify(mom[k])); });
    var relu = function (x) { return x > 0 ? x : 0.01 * x; };
    this.forward = function (x) {
      var h1 = [], h2 = [], out = [], i, j;
      for (j = 0; j < hidden; j++) { var s = self.b1[j]; for (i = 0; i < inDim; i++) s += x[i] * self.W1[i][j]; h1.push(s); }
      var a1 = h1.map(relu);
      for (j = 0; j < hidden; j++) { var s2 = self.b2[j]; for (i = 0; i < hidden; i++) s2 += a1[i] * self.W2[i][j]; h2.push(s2); }
      var a2 = h2.map(relu);
      for (j = 0; j < 2 + nVeh; j++) { var s3 = self.b3[j]; for (i = 0; i < hidden; i++) s3 += a2[i] * self.W3[i][j]; out.push(s3); }
      var logits = out.slice(2), mx = Math.max.apply(null, logits), ex = logits.map(function (l) { return Math.exp(l - mx); }), Z = ex.reduce(function (a, b) { return a + b; }, 0);
      return { h1: h1, a1: a1, h2: h2, a2: a2, out: out, probs: ex.map(function (e) { return e / Z; }) };
    };
    this.predict = function (x) { var f = self.forward(x); var best = 0; f.probs.forEach(function (p, i) { if (p > f.probs[best]) best = i; }); return { cost: f.out[0], wet: f.out[1], vehicle: best, probs: f.probs }; };
    // one full-batch Adam step; returns loss
    this.step = function (X, Y, lr) {
      var n = X.length, g = {}; mats.forEach(function (k) { g[k] = JSON.parse(JSON.stringify(mom[k])); });
      var loss = 0, i, j, k;
      for (var s = 0; s < n; s++) {
        var f = self.forward(X[s]), y = Y[s], dOut = [];
        dOut[0] = (f.out[0] - y.cost); dOut[1] = (f.out[1] - y.wet);
        loss += 0.5 * dOut[0] * dOut[0] + 0.5 * dOut[1] * dOut[1] - Math.log(f.probs[y.vehicle] + 1e-9) * 0.3;
        for (k = 0; k < nVeh; k++) dOut[2 + k] = 0.3 * (f.probs[k] - (k === y.vehicle ? 1 : 0));
        var dA2 = new Array(hidden).fill(0);
        for (j = 0; j < 2 + nVeh; j++) { g.b3[j] += dOut[j] / n; for (i = 0; i < hidden; i++) { g.W3[i][j] += f.a2[i] * dOut[j] / n; dA2[i] += self.W3[i][j] * dOut[j]; } }
        var dH2 = dA2.map(function (d, q) { return f.h2[q] > 0 ? d : 0.01 * d; }), dA1 = new Array(hidden).fill(0);
        for (j = 0; j < hidden; j++) { g.b2[j] += dH2[j] / n; for (i = 0; i < hidden; i++) { g.W2[i][j] += f.a1[i] * dH2[j] / n; dA1[i] += self.W2[i][j] * dH2[j]; } }
        var dH1 = dA1.map(function (d, q) { return f.h1[q] > 0 ? d : 0.01 * d; });
        for (j = 0; j < hidden; j++) { g.b1[j] += dH1[j] / n; for (i = 0; i < inDim; i++) g.W1[i][j] += X[s][i] * dH1[j] / n; }
      }
      tstep++;
      var b1 = 0.9, b2 = 0.999, eps = 1e-8;
      mats.forEach(function (key) {
        var upd = function (p, gr, mm, vv) { var nm = b1 * mm + (1 - b1) * gr, nv = b2 * vv + (1 - b2) * gr * gr; var mh = nm / (1 - Math.pow(b1, tstep)), vh = nv / (1 - Math.pow(b2, tstep)); return [p - lr * mh / (Math.sqrt(vh) + eps), nm, nv]; };
        if (Array.isArray(self[key][0])) { for (var r = 0; r < self[key].length; r++) for (var c = 0; c < self[key][r].length; c++) { var u = upd(self[key][r][c], g[key][r][c], mom[key][r][c], vel[key][r][c]); self[key][r][c] = u[0]; mom[key][r][c] = u[1]; vel[key][r][c] = u[2]; } }
        else { for (var q = 0; q < self[key].length; q++) { var u2 = upd(self[key][q], g[key][q], mom[key][q], vel[key][q]); self[key][q] = u2[0]; mom[key][q] = u2[1]; vel[key][q] = u2[2]; } }
      });
      return loss / n;
    };
  };

  /* Gaussian process regression, RBF kernel, Cholesky solve */
  ML.GP = function (X, y, ls, noise) {
    var n = X.length, d = X[0].length, self = this;
    var k = function (a, b) { var s = 0; for (var j = 0; j < d; j++) { var t = a[j] - b[j]; s += t * t; } return Math.exp(-s / (2 * ls * ls)); };
    var mean = y.reduce(function (a, b) { return a + b; }, 0) / n, yc = y.map(function (v) { return v - mean; });
    var K = []; for (var i = 0; i < n; i++) { K.push([]); for (var j = 0; j < n; j++) K[i].push(k(X[i], X[j]) + (i === j ? noise : 0)); }
    // Cholesky
    var L = []; for (i = 0; i < n; i++) { L.push(new Array(n).fill(0)); }
    for (i = 0; i < n; i++) for (var jj = 0; jj <= i; jj++) { var s = K[i][jj]; for (var q = 0; q < jj; q++) s -= L[i][q] * L[jj][q]; L[i][jj] = i === jj ? Math.sqrt(Math.max(s, 1e-10)) : s / L[jj][jj]; }
    var solve = function (b) { var z = new Array(n).fill(0), x = new Array(n).fill(0), i2, q2; for (i2 = 0; i2 < n; i2++) { var s2 = b[i2]; for (q2 = 0; q2 < i2; q2++) s2 -= L[i2][q2] * z[q2]; z[i2] = s2 / L[i2][i2]; } for (i2 = n - 1; i2 >= 0; i2--) { var s3 = z[i2]; for (q2 = i2 + 1; q2 < n; q2++) s3 -= L[q2][i2] * x[q2]; x[i2] = s3 / L[i2][i2]; } return x; };
    var alpha = solve(yc);
    this.predict = function (x) { var ks = X.map(function (xi) { return k(xi, x); }); var mu = mean; for (var i3 = 0; i3 < n; i3++) mu += ks[i3] * alpha[i3]; var v = solve(ks), varr = 1; for (i3 = 0; i3 < n; i3++) varr -= ks[i3] * v[i3]; return { mean: mu, sd: Math.sqrt(Math.max(varr, 0)) }; };
    this.n = n;
  };

  /* SVR: ε-insensitive loss, RBF kernel approximated by random Fourier features, trained in the primal by SGD */
  ML.SVR = function (dim, D, gamma, seed) {
    var rnd = E.rng(seed || 5), self = this;
    this.W = []; this.b = []; for (var i = 0; i < D; i++) { var row = []; for (var j = 0; j < dim; j++) row.push(rnd.gauss() * Math.sqrt(2 * gamma)); self.W.push(row); self.b.push(rnd() * 2 * Math.PI); }
    this.w = new Array(D).fill(0); this.w0 = 0; this.D = D;
    this.phi = function (x) { var z = []; for (var i = 0; i < D; i++) { var s = self.b[i]; for (var j = 0; j < dim; j++) s += self.W[i][j] * x[j]; z.push(Math.sqrt(2 / D) * Math.cos(s)); } return z; };
    this.predict = function (x) { var z = self.phi(x), s = self.w0; for (var i = 0; i < D; i++) s += self.w[i] * z[i]; return s; };
    this.fit = function (X, y, epochs, eps, Cc, lr) {
      var n = X.length, Z = X.map(self.phi), hist = [];
      for (var e = 0; e < epochs; e++) {
        var loss = 0;
        for (var s = 0; s < n; s++) { var idx = Math.floor(rnd() * n), z = Z[idx], p = self.w0; for (var i = 0; i < D; i++) p += self.w[i] * z[i]; var r = p - y[idx], g = Math.abs(r) > eps ? (r > 0 ? 1 : -1) : 0; loss += Math.max(0, Math.abs(r) - eps);
          for (i = 0; i < D; i++) self.w[i] -= lr * (Cc * g * z[i] + self.w[i] / n); self.w0 -= lr * Cc * g; }
        hist.push(loss / n);
      }
      return hist;
    };
  };

  /* Train all three on a dataset; chunked so the UI can show progress */
  ML.train = function (data, onProgress, done) {
    var rows = data.rows, rnd = E.rng(21), idx = rows.map(function (_, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    var nTr = Math.floor(rows.length * 0.8), tr = idx.slice(0, nTr).map(function (i) { return rows[i]; }), te = idx.slice(nTr).map(function (i) { return rows[i]; });
    var sc = ML.scaler(rows.map(function (r) { return r.x; }));
    var Xtr = tr.map(function (r) { return sc.apply(r.x); }), Xte = te.map(function (r) { return sc.apply(r.x); });
    var cMean = 0; tr.forEach(function (r) { cMean += r.cost / tr.length; }); var wMean = 0; tr.forEach(function (r) { wMean += r.wet / tr.length; });
    var Ytr = tr.map(function (r) { return { cost: r.cost - cMean, wet: r.wet - wMean, vehicle: r.vehicle }; });
    var dnn = new ML.DNN(Xtr[0].length, 32, MP.VEHICLES.length, 3), epochs = 360, ep = 0, curve = [], t0 = Date.now();
    var result = { scaler: sc, cMean: cMean, wMean: wMean, nTrain: tr.length, nTest: te.length, dnn: dnn, curve: curve };
    var rmse = function (f) { var s = 0; te.forEach(function (r, i) { var d = f(Xte[i]) - r.cost; s += d * d; }); return Math.sqrt(s / te.length); };
    var mape = function (f) { var s = 0; te.forEach(function (r, i) { s += Math.abs(Math.exp(f(Xte[i])) / Math.exp(r.cost) - 1); }); return s / te.length; };
    var step = function () {
      var end = Math.min(epochs, ep + 10);
      for (; ep < end; ep++) curve.push(dnn.step(Xtr, Ytr, ep < 200 ? 0.015 : 0.004));
      if (onProgress) onProgress(ep / epochs * 0.7, 'Training DNN, epoch ' + ep + '/' + epochs);
      if (ep < epochs) return setTimeout(step, 0);
      result.dnnMs = Date.now() - t0;
      var acc = 0; te.forEach(function (r, i) { if (dnn.predict(Xte[i]).vehicle === r.vehicle) acc++; });
      result.dnn = { model: dnn, rmse: rmse(function (x) { return dnn.predict(x).cost + cMean; }), mape: mape(function (x) { return dnn.predict(x).cost + cMean; }), acc: acc / te.length, ms: result.dnnMs,
        predict: function (x) { var p = dnn.predict(sc.apply(x)); return { cost: Math.exp(p.cost + cMean), wet: Math.exp(p.wet + wMean), vehicle: MP.VEHICLES[p.vehicle], probs: p.probs }; } };
      if (onProgress) onProgress(0.75, 'Fitting Gaussian process (' + Math.min(tr.length, 320) + ' points)');
      setTimeout(function () {
        var t1 = Date.now(), gpN = Math.min(tr.length, 320), gp = new ML.GP(Xtr.slice(0, gpN), tr.slice(0, gpN).map(function (r) { return r.cost; }), 2.2, 0.02);
        result.gp = { model: gp, rmse: rmse(function (x) { return gp.predict(x).mean; }), mape: mape(function (x) { return gp.predict(x).mean; }), ms: Date.now() - t1,
          predict: function (x) { var p = gp.predict(sc.apply(x)); return { cost: Math.exp(p.mean), sd: p.sd, lo: Math.exp(p.mean - 1.96 * p.sd), hi: Math.exp(p.mean + 1.96 * p.sd) }; } };
        if (onProgress) onProgress(0.88, 'Training SVR (random Fourier features)');
        setTimeout(function () {
          var t2 = Date.now(), svr = new ML.SVR(Xtr[0].length, 160, 0.08, 5);
          var hist = svr.fit(Xtr, tr.map(function (r) { return r.cost - cMean; }), 60, 0.05, 1.0, 0.01);
          result.svr = { model: svr, rmse: rmse(function (x) { return svr.predict(x) + cMean; }), mape: mape(function (x) { return svr.predict(x) + cMean; }), ms: Date.now() - t2, curve: hist,
            predict: function (x) { return { cost: Math.exp(svr.predict(sc.apply(x)) + cMean) }; } };
          // test scatter
          result.test = te.map(function (r, i) { return { truth: Math.exp(r.cost), dnn: Math.exp(dnn.predict(Xte[i]).cost + cMean), gp: Math.exp(gp.predict(Xte[i]).mean), svr: Math.exp(svr.predict(Xte[i]) + cMean) }; });
          // speed test: surrogate vs optimizer label
          var t3 = Date.now(); for (var q = 0; q < 200; q++) dnn.predict(Xte[q % Xte.length]); result.usPerPredict = (Date.now() - t3) / 200 * 1000;
          result.msPerLabel = data.msPerLabel;
          if (onProgress) onProgress(1, 'Done');
          done(result);
        }, 0);
      }, 0);
    };
    step();
  };

  /* ---------- XAI ---------- */
  var X = E.xai = {};
  // additive score decomposition for two designs
  X.decompose = function (r) { return [['Cost vs budget', r.terms.cost], ['Mission risk', r.terms.risk], ['Performance shortfall', r.terms.perf], ['Constraint penalties', r.terms.penalty]]; };
  // exact Shapley values of a prediction function over feature groups (n ≤ 10)
  X.shapley = function (f, x, baseline, groups) {
    var n = groups.length, N = 1 << n, vals = new Float64Array(N);
    for (var m = 0; m < N; m++) { var z = baseline.slice(); for (var i = 0; i < n; i++) if (m >> i & 1) groups[i].forEach(function (j) { z[j] = x[j]; }); vals[m] = f(z); }
    var fact = [1]; for (var q = 1; q <= n; q++) fact.push(fact[q - 1] * q);
    var pc = function (v) { var c = 0; while (v) { c += v & 1; v >>= 1; } return c; };
    var phi = new Array(n).fill(0);
    for (m = 0; m < N; m++) { var s = pc(m); if (s === n) continue; var w = fact[s] * fact[n - s - 1] / fact[n]; for (i = 0; i < n; i++) if (!(m >> i & 1)) phi[i] += w * (vals[m | 1 << i] - vals[m]); }
    return { phi: phi, base: vals[0], out: vals[N - 1] };
  };
  X.GROUPS = [['Payload mass', [0]], ['Power demand', [1]], ['Mission lifetime', [2]], ['Orbit altitude', [3]], ['Orbit class', [4, 5, 6, 7, 8, 9]], ['Required reliability', [10]], ['Mission type', [11]]];
  X.explainCost = function (trained, mission, baselineRows) {
    var x = ML.features(mission), base = x.map(function () { return 0; });
    baselineRows.forEach(function (r) { r.x.forEach(function (v, j) { base[j] += v / baselineRows.length; }); });
    var f = function (z) { return Math.log(trained.dnn.predict(z).cost); };
    var sh = X.shapley(f, x, base, X.GROUPS.map(function (g) { return g[1]; }));
    return { items: X.GROUPS.map(function (g, i) { return { name: g[0], phi: sh.phi[i], pct: Math.exp(sh.phi[i]) - 1 }; }).sort(function (a, b) { return Math.abs(b.phi) - Math.abs(a.phi); }), base: Math.exp(sh.base), out: Math.exp(sh.out) };
  };
  // counterfactuals: what change would flip the recommendation to the runner-up
  X.counterfactuals = function (mission, best, alts, weights) {
    var out = [];
    if (alts.length < 2) return out;
    var ru = alts[1];
    // budget scan
    var lo = mission.budget * 0.3, hi = mission.budget * 3, flip = null;
    for (var b = lo; b <= hi; b *= 1.08) { var m2 = Object.assign({}, mission, { budget: b }); var s1 = E.evaluate(m2, best.design, weights).score, s2 = E.evaluate(m2, ru.design, weights).score; if (s2 < s1) { flip = b; break; } }
    if (flip && flip > mission.budget) out.push('If the budget were above $' + Math.round(flip) + 'M, ' + ru.label + ' would rank first.');
    else if (flip && flip <= mission.budget) out.push('With a budget below $' + Math.round(flip) + 'M, ' + ru.label + ' would take over.');
    // reliability scan
    var flipP = null; for (var p = 0.5; p <= 0.99; p += 0.01) { var m3 = Object.assign({}, mission, { minP: p }); if (E.evaluate(m3, ru.design, weights).score < E.evaluate(m3, best.design, weights).score) { flipP = p; break; } }
    if (flipP) out.push('Requiring at least ' + Math.round(flipP * 100) + '% success probability would favour ' + ru.label + '.');
    // weight scan
    var w2 = { cost: 0.7, risk: 0.2, perf: 0.1 }, w3 = { cost: 0.2, risk: 0.6, perf: 0.2 };
    var bc = E.evaluate(mission, best.design, w2).score, rc = E.evaluate(mission, ru.design, w2).score;
    if (rc < bc) out.push('A cost-first weighting (70% cost) would prefer ' + ru.label + '.');
    var br = E.evaluate(mission, best.design, w3).score, rr = E.evaluate(mission, ru.design, w3).score;
    if (rr < br) out.push('A risk-first weighting (60% risk) would prefer ' + ru.label + '.');
    // payload scan
    for (var g = 1.1; g <= 2.0; g += 0.1) { var m4 = Object.assign({}, mission, { payload: mission.payload * g }); var e1 = E.evaluate(m4, best.design, weights), e2 = E.evaluate(m4, ru.design, weights); if (!e1.feasible || e2.score < e1.score) { out.push('If payload mass grew by ' + Math.round((g - 1) * 100) + '%, ' + (e1.feasible ? ru.label + ' would rank first.' : best.vehicle.name + ' would no longer carry it.')); break; } }
    if (!out.length) out.push('The recommendation is stable: no single change in budget, reliability target, weighting or payload mass (up to +100%) changes the ranking.');
    return out;
  };
  X.narrative = function (mission, best, alts, mc) {
    var v = best.vehicle, p = best.prop, m = best.mission, s = [];
    s.push(v.name + ' with ' + p.name + ' is recommended because it delivers ' + Math.round(best.mass.wet) + ' kg to ' + best.drop.desc.replace('Direct injection, ', '') + ' with ' + Math.round(best.massMargin * 100) + '% launch mass margin, at an estimated $' + best.cost.total.toFixed(0) + 'M' + (best.cost.total <= mission.budget ? ' (' + Math.round((1 - best.cost.total / mission.budget) * 100) + '% under budget)' : ' (over budget)') + '.');
    s.push('Mission success probability is ' + (best.risk.pTotal * 100).toFixed(0) + '% analytically' + (mc ? ' and ' + (mc.pSuccess * 100).toFixed(0) + '% in ' + mc.n + ' Monte Carlo runs' : '') + ', against a requirement of ' + Math.round(mission.minP * 100) + '%. The largest single risk is ' + (best.risk.factors.slice().sort(function (a, b) { return a[1] - b[1]; })[0][0]).toLowerCase() + '.');
    if (alts[1]) { var ru = alts[1], why = []; if (ru.cost.total > best.cost.total * 1.05) why.push('costs $' + (ru.cost.total - best.cost.total).toFixed(0) + 'M more'); if (ru.risk.pTotal < best.risk.pTotal - 0.01) why.push('has ' + ((best.risk.pTotal - ru.risk.pTotal) * 100).toFixed(0) + ' points lower success probability'); if (ru.perf.score < best.perf.score - 0.02) why.push('scores lower on performance'); if (ru.violations.length > best.violations.length) why.push('violates ' + ru.violations.length + ' constraint' + (ru.violations.length > 1 ? 's' : ''));
      s.push('The runner-up, ' + ru.label + ', ' + (why.length ? why.join(', ') : 'is close but scores slightly worse overall') + '.'); }
    var top = best.perf.parts.slice().sort(function (a, b) { return b[1] * b[2] - a[1] * a[2]; })[0];
    s.push('Performance is driven mainly by ' + top[0].toLowerCase() + ' (' + Math.round(top[2] * 100) + '/100).');
    return s.join(' ');
  };
})();

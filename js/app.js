/* =========================================================================
   APP: state, pipeline orchestration, pages
   ========================================================================= */
(function () {
  'use strict';
  var E = MP.engine, P = MP.physics, CH = MP.charts, C = MP.CONST;
  var $ = function (s, r) { return (r || document).querySelector(s); }, $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var M$ = function (v) { return '$' + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v >= 10 ? 0 : 1)) + 'M'; };
  var pct = function (v, d) { return (v * 100).toFixed(d || 0) + '%'; };
  var kg = function (v) { return Math.round(v).toLocaleString() + ' kg'; };
  var n0 = function (v) { return Math.round(v).toLocaleString(); };

  var PAGES = [
    { id: 'input', title: 'Mission Input', sub: 'Requirements & database' },
    { id: 'physics', title: 'Physics Engine', sub: 'Δv · mass · power' },
    { id: 'mc', title: 'Monte Carlo', sub: 'Uncertainty & risk' },
    { id: 'opt', title: 'Optimization + ML', sub: 'Search & surrogates' },
    { id: 'rec', title: 'Recommendation & XAI', sub: 'Ranking & reasons' },
    { id: 'sim', title: 'Digital Simulation', sub: 'Mission phases' },
    { id: 'final', title: 'Final Analysis', sub: 'System outputs' }
  ];
  var A = window.APP = {
    mission: null, weights: { cost: 0.4, risk: 0.35, perf: 0.25 }, mcRuns: 2000, iters: 600, mlN: 300, seed: 7,
    opt: null, mc: null, data: null, ml: null, xai: null, sel: null, page: 'input', status: {}, running: false, mlKey: '', sim: null, mcProgress: 0, mlProgress: 0, mlMsg: ''
  };
  PAGES.forEach(function (p) { A.status[p.id] = p.id === 'input' ? 'done' : 'pending'; });

  /* ---------- mission helpers ---------- */
  function loadPreset(id) {
    var p = MP.PRESETS.filter(function (x) { return x.id === id; })[0] || MP.PRESETS[0];
    A.mission = { name: p.label, type: p.type, orbit: p.orbit, alt: p.alt, inc: p.inc, flex: p.flex, payload: p.payload, power: p.power, life: p.life, budget: p.budget, minP: p.minP, preset: p.id };
    normaliseMission();
  }
  function normaliseMission() {
    var m = A.mission, o = MP.ORBITS[m.orbit];
    if (m.orbit === 'GEO') { m.alt = 35786; m.inc = 0; }
    if (m.orbit === 'MARS') { m.alt = 0; m.inc = 0; }
    if (m.orbit === 'SSO') { m.alt = E.clamp(m.alt, o.altRange[0], o.altRange[1]); m.inc = Math.round(P.ssoInc(m.alt) * 10) / 10; }
    if (m.orbit === 'LEO' || m.orbit === 'MEO' || m.orbit === 'LUNAR') m.alt = E.clamp(m.alt, o.altRange[0], o.altRange[1]);
    if (m.orbit === 'MEO' && m.inc == null) m.inc = 55;
    if (m.orbit === 'LUNAR') m.inc = 90;
    m.payload = Math.max(1, m.payload || 1); m.power = Math.max(5, m.power || 5); m.life = E.clamp(m.life || 1, 0.5, 20); m.budget = Math.max(1, m.budget || 1); m.minP = E.clamp(m.minP || 0.7, 0.5, 0.99);
  }
  function markStale() { PAGES.forEach(function (p) { if (p.id !== 'input' && A.status[p.id] === 'done') A.status[p.id] = 'stale'; }); A.stale = true; renderSteps(); $('#runBtn').textContent = 'Re-run mission pipeline'; }

  /* ---------- pipeline ---------- */
  function setStatus(id, s) { A.status[id] = s; renderSteps(); }
  function runPipeline() {
    if (A.running) return;
    A.running = true; A.stale = false; $('#runBtn').disabled = true; $('#runBtn').textContent = 'Running…';
    ['physics', 'mc', 'opt', 'rec', 'sim', 'final'].forEach(function (k) { A.status[k] = 'pending'; });
    setStatus('physics', 'running');
    setTimeout(function () {
      var t0 = Date.now();
      A.opt = E.optimize(A.mission, A.weights, { iters: A.iters }); A.opt.ms = Date.now() - t0;
      A.sel = A.opt.best; A.sim = null;
      A.xai = { cf: E.xai.counterfactuals(A.mission, A.opt.best, A.opt.ranked, A.weights), shap: null };
      setStatus('physics', 'done'); setStatus('opt', 'running'); setStatus('rec', 'done'); setStatus('sim', 'done');
      render();
      setStatus('mc', 'running');
      E.monteCarlo(A.mission, A.sel.design, A.weights, A.mcRuns, A.seed, function (p) { A.mcProgress = p; if (A.page === 'mc') { var el = $('#mcProg'); if (el) el.style.width = (p * 100) + '%'; } }, function (mc) {
        A.mc = mc; setStatus('mc', 'done'); if (A.page === 'mc' || A.page === 'rec') render();
        var key = JSON.stringify(A.weights) + ':' + A.mlN;
        var finish = function () { setStatus('opt', 'done'); setStatus('final', 'done'); A.running = false; $('#runBtn').disabled = false; $('#runBtn').textContent = 'Re-run mission pipeline'; if (A.ml) A.xai.shap = E.xai.explainCost(A.ml, A.mission, A.data.rows); render(); toast('Pipeline complete: ' + A.sel.label + ' recommended'); };
        if (A.ml && A.mlKey === key) finish(); else trainML(finish);
      });
    }, 30);
  }
  function trainML(done) {
    var key = JSON.stringify(A.weights) + ':' + A.mlN; A.mlBusy = true;
    A.mlMsg = 'Generating ' + A.mlN + ' optimised missions for training…'; A.mlProgress = 0; refreshMLProgress();
    E.ml.generate(A.mlN, A.weights, 11, function (p) { A.mlProgress = p * 0.5; refreshMLProgress(); }, function (data) {
      A.data = data;
      E.ml.train(data, function (p, msg) { A.mlProgress = 0.5 + p * 0.5; A.mlMsg = msg; refreshMLProgress(); }, function (ml) { A.ml = ml; A.mlKey = key; A.mlBusy = false; A.mlMsg = 'Trained on ' + ml.nTrain + ' missions, tested on ' + ml.nTest; if (A.xai) A.xai.shap = E.xai.explainCost(ml, A.mission, data.rows); if (done) done(); else render(); });
    });
  }
  function refreshMLProgress() { var el = $('#mlProg'), ms = $('#mlMsg'); if (el) el.style.width = (A.mlProgress * 100) + '%'; if (ms) ms.textContent = A.mlMsg; }
  function selectConfig(key) { var r = A.opt.evaluated.filter(function (x) { return x.key === key; })[0]; if (r) { A.sel = r; A.sim = null; render(); } }

  /* ---------- shell ---------- */
  function renderSteps() {
    $('#steps').innerHTML = PAGES.map(function (p, i) { var s = A.status[p.id]; return '<button class="step ' + s + (A.page === p.id ? ' on' : '') + '" data-page="' + p.id + '"><span class="n">' + (s === 'done' ? '✓' : i + 1) + '</span><b>' + p.title + '</b><i>' + (s === 'running' ? 'running…' : s === 'stale' ? 'inputs changed' : s === 'pending' ? 'not run' : p.sub) + '</i></button>'; }).join('');
    $('#missionChip').textContent = A.mission.name;
  }
  function go(id) { A.page = id; renderSteps(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); var st = $('.step.on'); if (st && st.scrollIntoView) st.scrollIntoView({ inline: 'center', block: 'nearest' }); }
  function render() {
    var fn = R[A.page]; $('#main').innerHTML = fn();
    requestAnimationFrame(function () { if (D[A.page]) D[A.page](); });
    if (A.page !== 'sim' && A.sim) A.sim.playing = false;
  }
  var R = {}, D = {};
  function need(stage, msg) { return '<div class="placeholder"><p style="font-size:16px;font-weight:600;color:var(--fg)">' + msg + '</p><p class="small" style="margin-top:6px">Press <b>Run mission pipeline</b> at the top. ' + (A.status[stage] === 'running' ? 'This stage is running now.' : '') + '</p></div>'; }
  function cfgSelector() {
    if (!A.opt) return '';
    var list = A.opt.ranked.slice(0, 12);
    return '<label class="chip" style="gap:8px">Configuration <select id="cfgSel" style="background:var(--surface2);border:1px solid var(--line2);border-radius:6px;padding:3px 6px;max-width:260px">' + list.map(function (r, i) { return '<option value="' + r.key + '"' + (A.sel && r.key === A.sel.key ? ' selected' : '') + '>#' + (i + 1) + ' ' + esc(r.label) + (r.feasible ? '' : ' (infeasible)') + '</option>'; }).join('') + '</select></label>';
  }
  function kpi(l, v, s, cls) { return '<div class="kpi ' + (cls || '') + '"><div class="l">' + l + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  function facts(rows) { return '<dl class="facts">' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>'; }).join('') + '</dl>'; }

  /* ================= PAGE 1: INPUT ================= */
  R.input = function () {
    var m = A.mission, o = MP.ORBITS[m.orbit];
    var opt = function (list, cur, fn) { return list.map(function (x) { return '<option value="' + x + '"' + (x === cur ? ' selected' : '') + '>' + fn(x) + '</option>'; }).join(''); };
    return '<div class="pagehead"><div><h1>Mission requirements</h1><p>Define the payload, target orbit, lifetime and constraints. The pipeline then models the physics, tests the mission under uncertainty, optimises the configuration, learns from the results and simulates the chosen mission.</p></div></div>' +
      '<div class="grid">' +
      '<div class="card c7"><div class="ch"><h2>Mission input</h2><span class="muted">Sample missions</span></div>' +
      '<div class="presets">' + MP.PRESETS.map(function (p) { return '<button class="chip' + (m.preset === p.id ? ' on' : '') + '" data-preset="' + p.id + '">' + esc(p.label) + '</button>'; }).join('') + '</div>' +
      '<div class="form">' +
      '<div class="field wide"><label>Mission name</label><input type="text" data-k="name" id="f-name" value="' + esc(m.name) + '"></div>' +
      '<div class="field"><label>Mission type</label><select data-k="type" id="f-type">' + opt(Object.keys(MP.MISSION_TYPES), m.type, function (k) { return MP.MISSION_TYPES[k].name; }) + '</select></div>' +
      '<div class="field"><label>Target orbit</label><select data-k="orbit" id="f-orbit">' + opt(Object.keys(MP.ORBITS), m.orbit, function (k) { return MP.ORBITS[k].name; }) + '</select></div>' +
      '<div class="field"><label>Altitude <span>km' + (o.altEditable ? ', ' + o.altRange[0] + '–' + o.altRange[1] : ', fixed') + '</span></label><input type="number" data-k="alt" id="f-alt" value="' + m.alt + '" min="' + o.altRange[0] + '" max="' + o.altRange[1] + '" step="10"' + (o.altEditable ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>Inclination <span>deg' + (m.orbit === 'SSO' ? ', sun-synchronous (auto)' : o.incEditable ? '' : ', fixed') + '</span></label><input type="number" data-k="inc" id="f-inc" value="' + m.inc + '" min="0" max="110" step="0.1"' + (o.incEditable ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>Altitude flexibility <span>± km the optimiser may move</span></label><input type="number" data-k="flex" id="f-flex" value="' + m.flex + '" min="0" max="500" step="10"' + (o.flex ? '' : ' disabled') + '></div>' +
      '<div class="field"><label>Mission lifetime <span>years</span></label><input type="number" data-k="life" id="f-life" value="' + m.life + '" min="0.5" max="20" step="0.5"></div>' +
      '<div class="field"><label>Payload mass <span>kg</span></label><input type="number" data-k="payload" id="f-payload" value="' + m.payload + '" min="1" max="5000" step="1"></div>' +
      '<div class="field"><label>Payload power <span>W, orbit average</span></label><input type="number" data-k="power" id="f-power" value="' + m.power + '" min="5" max="20000" step="5"></div>' +
      '<div class="field"><label>Budget <span>USD million</span></label><input type="number" data-k="budget" id="f-budget" value="' + m.budget + '" min="1" step="5"></div>' +
      '<div class="field"><label>Required success probability <span>' + pct(m.minP) + '</span></label><input type="range" data-k="minP" id="f-minP" value="' + m.minP + '" min="0.5" max="0.99" step="0.01"></div>' +
      '</div>' +
      '<div class="ch" style="margin-top:16px"><h3>Objective weights</h3><span class="muted small">how the optimiser trades the three objectives</span></div>' +
      '<div class="weights">' + [['cost', 'Cost'], ['risk', 'Risk'], ['perf', 'Performance']].map(function (w) { return '<div class="wrow"><span>' + w[1] + '</span><input type="range" data-w="' + w[0] + '" min="0" max="1" step="0.05" value="' + A.weights[w[0]] + '"><output id="w-' + w[0] + '">' + pct(A.weights[w[0]]) + '</output></div>'; }).join('') + '</div>' +
      '<div class="ch" style="margin-top:16px"><h3>Run settings</h3></div><div class="form">' +
      '<div class="field"><label>Monte Carlo runs</label><select data-s="mcRuns">' + opt([500, 1000, 2000, 5000], A.mcRuns, function (x) { return x.toLocaleString() + ' runs'; }) + '</select></div>' +
      '<div class="field"><label>Optimiser iterations</label><select data-s="iters">' + opt([300, 600, 1200, 2500], A.iters, function (x) { return x + ' annealing steps'; }) + '</select></div>' +
      '<div class="field"><label>ML training missions</label><select data-s="mlN">' + opt([150, 300, 600], A.mlN, function (x) { return x + ' synthetic missions'; }) + '</select></div>' +
      '<div class="field"><label>Random seed</label><input type="number" data-s="seed" value="' + A.seed + '" min="1" step="1"></div></div>' +
      '</div>' +
      '<div class="c5" style="display:grid;gap:14px;align-content:start"><div class="card hero" id="summaryCard">' + summaryCard() + '</div>' +
      '<div class="card"><div class="ch"><h2>Pipeline</h2><span class="muted">six modules</span></div><div class="pipeline-diagram">' + [['Mission input', 'payload, orbit, constraints'], ['Physics engine', 'orbit, Δv, propulsion'], ['Monte Carlo', 'uncertainty, risk'], ['Optimisation + ML', 'search, surrogates'], ['Recommendation & XAI', 'ranking, reasons'], ['Digital simulation', 'phases, telemetry']].map(function (p) { return '<div><b>' + p[0] + '</b>' + p[1] + '</div>'; }).join('') + '</div></div></div>' +
      '<div class="card c12" id="dbCard">' + dbCard() + '</div>' +
      '</div>';
  };
  function summaryCard() {
    var m = A.mission, oi = P.orbitInfo(m), o = MP.ORBITS[m.orbit];
    var quick = E.evaluate(m, { vehicle: 'f9', prop: 'mono', alt: m.alt, inc: m.inc, arrayOversize: 1.1, propMargin: 0.05 }, A.weights);
    var rows = [['Target', o.name + (m.orbit !== 'MARS' && m.orbit !== 'GEO' ? ', ' + n0(m.alt) + ' km' : m.orbit === 'MARS' ? ', ' + oi.ellipse : '')], ['Orbital period', (oi.period / 60).toFixed(1) + ' min'], ['Orbital speed', oi.v.toFixed(2) + ' km/s'], ['Max eclipse', oi.eclipseMin.toFixed(1) + ' min (' + pct(oi.eclipseFrac) + ')']];
    if (oi.raan != null) rows.push(['Nodal drift (J2)', oi.raan.toFixed(3) + ' °/day']);
    if (oi.revsPerDay) rows.push(['Revolutions / day', oi.revsPerDay.toFixed(2)]);
    if (oi.swathKm) rows.push(['Horizon-to-horizon swath', n0(oi.swathKm) + ' km']);
    rows.push(['First-guess wet mass', kg(quick.mass.wet) + ' (' + quick.prop.name.split(' (')[0].toLowerCase() + ')'], ['First-guess Δv need', n0(quick.dv.total) + ' m/s']);
    var able = MP.VEHICLES.filter(function (v) { var c = P.capacity(v, m); return c.feasible && c.cap >= quick.mass.wet; });
    return '<div class="ch"><h2>' + esc(m.name) + '</h2><span class="chip">' + MP.MISSION_TYPES[m.type].name + '</span></div>' + facts(rows) +
      '<p class="sub" style="margin-top:10px">' + able.length + ' of ' + MP.VEHICLES.length + ' vehicles in the database can lift the first-guess spacecraft to this orbit' + (able.length ? ': ' + able.map(function (v) { return v.name; }).join(', ') : '') + '.</p>' +
      '<button class="btn primary" id="runBtn2" style="margin-top:14px;width:100%;justify-content:center">' + (A.opt ? 'Re-run mission pipeline' : 'Run mission pipeline') + '</button>';
  }
  function dbCard() {
    var m = A.mission;
    var quick = E.evaluate(m, { vehicle: 'f9', prop: 'mono', alt: m.alt, inc: m.inc, arrayOversize: 1.1, propMargin: 0.05 }, A.weights);
    return '<div class="ch"><h2>Mission database: launch vehicles</h2><span class="muted">capacity computed for this mission\'s orbit · reliability is Bayesian (successes+1)/(flights+2)</span></div><div class="tw"><table><thead><tr><th>Vehicle</th><th>Provider · site</th><th>Delivers to</th><th class="n">Capacity</th><th class="n">vs first guess</th><th class="n">Price</th><th class="n">Reliability</th><th class="n">Fairing</th></tr></thead><tbody>' +
      MP.VEHICLES.map(function (v) { var c = P.capacity(v, m), ok = c.feasible && c.cap >= quick.mass.wet; return '<tr class="' + (c.feasible ? '' : 'dim') + '"><td><b>' + v.name + '</b></td><td>' + v.provider + ' · ' + v.site + ' (' + v.lat.toFixed(1) + '°)</td><td>' + (c.feasible ? esc(c.desc) : '<span class="muted">' + esc(c.reason) + '</span>') + '</td><td class="n">' + (c.feasible ? kg(c.cap) : '—') + '</td><td class="n">' + (c.feasible ? '<span class="chip ' + (ok ? 'ok' : 'bad') + '">' + (ok ? pct((c.cap - quick.mass.wet) / c.cap) + ' margin' : 'too heavy') + '</span>' : '') + '</td><td class="n">' + (v.rideshare ? '$' + (v.perKg * 1000).toFixed(1) + 'k/kg' : M$(v.price)) + '</td><td class="n">' + pct(v.reliability, 1) + '</td><td class="n">' + v.fairing + ' m</td></tr>'; }).join('') +
      '</tbody></table></div>' +
      '<div class="ch" style="margin-top:16px"><h3>Spacecraft propulsion options</h3></div><div class="tw"><table><thead><tr><th>System</th><th class="n">Isp</th><th class="n">Base mass</th><th class="n">Max Δv</th><th class="n">Failure prob.</th><th>Type</th></tr></thead><tbody>' +
      E.props().map(function (p) { return '<tr><td>' + p.name + '</td><td class="n">' + (p.isp || '—') + (p.isp ? ' s' : '') + '</td><td class="n">' + p.baseMass + ' kg</td><td class="n">' + (p.maxDv ? (p.maxDv * 1000).toLocaleString() + ' m/s' : '—') + '</td><td class="n">' + pct(p.pFail, 1) + '</td><td>' + (p.id === 'none' ? 'passive' : p.impulsive ? 'chemical, impulsive' : 'low-thrust, high Isp') + '</td></tr>'; }).join('') + '</tbody></table></div>';
  }

  /* ================= PAGE 2: PHYSICS ================= */
  R.physics = function () {
    if (!A.sel) return head('Physics engine', 'Orbital mechanics, Δv budget, propulsion sizing, mass and power budgets for the selected configuration.') + need('physics', 'The physics engine needs an optimised configuration first.');
    var r = A.sel, m = r.mission, oi = P.orbitInfo(m), pw = r.power, ms = r.mass, lifeOk = !(m.orbit === 'LEO' || m.orbit === 'SSO') || r.drag.lifetime <= 25 || r.dv.items.some(function (i) { return /de-orbit/.test(i.name); });
    return head('Physics engine', 'Orbital mechanics, Δv budget, propulsion sizing, mass and power budgets for the selected configuration.', cfgSelector()) +
      '<div class="kpis" style="margin-bottom:14px">' + kpi('Wet mass at launch', kg(ms.wet), 'dry ' + kg(ms.dry) + ' + propellant ' + kg(ms.prop)) + kpi('Launch capacity', r.drop.feasible ? kg(r.drop.cap) : '—', r.drop.feasible ? pct(r.massMargin) + ' margin on ' + r.vehicle.name : r.drop.reason, r.massMargin > 0.1 ? 'good' : r.massMargin > 0 ? 'warn' : 'bad') + kpi('Total Δv', n0(r.dvLoaded) + ' <small>m/s</small>', n0(r.dv.required) + ' m/s required') + kpi('Power margin (EOL)', pct(pw.margin), 'array ' + n0(pw.pEOL) + ' W vs need ' + n0(pw.pSA) + ' W', pw.margin >= 0.05 ? 'good' : 'warn') + kpi('Orbital period', (oi.period / 60).toFixed(1) + ' <small>min</small>', oi.v.toFixed(2) + ' km/s') + '</div>' +
      '<div class="grid">' +
      '<div class="card c6"><div class="ch"><h2>Δv budget</h2><span class="muted">' + r.prop.name + ', Isp ' + Math.round(ms.isp) + ' s</span></div><canvas class="chart" id="dvChart"></canvas><div class="legend" style="margin-top:8px"><span><i style="background:var(--cyan)"></i>required</span><span><i style="background:var(--fg3)"></i>optional (fitted if propellant allows)</span></div><p class="sub">Loaded Δv ' + n0(r.dvLoaded) + ' m/s including ' + pct(r.design.propMargin || 0) + ' propellant margin → ' + kg(ms.prop) + ' propellant by the rocket equation m<sub>p</sub> = m<sub>dry</sub>(e<sup>Δv/(Isp·g₀)</sup> − 1).' + (r.drop.dvSc ? ' Drop-off: ' + esc(r.drop.desc) + '.' : ' The vehicle injects directly into the target orbit.') + '</p></div>' +
      '<div class="card c6"><div class="ch"><h2>Mass budget</h2><span class="muted">payload fraction ' + pct(ms.payloadFrac) + '</span></div><canvas class="chart" id="massChart"></canvas><p class="sub">Subsystems scale with dry mass (structure 18%, thermal 4%, harness 5%, ADCS, avionics, comms) with a 15% system margin; power mass comes from the array and battery sizing; propulsion dry mass from tanks (' + pct(r.prop.tankFrac) + ' of propellant) and base hardware. Stowed diameter ≈ ' + ms.diameter.toFixed(1) + ' m vs ' + r.vehicle.fairing + ' m fairing.</p></div>' +
      '<div class="card c4"><div class="ch"><h2>Power budget</h2></div>' + facts([['Payload + bus load', n0(pw.pReq) + ' W'], pw.pEP ? ['Electric propulsion', n0(pw.pEP) + ' W'] : null, ['Eclipse per orbit', pw.eclipseMin.toFixed(1) + ' min (' + pct(pw.eclipseFrac) + ')'], ['Array need in sunlight', n0(pw.pSA) + ' W'], ['Array BOL / EOL', n0(pw.pBOL) + ' / ' + n0(pw.pEOL) + ' W'], ['Degradation', pct(pw.degr, 1) + ' per year, ' + m.life + ' yr'], ['Array area', pw.area.toFixed(2) + ' m² (' + n0(pw.flux) + ' W/m²)'], ['Battery', n0(pw.eBatt) + ' Wh at ' + pct(MP.ORBITS[m.orbit].dod) + ' DoD'], ['Power subsystem mass', pw.mass.toFixed(1) + ' kg']].filter(Boolean)) + '<div class="bar-row" style="margin-top:12px"><span>Sun / eclipse</span><div class="meter" style="background:var(--surface3)"><i style="width:' + pct(1 - pw.eclipseFrac) + ';background:var(--accent)"></i></div><span class="num">' + pct(1 - pw.eclipseFrac) + '</span></div></div>' +
      '<div class="card c4"><div class="ch"><h2>Orbit & environment</h2></div>' + facts([['Body', oi.body], ['Altitude', m.orbit === 'MARS' ? oi.ellipse : n0(m.alt) + ' km'], ['Inclination', m.orbit === 'MARS' ? '—' : m.inc.toFixed(1) + '°' + (m.orbit === 'SSO' ? ' (sun-synchronous)' : '')], oi.raan != null ? ['Nodal drift', oi.raan.toFixed(3) + ' °/day'] : null, oi.footprintFrac ? ['Earth footprint', pct(oi.footprintFrac, 1) + ' of surface'] : null, (m.orbit === 'LEO' || m.orbit === 'SSO') ? ['Natural orbit lifetime', (r.drag.lifetime >= 1000 ? '> 1000' : r.drag.lifetime.toFixed(1)) + ' yr'] : null, (m.orbit === 'LEO' || m.orbit === 'SSO') ? ['Drag make-up', r.drag.dvPerYear.toFixed(2) + ' m/s per yr (solar mean)'] : null, (m.orbit === 'LEO' || m.orbit === 'SSO') ? ['Ballistic coefficient', n0(r.drag.bc) + ' kg/m²'] : null, ['Radiation environment', MP.ORBITS[m.orbit].env.toFixed(1) + '× LEO baseline'], (m.orbit === 'LEO' || m.orbit === 'SSO') ? ['25-year disposal rule', lifeOk ? 'compliant' : 'needs de-orbit Δv'] : null].filter(Boolean)) + '</div>' +
      '<div class="card c4"><div class="ch"><h2>Mission risk (analytic)</h2></div>' + facts(r.risk.factors.map(function (f) { return [f[0], pct(f[1], 1)]; }).concat([['<b>Overall P(success)</b>', '<b>' + pct(r.risk.pTotal, 1) + '</b>']])) + '<p class="sub">P = product of independent factors; bus survival uses an exponential failure model with λ = ' + r.risk.lambda.toFixed(3) + ' /yr for this orbit class.</p></div>' +
      '<div class="card c12"><div class="ch"><h2>Launch vehicle capacity for this mission</h2><span class="muted">dashed line = spacecraft wet mass · grey bars cannot reach this orbit</span></div><canvas class="chart" id="capChart" data-h="260"></canvas></div>' +
      '</div>';
  };
  function head(t, s, right) { return '<div class="pagehead"><div><h1>' + t + '</h1><p>' + s + '</p></div>' + (right || '') + '</div>'; }
  D.physics = function () {
    if (!A.sel) return; var r = A.sel;
    CH.hbars($('#dvChart'), { items: r.dv.items.map(function (i) { return { label: i.name.replace(/ \(.*\)/, ''), value: i.dv, color: i.required ? CH.css('--cyan') : CH.css('--fg3'), dim: !i.required }; }), format: function (v) { return Math.round(v) + ' m/s'; } });
    var sub = r.mass.sub, names = { payload: 'Payload', structure: 'Structure', power: 'Power (arrays, battery)', adcs: 'Attitude control', avionics: 'Avionics', comms: 'Communications', thermal: 'Thermal', harness: 'Harness', propulsionDry: 'Propulsion (dry)', margin: 'System margin 15%' };
    var items = Object.keys(sub).map(function (k) { return { label: names[k] || k, value: sub[k], color: k === 'payload' ? CH.css('--accent') : CH.css('--cyan') }; }); items.push({ label: 'Propellant', value: r.mass.prop, color: CH.css('--violet') });
    CH.hbars($('#massChart'), { items: items, format: function (v) { return Math.round(v) + ' kg'; } });
    var caps = MP.VEHICLES.map(function (v) { return P.capacity(v, r.mission); });
    CH.vbars($('#capChart'), { labels: MP.VEHICLES.map(function (v) { return v.name; }), series: [{ values: caps.map(function (c) { return c.feasible ? c.cap : 0; }), colors: caps.map(function (c, i) { return !c.feasible ? CH.css('--fg3') : c.cap >= r.mass.wet ? (MP.VEHICLES[i].id === r.vehicle.id ? CH.css('--accent') : CH.css('--cyan')) : CH.css('--bad'); }) }], hline: { value: r.mass.wet, label: 'wet mass ' + n0(r.mass.wet) + ' kg' }, rotate: true, format: function (v) { return n0(v); }, height: 260 });
  };

  /* ================= PAGE 3: MONTE CARLO ================= */
  R.mc = function () {
    var h = head('Monte Carlo engine', 'Thousands of simulated missions with sampled mass growth, propellant performance, solar activity, array degradation, cost growth, schedule slip, injection error and random failures.', cfgSelector());
    if (!A.mc) return h + (A.status.mc === 'running' ? '<div class="card"><h2>Running ' + A.mcRuns.toLocaleString() + ' missions…</h2><div class="progress"><i id="mcProg" style="width:' + (A.mcProgress * 100) + '%"></i></div></div>' : need('mc', 'Monte Carlo results appear after the pipeline runs.'));
    var mc = A.mc, m = A.mission, ok = mc.meetsTarget;
    return h + '<div class="kpis" style="margin-bottom:14px">' + kpi('Mission success', pct(mc.pSuccess, 1), '± ' + pct(mc.ci, 1) + ' (95% CI) · target ' + pct(m.minP), ok ? 'good' : 'bad') + kpi('Cost P50 / P90', M$(mc.cost.p50) + ' / ' + M$(mc.cost.p90), pct(mc.cost.pOver) + ' of runs exceed the $' + m.budget + 'M budget', mc.cost.pOver < 0.2 ? 'good' : mc.cost.pOver < 0.5 ? 'warn' : 'bad') + kpi('Over launch capacity', pct(mc.massMargin.pNeg, 1), 'P10 mass margin ' + pct(mc.massMargin.p10), mc.massMargin.pNeg < 0.02 ? 'good' : 'warn') + kpi('Power shortfall', pct(mc.powerMargin.pNeg, 1), 'runs with negative EOL margin', mc.powerMargin.pNeg < 0.05 ? 'good' : 'warn') + kpi('Mean operational life', mc.lifetime.mean.toFixed(1) + ' <small>yr</small>', 'of ' + m.life + ' yr planned') + '</div>' +
      '<div class="grid">' +
      '<div class="card c5"><div class="ch"><h2>Why missions fail</h2><span class="muted">' + mc.n.toLocaleString() + ' runs</span></div>' + (mc.causes.length ? '<canvas class="chart" id="causeChart"></canvas>' : '<p class="muted">No failures in this sample.</p>') + '</div>' +
      '<div class="card c7"><div class="ch"><h2>Cost distribution</h2><span class="muted">mean ' + M$(mc.cost.mean) + '</span></div><canvas class="chart" id="costHist" data-h="220"></canvas></div>' +
      '<div class="card c6"><div class="ch"><h2>Launch mass margin</h2><span class="muted">negative = spacecraft outgrows the vehicle</span></div><canvas class="chart" id="marginHist" data-h="210"></canvas></div>' +
      '<div class="card c6"><div class="ch"><h2>Sensitivity: what drives cost</h2><span class="muted">correlation of each input with total cost</span></div><canvas class="chart" id="tornado"></canvas></div>' +
      '<div class="card c7"><div class="ch"><h2>Run cloud</h2><span class="muted">cost vs mass margin, 600 of ' + mc.n + ' runs</span></div><canvas class="chart" id="cloud" data-h="250"></canvas></div>' +
      '<div class="card c5"><div class="ch"><h2>Uncertainty model</h2></div><div class="tw"><table><thead><tr><th>Input</th><th>Distribution</th></tr></thead><tbody>' + [['Payload mass', 'Normal, σ = 8%'], ['Bus mass growth', 'Triangular 0 / 8 / 25%'], ['Propellant Isp', 'Normal, σ = 2%'], ['Solar activity (drag)', 'Low / moderate / high, ×0.5 / 1 / 2.5'], ['Array degradation', 'Normal, σ = 20% of nominal'], ['Cost growth', 'Log-normal, σ = 20%'], ['Schedule slip', 'Exponential, mean 4 months'], ['Launch', 'Bernoulli at vehicle reliability'], ['Bus failure', 'Exponential λ, 2% infant mortality']].map(function (r) { return '<tr><td>' + r[0] + '</td><td class="muted">' + r[1] + '</td></tr>'; }).join('') + '</tbody></table></div><div class="simctl" style="margin-top:10px"><label class="chip">Runs <select id="mcRunsSel" style="background:var(--surface2);border:0">' + [500, 1000, 2000, 5000].map(function (x) { return '<option' + (x === A.mcRuns ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label><button class="btn sm" id="mcAgain">Run again with a new seed</button></div></div>' +
      '</div>';
  };
  D.mc = function () {
    var mc = A.mc; if (!mc) return;
    if (mc.causes.length) CH.hbars($('#causeChart'), { items: mc.causes.map(function (c) { return { label: c.cause, value: c.p * 100, color: /launch|failure/.test(c.cause) ? CH.css('--bad') : CH.css('--warn') }; }), format: function (v) { return v.toFixed(1) + '%'; } });
    CH.hist($('#costHist'), { values: mc.cost.all, bins: 36, vline: { value: A.mission.budget, label: 'budget $' + A.mission.budget + 'M' }, markers: [{ value: mc.cost.p50, label: 'P50' }, { value: mc.cost.p90, label: 'P90' }], format: function (v) { return '$' + Math.round(v) + 'M'; }, colorFn: function (v) { return v > A.mission.budget ? CH.css('--bad') : CH.css('--cyan'); }, height: 220 });
    CH.hist($('#marginHist'), { values: mc.massMargin.all.map(function (v) { return v * 100; }), bins: 36, vline: { value: 0, label: 'capacity limit', color: CH.css('--bad') }, format: function (v) { return Math.round(v) + '%'; }, colorFn: function (v) { return v < 0 ? CH.css('--bad') : v < 10 ? CH.css('--warn') : CH.css('--good'); }, height: 210 });
    CH.tornado($('#tornado'), { items: mc.sensitivity.map(function (s) { return { label: s.name, value: s.cost }; }), format: function (v) { return v.toFixed(2); }, negLabel: 'lowers cost', posLabel: 'raises cost' });
    var runs = A.mcRunsCloud = null; var ev = []; var rnd = E.rng(3);
    // rebuild a sample of points from stored arrays
    var idx = []; for (var i = 0; i < Math.min(600, mc.n); i++) idx.push(Math.floor(rnd() * mc.n));
    CH.scatter($('#cloud'), { points: idx.map(function (i) { return { x: mc.massMargin.all[i] * 100, y: mc.cost.all[i], r: 2.5, color: mc.massMargin.all[i] < 0 ? CH.css('--bad') : CH.css('--cyan'), alpha: 0.55 }; }), xLabel: 'launch mass margin (%)', yLabel: 'total cost ($M)', xfmt: function (v) { return Math.round(v) + '%'; }, yfmt: function (v) { return '$' + Math.round(v); }, height: 250 });
  };

  /* ================= PAGE 4: OPTIMISATION + ML ================= */
  R.opt = function () {
    var h = head('Optimisation + machine learning', 'Simulated annealing searches launch vehicle, propulsion, altitude, inclination, array oversizing and propellant margin. Three surrogate models then learn the optimiser\'s answers so new missions can be estimated in microseconds.');
    if (!A.opt) return h + need('opt', 'Optimisation results appear after the pipeline runs.');
    var o = A.opt, b = o.best, ml = A.ml, m = A.mission, feas = o.evaluated.filter(function (r) { return r.feasible; }).length;
    var mlBlock;
    if (ml && !A.mlBusy) {
      var x = E.ml.features(m), pd = ml.dnn.predict(x), pg = ml.gp.predict(x), ps = ml.svr.predict(x);
      var probs = pd.probs.map(function (p, i) { return { v: MP.VEHICLES[i], p: p }; }).sort(function (a, c) { return c.p - a.p; }).slice(0, 4);
      mlBlock = '<div class="kpis" style="margin-bottom:12px">' + kpi('Optimiser per mission', (ml.msPerLabel).toFixed(1) + ' <small>ms</small>', '70 physics evaluations each') + kpi('DNN surrogate', ml.usPerPredict.toFixed(0) + ' <small>µs</small>', Math.round(ml.msPerLabel * 1000 / ml.usPerPredict).toLocaleString() + '× faster', 'accent') + kpi('Training set', ml.nTrain + ' / ' + ml.nTest, 'train / test missions') + '</div>' +
        '<div class="tw"><table><thead><tr><th>Model</th><th class="n">RMSE (log cost)</th><th class="n">Mean abs. error</th><th class="n">Vehicle accuracy</th><th class="n">Fit time</th></tr></thead><tbody>' +
        [['Deep neural network (13→32→32→12, Adam)', ml.dnn], ['Gaussian process (RBF kernel, Cholesky)', ml.gp], ['Support vector regression (ε-insensitive, RFF)', ml.svr]].map(function (r) { return '<tr><td>' + r[0] + '</td><td class="n">' + r[1].rmse.toFixed(3) + '</td><td class="n">' + pct(r[1].mape, 1) + '</td><td class="n">' + (r[1].acc != null ? pct(r[1].acc) : '—') + '</td><td class="n">' + r[1].ms + ' ms</td></tr>'; }).join('') + '</tbody></table></div>' +
        '<div class="grid" style="margin-top:12px"><div class="c6"><div class="ch"><h3>DNN training curve</h3></div><canvas class="chart" id="curveChart" data-h="190"></canvas></div><div class="c6"><div class="ch"><h3>Predicted vs optimiser cost (test set)</h3></div><canvas class="chart" id="pvaChart" data-h="190"></canvas></div></div>' +
        '<div class="ch" style="margin-top:14px"><h3>Surrogate prediction for this mission</h3><span class="muted">no optimisation needed</span></div><div class="kpis">' + kpi('DNN cost', M$(pd.cost), 'wet mass ' + kg(pd.wet)) + kpi('GP cost', M$(pg.cost), '95% band ' + M$(pg.lo) + ' – ' + M$(pg.hi)) + kpi('SVR cost', M$(ps.cost), '') + kpi('Optimiser (ground truth)', M$(b.cost.total), b.vehicle.name, 'accent') + '</div>' +
        '<div class="ch" style="margin-top:12px"><h3>DNN launch vehicle suggestion</h3><span class="muted">optimiser chose ' + b.vehicle.name + '</span></div><div class="probs">' + probs.map(function (p) { return '<div class="bar-row"><span>' + p.v.name + '</span><div class="meter"><i style="width:' + pct(p.p) + ';background:' + (p.v.id === b.vehicle.id ? 'var(--accent)' : 'var(--cyan)') + '"></i></div><span class="num">' + pct(p.p) + '</span></div>'; }).join('') + '</div>';
    } else mlBlock = '<p class="muted">' + (A.mlBusy ? A.mlMsg : 'Surrogates are trained when the pipeline runs.') + '</p><div class="progress"><i id="mlProg" style="width:' + (A.mlProgress * 100) + '%"></i></div><p class="tiny" id="mlMsg">' + A.mlMsg + '</p>';
    return h + '<div class="grid">' +
      '<div class="card c5"><div class="ch"><h2>Simulated annealing</h2><span class="muted">' + o.evals + ' evaluations in ' + o.ms + ' ms</span></div><div class="kpis" style="margin-bottom:12px">' + kpi('Best score', b.score.toFixed(3), 'lower is better') + kpi('Candidates', o.evaluated.length, feas + ' feasible') + kpi('Pareto-optimal', o.pareto.length, 'non-dominated designs') + '</div><canvas class="chart" id="convChart" data-h="200"></canvas><p class="sub">Score = ' + pct(A.weights.cost) + '·cost/budget + ' + pct(A.weights.risk) + '·normalised risk + ' + pct(A.weights.perf) + '·(1 − performance) + constraint penalties. Temperature cools from 0.6 to 0.002; worse moves are accepted with probability e<sup>−Δ/T</sup>.</p>' +
      '<div class="ch" style="margin-top:12px"><h3>Design space</h3></div>' + facts([['Launch vehicles', o.space.vehicles.length + ' options'], ['Propulsion', o.space.props.length + ' options'], ['Altitude', o.space.altHi > o.space.altLo ? o.space.altLo + ' – ' + o.space.altHi + ' km' : 'fixed'], ['Inclination', o.space.incEditable ? '0 – 98°' : 'fixed'], ['Array oversizing', '1.0 – 1.6×'], ['Propellant margin', '0 – 30%']]) + '<p class="sub"><b>Best design:</b> ' + b.label + ', ' + n0(b.design.alt) + ' km, arrays ×' + (b.design.arrayOversize || 1).toFixed(2) + ', propellant margin ' + pct(b.design.propMargin || 0) + '.</p></div>' +
      '<div class="card c7"><div class="ch"><h2>Pareto front: cost vs mission success</h2><span class="muted">bubble size = performance · amber = non-dominated · ring = recommended</span></div><canvas class="chart" id="paretoChart" data-h="330"></canvas><p class="sub">Every point is a distinct feasible design (vehicle, propulsion, altitude band) the optimiser evaluated: ' + o.distinct.length + ' of ' + o.evaluated.length + ' candidates. A design is Pareto-optimal when no other design is cheaper, safer and better-performing at the same time.</p></div>' +
      '<div class="card c12"><div class="ch"><h2>ML surrogates</h2><div class="simctl" style="margin:0"><label class="chip">Training missions <select id="mlNSel" style="background:var(--surface2);border:0">' + [150, 300, 600].map(function (x) { return '<option' + (x === A.mlN ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label><button class="btn sm" id="mlTrain"' + (A.mlBusy ? ' disabled' : '') + '>Generate dataset & retrain</button></div></div>' + mlBlock + '</div>' +
      '</div>';
  };
  D.opt = function () {
    var o = A.opt; if (!o) return;
    CH.line($('#convChart'), { series: [{ name: 'best', xs: o.history.map(function (h) { return h.iter; }), ys: o.history.map(function (h) { return h.score; }), color: CH.css('--accent'), width: 2 }, { name: 'current', xs: o.history.map(function (h) { return h.iter; }), ys: o.history.map(function (h) { return h.current; }), color: CH.css('--cyan'), width: 1, dash: [3, 3] }], xLabel: 'iteration', yLabel: 'score', height: 200, yfmt: function (v) { return v.toFixed(2); } });
    var feas = o.distinct, pset = {}; o.pareto.forEach(function (r) { pset[r.key] = 1; });
    var pts = feas.map(function (r) { return { x: r.cost.total, y: r.risk.pTotal * 100, r: 2 + r.perf.score * 6, color: pset[r.key] ? CH.css('--accent') : CH.css('--fg3'), alpha: pset[r.key] ? 0.95 : 0.4, ring: r.key === o.best.key ? CH.css('--cyan') : null, label: r.key === o.best.key ? 'recommended' : null }; });
    CH.scatter($('#paretoChart'), { points: pts, line: { points: o.pareto.map(function (r) { return { x: r.cost.total, y: r.risk.pTotal * 100 }; }), color: CH.css('--accent') }, xLabel: 'total cost ($M)', yLabel: 'P(success) %', xfmt: function (v) { return '$' + Math.round(v); }, yfmt: function (v) { return Math.round(v) + '%'; }, height: 330 });
    if (A.ml && !A.mlBusy) {
      var ml = A.ml; CH.line($('#curveChart'), { series: [{ name: 'loss', xs: ml.curve.map(function (_, i) { return i + 1; }), ys: ml.curve.map(function (v) { return Math.log10(v + 1e-6); }), color: CH.css('--cyan') }], xLabel: 'epoch', yLabel: 'log10 loss', height: 190, yfmt: function (v) { return v.toFixed(1); } });
      var tp = []; ml.test.forEach(function (t) { tp.push({ x: t.truth, y: t.dnn, color: CH.css('--cyan'), r: 2.5 }); tp.push({ x: t.truth, y: t.gp, color: CH.css('--accent'), r: 2.5 }); tp.push({ x: t.truth, y: t.svr, color: CH.css('--violet'), r: 2.5 }); });
      CH.scatter($('#pvaChart'), { points: tp, diag: true, xLabel: 'optimiser cost ($M)', yLabel: 'predicted ($M)', xfmt: function (v) { return '$' + Math.round(v); }, yfmt: function (v) { return '$' + Math.round(v); }, legend: [['DNN', CH.css('--cyan')], ['GP', CH.css('--accent')], ['SVR', CH.css('--violet')]], height: 190 });
    }
  };

  /* ================= PAGE 5: RECOMMENDATION & XAI ================= */
  R.rec = function () {
    var h = head('Recommendation & explainable AI', 'Ranked alternatives, the recommended configuration, and the reasons behind it: score decomposition, Shapley values from the cost surrogate, and counterfactuals.');
    if (!A.opt) return h + need('rec', 'Recommendations appear after the pipeline runs.');
    var o = A.opt, b = o.best, m = A.mission, mc = A.mc, sh = A.xai && A.xai.shap;
    var checks = [[b.feasible, b.feasible ? 'All hard constraints satisfied' : 'Infeasible: ' + b.violations.filter(function (v) { return v.w >= 3; }).map(function (v) { return v.msg; }).join('; ')], [b.cost.total <= m.budget, 'Cost ' + M$(b.cost.total) + ' vs budget $' + m.budget + 'M'], [b.risk.pTotal >= m.minP, 'Success probability ' + pct(b.risk.pTotal, 1) + ' vs required ' + pct(m.minP)], [b.massMargin >= 0.1, 'Launch mass margin ' + pct(b.massMargin) + (b.massMargin < 0.1 ? ' (below the 10% guideline)' : '')], [b.power.margin >= 0.05, 'EOL power margin ' + pct(b.power.margin)], [b.mass.diameter <= b.vehicle.fairing * 0.9, 'Fits ' + b.vehicle.fairing + ' m fairing (≈' + b.mass.diameter.toFixed(1) + ' m stowed)'], [!(b.transferDays > 365), 'Transfer time ' + Math.round(b.transferDays || 0) + ' days']];
    return h + '<div class="grid">' +
      '<div class="card hero c12"><div class="ch"><div><span class="chip ok">Recommended</span> <h2 style="display:inline;font-size:22px;margin-left:6px">' + b.vehicle.name + ' + ' + b.prop.name + '</h2></div><span class="muted">' + esc(b.drop.desc) + ' · ' + MP.ORBITS[m.orbit].name + ' ' + (m.orbit !== 'MARS' ? n0(b.design.alt) + ' km, ' + b.design.inc.toFixed(1) + '°' : '') + '</span></div>' +
      '<div class="kpis">' + kpi('Launch vehicle', b.vehicle.name, b.vehicle.provider + ' · ' + b.vehicle.site, 'accent') + kpi('Total cost', M$(b.cost.total), pct(b.cost.total / m.budget) + ' of budget', b.cost.total <= m.budget ? 'good' : 'bad') + kpi('Mission success', pct(b.risk.pTotal, 1), (mc ? 'Monte Carlo ' + pct(mc.pSuccess, 1) + ' · ' : '') + 'target ' + pct(m.minP), b.risk.pTotal >= m.minP ? 'good' : 'bad') + kpi('Performance', Math.round(b.perf.score * 100) + '<small>/100</small>', b.perf.parts[0][0]) + kpi('Configuration', kg(b.mass.wet), 'arrays ×' + (b.design.arrayOversize || 1).toFixed(2) + ' · ' + n0(b.dvLoaded) + ' m/s') + '</div>' +
      '<p class="narr" style="margin-top:14px">' + E.xai.narrative(m, b, o.ranked, mc) + '</p></div>' +
      '<div class="card c7"><div class="ch"><h2>Ranked alternatives</h2><span class="muted">best variant of each vehicle + propulsion pair · click to inspect</span></div><div class="tw"><table><thead><tr><th>#</th><th>Configuration</th><th class="n">Cost</th><th class="n">P(success)</th><th class="n">Perf.</th><th class="n">Score</th><th>Status</th></tr></thead><tbody>' +
      o.ranked.slice(0, 10).map(function (r, i) { return '<tr class="' + (A.sel && r.key === A.sel.key ? 'sel' : '') + (r.feasible ? '' : ' dim') + '" data-key="' + r.key + '" style="cursor:pointer"><td><span class="rank' + (i === 0 ? ' gold' : '') + '">' + (i + 1) + '</span></td><td><b>' + r.vehicle.name + '</b><br><span class="small muted">' + r.prop.name + ', ' + n0(r.design.alt) + ' km</span></td><td class="n">' + M$(r.cost.total) + '</td><td class="n">' + pct(r.risk.pTotal, 1) + '</td><td class="n">' + Math.round(r.perf.score * 100) + '</td><td class="n">' + r.score.toFixed(2) + '</td><td>' + (r.feasible ? (r.violations.length ? '<span class="chip warn">' + r.violations.length + ' warning' + (r.violations.length > 1 ? 's' : '') + '</span>' : '<span class="chip ok">ok</span>') : '<span class="chip bad">infeasible</span>') + '</td></tr>'; }).join('') + '</tbody></table></div></div>' +
      '<div class="card c5"><div class="ch"><h2>Constraint check</h2><span class="muted">recommended design</span></div><ul class="checks">' + checks.map(function (c) { return '<li class="' + (c[0] ? '' : 'bad') + '">' + c[1] + '</li>'; }).join('') + (b.violations.filter(function (v) { return v.w < 3; }).map(function (v) { return '<li class="warn">' + esc(v.msg) + '</li>'; }).join('')) + '</ul>' +
      '<div class="ch" style="margin-top:14px"><h3>Risk factors</h3></div><canvas class="chart" id="riskChart"></canvas></div>' +
      '<div class="card c6"><div class="ch"><h2>Why this ranking: score decomposition</h2><span class="muted">lower bars win</span></div><canvas class="chart" id="decompChart" data-h="230"></canvas><p class="sub">The objective is additive, so each configuration\'s score splits exactly into cost, risk, performance and penalty contributions.</p></div>' +
      '<div class="card c6"><div class="ch"><h2>What drives the cost (Shapley values)</h2><span class="muted">' + (sh ? 'exact, 7 feature groups, DNN surrogate' : 'needs the trained surrogate') + '</span></div>' + (sh ? '<canvas class="chart" id="shapChart"></canvas><p class="sub">Starting from an average mission (' + M$(sh.base) + '), each feature of this mission moves the predicted cost up or down. Contributions multiply to the surrogate\'s estimate of ' + M$(sh.out) + '.</p>' : '<p class="muted">' + (A.mlBusy ? 'Training surrogates…' : 'Run the pipeline to train the surrogate.') + '</p>') + '</div>' +
      '<div class="card c6"><div class="ch"><h2>Counterfactuals</h2><span class="muted">what would change the answer</span></div><ol class="plain">' + A.xai.cf.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ol></div>' +
      '<div class="card c6"><div class="ch"><h2>Performance breakdown</h2><span class="muted">' + MP.MISSION_TYPES[m.type].name + ' scoring</span></div><canvas class="chart" id="perfChart"></canvas></div>' +
      '</div>';
  };
  D.rec = function () {
    var o = A.opt; if (!o) return; var b = o.best;
    CH.hbars($('#riskChart'), { items: b.risk.factors.map(function (f) { return { label: f[0], value: f[1] * 100, color: f[1] > 0.97 ? CH.css('--good') : f[1] > 0.9 ? CH.css('--warn') : CH.css('--bad') }; }), max: 100, format: function (v) { return v.toFixed(1) + '%'; } });
    var top = o.ranked.slice(0, 4);
    CH.vbars($('#decompChart'), { labels: top.map(function (r, i) { return '#' + (i + 1) + ' ' + r.vehicle.name.replace('Falcon 9 Rideshare', 'F9 Rideshare').replace(' (A62)', '') + ' · ' + r.prop.name.split(' (')[0].replace('Monopropellant', 'Mono').replace('Bipropellant', 'Biprop').replace('Green monoprop', 'Green').replace('No propulsion', 'none'); }), series: [{ name: 'cost', color: CH.css('--cyan'), values: top.map(function (r) { return r.terms.cost; }) }, { name: 'risk', color: CH.css('--violet'), values: top.map(function (r) { return r.terms.risk; }) }, { name: 'performance', color: CH.css('--accent'), values: top.map(function (r) { return r.terms.perf; }) }, { name: 'penalties', color: CH.css('--bad'), values: top.map(function (r) { return Math.min(r.terms.penalty, 5); }) }], stacked: true, showValues: true, format: function (v) { return v.toFixed(2); }, height: 230 });
    if (A.xai.shap && $('#shapChart')) CH.tornado($('#shapChart'), { items: A.xai.shap.items.map(function (i) { return { label: i.name, value: i.pct * 100 }; }), format: function (v) { return v.toFixed(0) + '%'; }, negLabel: 'cheaper than average', posLabel: 'more expensive' });
    CH.hbars($('#perfChart'), { items: b.perf.parts.map(function (p) { return { label: p[0] + ' (w ' + p[1] + ')', value: p[2] * 100, color: CH.css('--accent') }; }), max: 100, format: function (v) { return Math.round(v) + '/100'; } });
  };

  /* ================= PAGE 6: SIMULATION ================= */
  R.sim = function () {
    var h = head('Digital mission simulation', 'The selected configuration flies its full mission: ascent, transfer burns, commissioning, operations with eclipse cycles and station keeping, then disposal. Telemetry comes from the physics models.', cfgSelector());
    if (!A.sel) return h + need('sim', 'The simulation needs an optimised configuration first.');
    return h + '<div class="card"><div class="simwrap"><div><canvas id="simcv"></canvas><div class="simctl"><button class="btn sm" id="simPlay">Pause</button><button class="btn sm" id="simRestart">Restart</button><label class="chip">Speed <select id="simSpeed" style="background:var(--surface2);border:0">' + [0.25, 0.5, 1, 2, 4, 8].map(function (s) { return '<option value="' + s + '"' + (s === 1 ? ' selected' : '') + '>' + s + '×</option>'; }).join('') + '</select></label><span class="tiny" id="simRate"></span></div><div class="timeline" id="simTl"></div><div class="tlabels"><span>liftoff</span><span>mission end</span></div><div class="phlist" id="simPh"></div><p class="tiny" style="margin-top:14px">Click a phase to jump to it. Long phases run at a compressed rate; the orbit animation is capped at one revolution every few seconds so eclipses stay visible.</p></div>' +
      '<div><div class="tele" id="simTele"></div><div class="ch" style="margin-top:12px"><h3>Event log</h3></div><ul class="evlog" id="simLog"></ul></div></div></div>';
  };
  D.sim = function () {
    var cv = $('#simcv'); if (!cv || !A.sel) return;
    if (!A.sim || A.sim.ev !== A.sel) A.sim = new MP.Sim(A.sel, cv); else { A.sim.cv = cv; A.sim.ctx = cv.getContext('2d'); A.sim.dirtyLog = true; }
    A.sim.playing = true; $('#simPlay').textContent = 'Pause';
    renderTimeline();
    if (!A.loop) { var last = performance.now(); var loop = function (now) { var dt = Math.min(0.1, (now - last) / 1000); last = now; if (A.page === 'sim' && A.sim && $('#simcv')) { A.sim.update(dt); A.sim.draw(); updateTele(); } requestAnimationFrame(loop); }; A.loop = true; requestAnimationFrame(loop); }
  };
  function renderTimeline() {
    var s = A.sim, ph = s.phases.filter(function (p) { return p.kind !== 'end'; }), cur = s.phaseIndex(s.t);
    var wts = ph.map(function (p) { return Math.log10(p.dur / 60 + 10); });
    $('#simTl').innerHTML = ph.map(function (p, i) { return '<button title="' + esc(p.name) + ' · ' + MP.Sim.fmtDur(p.dur) + '" data-ph="' + i + '" class="' + (i === cur ? 'on' : i < cur ? 'past' : '') + '" style="flex-grow:' + wts[i].toFixed(2) + '"></button>'; }).join('');
    $('#simPh').innerHTML = ph.map(function (p, i) { return '<span data-ph="' + i + '" class="' + (i === cur ? 'on' : '') + '" style="cursor:pointer">' + (i + 1) + '. ' + esc(p.name) + ' · ' + MP.Sim.fmtDur(p.dur) + '</span>'; }).join('');
  }
  var teleLast = 0;
  function updateTele() {
    var s = A.sim, tl = s.telemetry(), now = performance.now(); if (now - teleLast < 120) return; teleLast = now;
    var cur = s.phaseIndex(s.t); $$('#simTl button').forEach(function (b, i) { b.className = i === cur ? 'on' : i < cur ? 'past' : ''; }); $$('#simPh span').forEach(function (b, i) { b.className = i === cur ? 'on' : ''; });
    var ph = s.phases[cur]; $('#simRate').textContent = ph.kind === 'end' ? 'mission complete' : '1 s real ≈ ' + MP.Sim.fmtDur(ph.rate * s.speed) + ' of mission time' + (tl.slowed ? ' · orbit animation slowed' : '');
    var altStr = tl.view === 'helio' ? (tl.alt / C.AU + 1).toFixed(3) + ' AU' : tl.view === 'cislunar' ? n0(tl.alt / 1000) + 'k km' : n0(tl.alt) + ' km';
    $('#simTele').innerHTML = kpi('Mission time', '<span class="mono" style="font-size:18px">' + MP.Sim.fmtT(tl.t) + '</span>', esc(tl.phase)) + kpi(tl.view === 'helio' ? 'Distance from Sun' : tl.view === 'cislunar' ? 'Distance from Earth' : 'Altitude', altStr, tl.view === 'helio' ? 'heliocentric' : tl.view === 'cislunar' ? 'coasting to the Moon' : 'above ' + s.body) + kpi('Speed', tl.v.toFixed(2) + ' <small>km/s</small>', tl.view === 'helio' ? 'relative to Sun' : 'inertial') + kpi('Solar array', n0(tl.pArray) + ' <small>W</small>', tl.inShadow ? 'in eclipse · load ' + n0(tl.load) + ' W' : 'in sunlight · load ' + n0(tl.load) + ' W', tl.inShadow ? 'warn' : 'good') + kpi('Battery', pct(tl.soc) , n0(s.eBatt) + ' Wh capacity', tl.soc < 0.3 ? 'bad' : tl.soc < 0.6 ? 'warn' : 'good') + kpi('Propellant', s.prop0 ? n0(tl.propLeft) + ' <small>kg</small>' : '—', s.prop0 ? pct(tl.propFrac) + ' · ' + n0(tl.dvLeft) + ' m/s left' : 'no propulsion fitted', tl.propFrac < 0.15 && s.prop0 ? 'warn' : '') + kpi(tl.view === 'helio' || tl.view === 'cislunar' ? 'Days in transit' : 'Orbits completed', tl.view === 'helio' || tl.view === 'cislunar' ? n0((tl.t - s.tInj) / 86400) : n0(tl.orbits), tl.view === 'helio' || tl.view === 'cislunar' ? 'of ' + n0(s.phases[1].dur / 86400) + ' planned' : 'period ' + (s.T / 60).toFixed(0) + ' min') + kpi('Spacecraft mass', n0(tl.mass) + ' <small>kg</small>', 'dry ' + n0(s.mDry) + ' kg');
    if (s.dirtyLog) { s.dirtyLog = false; $('#simLog').innerHTML = s.events.map(function (e) { return '<li><time>' + MP.Sim.fmtT(e.t).replace('T+ ', '') + '</time><span>' + esc(e.msg) + '</span></li>'; }).join(''); }
  }

  /* ================= PAGE 7: FINAL ANALYSIS ================= */
  R.final = function () {
    var h = head('Final analysis', 'System outputs for the recommended mission: launch vehicle, orbit, configuration, cost, risk and performance, with the evidence behind each.');
    if (!A.opt) return h + need('final', 'The final analysis appears after the pipeline runs.');
    var b = A.opt.best, m = A.mission, mc = A.mc, c = b.cost;
    var out = [['Launch vehicle', b.vehicle.name + ' (' + b.vehicle.provider + ', ' + b.vehicle.site + ')'], ['Orbit', MP.ORBITS[m.orbit].name + (m.orbit !== 'MARS' ? ', ' + n0(b.design.alt) + ' km, ' + b.design.inc.toFixed(1) + '°' : ', 300 × 70,000 km')], ['Configuration', b.prop.name + '; ' + kg(b.mass.wet) + ' wet (' + kg(b.mass.dry) + ' dry); arrays ' + b.power.area.toFixed(1) + ' m² ×' + (b.design.arrayOversize || 1).toFixed(2) + '; battery ' + n0(b.power.eBatt) + ' Wh'], ['Cost', M$(c.total) + ' (' + pct(c.total / m.budget) + ' of budget; Monte Carlo P50 ' + (mc ? M$(mc.cost.p50) : '—') + ', P90 ' + (mc ? M$(mc.cost.p90) : '—') + ')'], ['Risk', pct(b.risk.pTotal, 1) + ' analytic, ' + (mc ? pct(mc.pSuccess, 1) + ' Monte Carlo' : '—') + ' vs ' + pct(m.minP) + ' required'], ['Performance', Math.round(b.perf.score * 100) + '/100 (' + b.perf.parts.map(function (p) { return p[0] + ' ' + Math.round(p[2] * 100); }).join(', ') + ')']];
    return h + '<div class="grid">' +
      '<div class="card hero c12"><div class="ch"><h2>' + esc(m.name) + '</h2><span class="chip ' + (b.feasible && b.cost.total <= m.budget && b.risk.pTotal >= m.minP ? 'ok' : 'warn') + '">' + (b.feasible && b.cost.total <= m.budget && b.risk.pTotal >= m.minP ? 'Meets all requirements' : 'Review flagged items') + '</span></div><div class="tw"><table><tbody>' + out.map(function (r) { return '<tr><th style="width:160px">' + r[0] + '</th><td>' + r[1] + '</td></tr>'; }).join('') + '</tbody></table></div></div>' +
      '<div class="card c6"><div class="ch"><h2>Cost breakdown</h2><span class="muted">USD million</span></div><canvas class="chart" id="costDonut" data-h="210"></canvas></div>' +
      '<div class="card c6"><div class="ch"><h2>Mass breakdown</h2><span class="muted">kg at launch</span></div><canvas class="chart" id="massDonut" data-h="210"></canvas></div>' +
      '<div class="card c6"><div class="ch"><h2>Evidence summary</h2></div><ul class="checks">' + [[true, 'Physics: ' + n0(b.dvLoaded) + ' m/s Δv loaded, ' + pct(b.massMargin) + ' launch margin, ' + pct(b.power.margin) + ' power margin'], [mc ? mc.meetsTarget : true, mc ? 'Monte Carlo: ' + pct(mc.pSuccess, 1) + ' success over ' + mc.n.toLocaleString() + ' runs; top failure cause ' + (mc.causes[0] ? mc.causes[0].cause : 'none') : 'Monte Carlo pending'], [true, 'Optimisation: ' + A.opt.evaluated.length + ' candidates, ' + A.opt.pareto.length + ' Pareto-optimal, best score ' + b.score.toFixed(3)], [!!A.ml, A.ml ? 'ML surrogates: GP error ' + pct(A.ml.gp.mape, 1) + ', DNN vehicle accuracy ' + pct(A.ml.dnn.acc) + ', ' + Math.round(A.ml.msPerLabel * 1000 / A.ml.usPerPredict).toLocaleString() + '× faster than optimising' : 'ML surrogates not trained'], [true, 'XAI: ' + A.xai.cf.length + ' counterfactual' + (A.xai.cf.length > 1 ? 's' : '') + (A.xai.shap ? ', Shapley cost attribution available' : '')]].map(function (x) { return '<li class="' + (x[0] ? '' : 'warn') + '">' + x[1] + '</li>'; }).join('') + '</ul></div>' +
      '<div class="card c6"><div class="ch"><h2>Assumptions & limits</h2></div><ul class="checks" style="font-size:12.5px">' + ['Launch vehicle capacities, prices and flight records are approximate public figures; capacities to non-standard orbits are scaled with an effective exhaust velocity calibrated from LEO and GTO anchors.', 'Spacecraft mass, power and cost use parametric relations suitable for preliminary (pre-Phase A) sizing, not detailed design.', 'Reliability uses a Bayesian launch record and an exponential bus failure model; it does not model specific components.', 'Transfers are impulsive two-body manoeuvres (plus a 30% low-thrust factor for electric propulsion); no launch-window or n-body effects.', 'Atmospheric drag uses an exponential atmosphere with three solar-activity levels.'].map(function (t) { return '<li class="warn">' + t + '</li>'; }).join('') + '</ul></div>' +
      '<div class="card c12"><div class="ch"><h2>Export</h2><div class="simctl" style="margin:0"><button class="btn sm" id="copyReport">Copy report text</button><button class="btn sm" id="copyJson">Copy JSON</button></div></div><pre class="json" id="jsonOut">' + esc(JSON.stringify(exportObj(), null, 2)) + '</pre></div>' +
      '</div>';
  };
  function exportObj() {
    var b = A.opt.best, m = A.mission, mc = A.mc;
    return { mission: m, weights: A.weights, recommendation: { vehicle: b.vehicle.name, propulsion: b.prop.name, altitude_km: b.design.alt, inclination_deg: b.design.inc, arrayOversize: b.design.arrayOversize, propellantMargin: b.design.propMargin, dropOff: b.drop.desc },
      physics: { wetMass_kg: Math.round(b.mass.wet), dryMass_kg: Math.round(b.mass.dry), propellant_kg: Math.round(b.mass.prop), dv_mps: Math.round(b.dvLoaded), dvItems: b.dv.items.map(function (i) { return { item: i.name, dv_mps: Math.round(i.dv), required: i.required }; }), launchCapacity_kg: Math.round(b.drop.cap), massMargin: +b.massMargin.toFixed(3), arrayArea_m2: +b.power.area.toFixed(2), arrayBOL_W: Math.round(b.power.pBOL), battery_Wh: Math.round(b.power.eBatt), powerMargin: +b.power.margin.toFixed(3), orbitLifetime_yr: +b.drag.lifetime.toFixed(1) },
      cost_MUSD: Object.keys(b.cost).reduce(function (o, k) { o[k] = +b.cost[k].toFixed(1); return o; }, {}), risk: { pSuccess: +b.risk.pTotal.toFixed(4), factors: b.risk.factors.map(function (f) { return { factor: f[0], p: +f[1].toFixed(4) }; }) }, performance: { score: +b.perf.score.toFixed(3), parts: b.perf.parts.map(function (p) { return { metric: p[0], weight: p[1], score: +p[2].toFixed(3) }; }) },
      monteCarlo: mc ? { runs: mc.n, pSuccess: +mc.pSuccess.toFixed(4), costP50: +mc.cost.p50.toFixed(1), costP90: +mc.cost.p90.toFixed(1), pOverBudget: +mc.cost.pOver.toFixed(3), causes: mc.causes } : null,
      alternatives: A.opt.ranked.slice(0, 5).map(function (r) { return { config: r.label, cost: +r.cost.total.toFixed(1), pSuccess: +r.risk.pTotal.toFixed(3), performance: +r.perf.score.toFixed(3), score: +r.score.toFixed(3), feasible: r.feasible }; }),
      counterfactuals: A.xai.cf, generatedBy: 'AstraPlan' };
  }
  function reportText() { var o = exportObj(), b = A.opt.best; return 'ASTRAPLAN MISSION REPORT: ' + A.mission.name + '\n\nRecommended: ' + b.vehicle.name + ' + ' + b.prop.name + '\nOrbit: ' + o.recommendation.dropOff + ' -> ' + MP.ORBITS[A.mission.orbit].name + ' ' + o.recommendation.altitude_km + ' km\nWet mass: ' + o.physics.wetMass_kg + ' kg (margin ' + pct(b.massMargin) + ')\nDelta-v: ' + o.physics.dv_mps + ' m/s\nCost: $' + o.cost_MUSD.total + 'M of $' + A.mission.budget + 'M budget\nP(success): ' + pct(b.risk.pTotal, 1) + (A.mc ? ' (Monte Carlo ' + pct(A.mc.pSuccess, 1) + ')' : '') + '\nPerformance: ' + Math.round(b.perf.score * 100) + '/100\n\n' + E.xai.narrative(A.mission, b, A.opt.ranked, A.mc) + '\n\nCounterfactuals:\n- ' + A.xai.cf.join('\n- ') + '\n\nAlternatives:\n' + o.alternatives.map(function (a, i) { return (i + 1) + '. ' + a.config + ' — $' + a.cost + 'M, P ' + pct(a.pSuccess, 1) + ', perf ' + Math.round(a.performance * 100) + (a.feasible ? '' : ' (infeasible)'); }).join('\n'); }
  D.final = function () {
    var b = A.opt && A.opt.best; if (!b) return; var c = b.cost, cols = [CH.css('--cyan'), CH.css('--accent'), CH.css('--violet'), CH.css('--good'), CH.css('--bad'), CH.css('--fg2'), CH.css('--fg3'), '#D98CB3'];
    CH.donut($('#costDonut'), { items: [['Launch', c.launch], ['Payload', c.payload], ['Bus', c.bus], ['Propulsion', c.propulsion], ['AIT', c.ait], ['Operations', c.ops], ['Insurance', c.insurance], ['Management', c.pm]].map(function (x, i) { return { label: x[0], value: x[1], color: cols[i] }; }), center: M$(c.total), centerSub: 'total', format: function (v) { return '$' + v.toFixed(1) + 'M' ; }, height: 210 });
    var s = b.mass.sub; CH.donut($('#massDonut'), { items: [['Payload', s.payload], ['Structure', s.structure], ['Power', s.power], ['Propulsion dry', s.propulsionDry], ['Propellant', b.mass.prop], ['Other subsystems', s.adcs + s.avionics + s.comms + s.thermal + s.harness], ['Margin', s.margin]].map(function (x, i) { return { label: x[0], value: x[1], color: cols[i] }; }), center: n0(b.mass.wet), centerSub: 'kg wet', format: function (v) { return Math.round(v) + ' kg'; }, height: 210 });
  };

  /* ---------- events ---------- */
  function copyText(t, label) { var ok = function () { toast(label || 'Copied'); }, fb = function () { var ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'; document.body.appendChild(ta); ta.select(); var d = false; try { d = document.execCommand('copy'); } catch (e) { } ta.remove(); d ? ok() : toast('Copy blocked: select the text and press Ctrl+C'); }; if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok, fb); else fb(); }
  var tt; function toast(msg) { var el = $('#toast'); el.textContent = msg; el.classList.add('on'); clearTimeout(tt); tt = setTimeout(function () { el.classList.remove('on'); }, 3200); }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('button, tr[data-key], span[data-ph]'); if (!b) return;
    if (b.dataset.page) return go(b.dataset.page);
    if (b.id === 'runBtn' || b.id === 'runBtn2') return runPipeline();
    if (b.id === 'themeBtn') { var r = document.documentElement, cur = r.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'); r.dataset.theme = cur === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('astra-theme', r.dataset.theme); } catch (x) { } drawStars(); render(); return; }
    if (b.id === 'aboutBtn') { var d = $('#about'); d.showModal ? d.showModal() : d.setAttribute('open', ''); return; }
    if (b.dataset.preset) { loadPreset(b.dataset.preset); markStale(); render(); return; }
    if (b.dataset.key) { selectConfig(b.dataset.key); return; }
    if (b.id === 'mcAgain') { A.seed = Math.floor(Math.random() * 1e6); A.mcRuns = +$('#mcRunsSel').value; A.status.mc = 'running'; A.mc = null; render(); E.monteCarlo(A.mission, A.sel.design, A.weights, A.mcRuns, A.seed, function (p) { A.mcProgress = p; var el = $('#mcProg'); if (el) el.style.width = (p * 100) + '%'; }, function (mc) { A.mc = mc; A.status.mc = 'done'; renderSteps(); render(); }); return; }
    if (b.id === 'mlTrain') { A.mlN = +$('#mlNSel').value; A.ml = null; A.mlBusy = true; render(); trainML(null); return; }
    if (b.id === 'simPlay') { A.sim.playing = !A.sim.playing; b.textContent = A.sim.playing ? 'Pause' : 'Play'; return; }
    if (b.id === 'simRestart') { A.sim = new MP.Sim(A.sel, $('#simcv')); renderTimeline(); $('#simPlay').textContent = 'Pause'; return; }
    if (b.dataset.ph != null) { A.sim.jump(+b.dataset.ph); A.sim.playing = true; $('#simPlay').textContent = 'Pause'; return; }
    if (b.id === 'copyReport') return copyText(reportText(), 'Report copied');
    if (b.id === 'copyJson') return copyText(JSON.stringify(exportObj(), null, 2), 'JSON copied');
  });
  document.addEventListener('input', function (e) {
    var el = e.target, m = A.mission;
    if (el.dataset.k) {
      var k = el.dataset.k, v = el.type === 'number' || el.type === 'range' ? parseFloat(el.value) : el.value;
      if (el.type === 'number' && isNaN(v)) return;
      if (k === 'orbit') { var o = MP.ORBITS[v]; m.orbit = v; m.alt = v === 'GEO' ? 35786 : v === 'MARS' ? 0 : v === 'MEO' ? 20200 : v === 'LUNAR' ? 100 : 550; m.inc = v === 'MEO' ? 55 : v === 'LEO' ? 45 : 0; m.flex = o.flex ? 50 : 0; normaliseMission(); markStale(); render(); return; }
      m[k] = v; m.preset = null; normaliseMission();
      if (k === 'alt' && m.orbit === 'SSO') $('#f-inc').value = m.inc;
      if (k === 'minP') el.previousElementSibling.querySelector('span').textContent = pct(m.minP);
      markStale(); $('#summaryCard').innerHTML = summaryCard(); if (k !== 'name') $('#dbCard').innerHTML = dbCard();
      return;
    }
    if (el.dataset.w) { A.weights[el.dataset.w] = parseFloat(el.value); var s = A.weights.cost + A.weights.risk + A.weights.perf || 1; ['cost', 'risk', 'perf'].forEach(function (w) { A.weights[w] = Math.round(A.weights[w] / s * 100) / 100; var inp = $('[data-w=' + w + ']'); if (inp !== el) inp.value = A.weights[w]; $('#w-' + w).textContent = pct(A.weights[w]); }); markStale(); return; }
    if (el.dataset.s) { A[el.dataset.s] = parseFloat(el.value); return; }
    if (el.id === 'cfgSel') return selectConfig(el.value);
    if (el.id === 'simSpeed') { A.sim.speed = parseFloat(el.value); return; }
  });
  document.addEventListener('change', function (e) { var el = e.target; if (el.dataset.k === 'type') { A.mission.type = el.value; A.mission.preset = null; markStale(); $('#summaryCard').innerHTML = summaryCard(); } if (el.dataset.s) A[el.dataset.s] = parseFloat(el.value); if (el.id === 'cfgSel') selectConfig(el.value); if (el.id === 'simSpeed' && A.sim) A.sim.speed = parseFloat(el.value); });
  var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { drawStars(); if (A.page !== 'sim') render(); }, 200); });

  function drawStars() { var cv = $('#stars'), dpr = window.devicePixelRatio || 1, w = innerWidth, h = innerHeight; cv.width = w * dpr; cv.height = h * dpr; var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); var dark = CH.css('--scheme') !== 'light', r = E.rng(5); for (var i = 0; i < 160; i++) { var x = r() * w, y = r() * h, s = 0.4 + r() * 1.3; ctx.fillStyle = dark ? 'rgba(200,215,255,' + (0.15 + r() * 0.35) + ')' : 'rgba(30,50,90,' + (0.05 + r() * 0.1) + ')'; ctx.fillRect(x, y, s, s); } }

  /* ---------- boot ---------- */
  try { var th = localStorage.getItem('astra-theme'); if (th) document.documentElement.dataset.theme = th; } catch (x) { }
  var hash = (location.hash || '').replace('#', ''), startPage = PAGES.some(function (p) { return p.id === hash; }) ? hash : null;
  loadPreset(MP.PRESETS.some(function (p) { return p.id === hash; }) ? hash : 'eo'); drawStars(); renderSteps(); render();
  setTimeout(function () { if (startPage) go(startPage); runPipeline(); }, 400);
})();

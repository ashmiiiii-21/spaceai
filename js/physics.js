/* =========================================================================
   PHYSICS ENGINE
   Orbits, Δv budget, launch vehicle capacity, mass, power, drag, lifetime.
   Units: km, km/s inside orbital maths; m/s for Δv line items; kg; W; years.
   ========================================================================= */
(function () {
  var C = MP.CONST, RAD = Math.PI / 180;
  var P = MP.physics = {};

  /* ---------- basic orbital mechanics ---------- */
  P.vCirc = function (r, mu) { return Math.sqrt((mu || C.MU) / r); };
  P.period = function (a, mu) { return 2 * Math.PI * Math.sqrt(a * a * a / (mu || C.MU)); };
  P.hohmann = function (r1, r2, mu) {
    mu = mu || C.MU;
    var a = (r1 + r2) / 2, v1 = Math.sqrt(mu / r1), v2 = Math.sqrt(mu / r2);
    var vp = Math.sqrt(mu * (2 / r1 - 1 / a)), va = Math.sqrt(mu * (2 / r2 - 1 / a));
    return { dv1: Math.abs(vp - v1), dv2: Math.abs(v2 - va), total: Math.abs(vp - v1) + Math.abs(v2 - va),
             tof: Math.PI * Math.sqrt(a * a * a / mu), a: a };
  };
  // Δv for a combined speed-change + plane-change burn
  P.combined = function (v1, v2, diDeg) { var di = diDeg * RAD; return Math.sqrt(v1 * v1 + v2 * v2 - 2 * v1 * v2 * Math.cos(di)); };
  // Sun-synchronous inclination for a circular orbit at altitude alt (km)
  P.ssoInc = function (alt) {
    var r = C.RE + alt, n = Math.sqrt(C.MU / (r * r * r));
    var cosi = -C.OMEGA_SSO * 2 * r * r / (3 * C.J2 * C.RE * C.RE * n);
    return Math.acos(Math.max(-1, Math.min(1, cosi))) / RAD;
  };
  // J2 nodal regression, deg/day
  P.raanDrift = function (alt, incDeg) {
    var r = C.RE + alt, n = Math.sqrt(C.MU / (r * r * r));
    return -1.5 * n * C.J2 * Math.pow(C.RE / r, 2) * Math.cos(incDeg * RAD) * 86400 / RAD;
  };
  // Worst-case eclipse fraction of an orbit
  P.eclipseFraction = function (cls, alt) {
    if (cls === 'GEO') return 72 / 1440;             // 72 min at equinox
    if (cls === 'MARS') return 0.25;                  // elliptical capture orbit, conservative
    if (cls === 'LUNAR') return Math.asin(C.R_MOON / (C.R_MOON + alt)) / Math.PI;
    return Math.asin(C.RE / (C.RE + alt)) / Math.PI;
  };
  P.isEarthBound = function (cls) { return cls === 'LEO' || cls === 'SSO' || cls === 'MEO' || cls === 'GEO'; };

  /* ---------- atmosphere and drag ---------- */
  P.density = function (alt, activity) {
    var t = MP.ATMOS, row = t[0];
    if (alt < 150) alt = 150;
    for (var i = 0; i < t.length; i++) if (alt >= t[i][0]) row = t[i];
    return row[1] * Math.exp(-(alt - row[0]) / row[2]) * (activity || 1);
  };
  P.dragArea = function (mass) { return 0.01 * Math.pow(Math.max(mass, 0.5), 2 / 3); }; // m^2, cross-section estimate
  // Drag deceleration (m/s^2) for a circular orbit
  P.dragAccel = function (alt, mass, activity) {
    var r = C.RE + alt, v = Math.sqrt(C.MU / r) * 1000, rho = P.density(alt, activity);
    var cda = 2.2 * P.dragArea(mass) / mass;
    return 0.5 * rho * v * v * cda;
  };
  var lifeCache = {};
  // Orbital lifetime (years) from a circular orbit at alt until 150 km, stepping altitude down
  P.lifetime = function (alt, mass, activity) {
    if (alt > 1500) return 1000;
    var key = Math.round(alt / 5) + ':' + Math.round(Math.log(mass) * 8) + ':' + activity;
    if (lifeCache[key] != null) return lifeCache[key];
    var h = alt, t = 0, dh = 2, max = 1000 * C.YEAR;
    while (h > 150 && t < max) {
      var a = C.RE + h, ad = P.dragAccel(h, mass, activity) / 1000;     // km/s^2
      var v = Math.sqrt(C.MU / a), dadt = 2 * a * a * v * ad / C.MU;    // km/s
      t += dh / dadt; h -= dh;
    }
    var yrs = Math.min(t / C.YEAR, 1000);
    lifeCache[key] = yrs; return yrs;
  };
  // Δv (m/s) to lower perigee from a circular orbit at alt to 300 km (end-of-life disposal)
  P.deorbitDv = function (alt) {
    if (alt <= 300) return 0;
    var ra = C.RE + alt, rp = C.RE + 300, a = (ra + rp) / 2;
    return (Math.sqrt(C.MU / ra) - Math.sqrt(C.MU * (2 / ra - 1 / a))) * 1000;
  };

  /* ---------- launch vehicle capacity ---------- */
  // Effective exhaust velocity for scaling capacity between orbits, calibrated from the LEO and GTO anchors
  P.cEff = function (v) {
    if (v.leo > 0 && v.gto > 0) { var dvGto = 2.44, c = dvGto / Math.log(v.leo / v.gto); return Math.max(1.9, Math.min(3.2, c)); }
    return 2.4;
  };
  // Velocity penalty (km/s) for launching into inclination inc from a site at latitude lat
  P.rotPenalty = function (lat, inc) {
    var cl = Math.cos(lat * RAD);
    if (inc >= lat) return C.V_ROT_EQ * (cl - Math.cos(inc * RAD));
    // target inclination below site latitude: needs a dog-leg plane change
    return C.V_ROT_EQ * (cl - Math.cos(lat * RAD)) + 2 * 7.8 * Math.sin((lat - inc) * RAD / 2);
  };
  P.gtoInc = function (v) { return v.gtoInc != null ? v.gtoInc : Math.max(v.lat, 5); };

  /* Returns what the vehicle can deliver for this mission and what the spacecraft must do afterwards.
     drop = {cap kg, desc, alt, inc, dvSpacecraft (km/s), days, kind} */
  P.capacity = function (v, m) {
    var cls = m.orbit, alt = m.alt, inc = m.inc, c = P.cEff(v), r = C.RE + alt;
    var out = { feasible: true, reason: '', cap: 0, desc: '', dropAlt: alt, dropInc: inc, dvSc: 0, days: 0, kind: 'direct' };
    if (v.rideshare) {
      if (cls !== 'SSO' && !(cls === 'LEO' && Math.abs(inc - 97.5) < 3)) { out.feasible = false; out.reason = 'Rideshare drops at 525 km sun-synchronous only'; return out; }
      var hr = P.hohmann(C.RE + v.dropAlt, r);
      out.cap = v.sso; out.desc = '525 km SSO rideshare drop-off'; out.dropAlt = v.dropAlt; out.dropInc = 97.5;
      out.dvSc = (alt === v.dropAlt ? 0 : hr.total) + P.combined(Math.sqrt(C.MU / r), Math.sqrt(C.MU / r), Math.abs(inc - 97.5)) ;
      out.days = alt === v.dropAlt ? 0 : 3; out.kind = 'transfer';
      return out;
    }
    if (cls === 'LEO') {
      if (!v.leo) { out.feasible = false; out.reason = 'No LEO capacity'; return out; }
      var h = P.hohmann(C.RE + 200, r).total, pen = P.rotPenalty(v.lat, inc);
      out.cap = v.leo * Math.exp(-(h + pen) / c); out.desc = 'Direct injection, ' + alt + ' km, ' + inc.toFixed(1) + '°';
      if (inc < v.lat - 0.5) out.desc += ' (dog-leg)';
      return out;
    }
    if (cls === 'SSO') {
      if (v.sso) { out.cap = v.sso * Math.exp(-P.hohmann(C.RE + 600, r).total * (alt > 600 ? 1 : -1) / c); }
      else if (v.leo) { out.cap = v.leo * Math.exp(-(P.hohmann(C.RE + 200, r).total + P.rotPenalty(v.lat, inc)) / c); }
      else { out.feasible = false; out.reason = 'No SSO capacity'; return out; }
      out.desc = 'Direct injection, ' + alt + ' km SSO';
      return out;
    }
    if (!v.gto) { out.feasible = false; out.reason = 'Cannot reach high-energy orbits'; return out; }
    if (cls === 'MEO') {
      var it = Math.max(inc, v.lat), rp = C.RE + 200, a = (rp + r) / 2;
      var vp = Math.sqrt(C.MU * (2 / rp - 1 / a)), dvPeri = vp - Math.sqrt(C.MU / rp);
      out.cap = v.leo * Math.exp(-(dvPeri + P.rotPenalty(v.lat, it)) / c);
      var va = Math.sqrt(C.MU * (2 / r - 1 / a));
      out.dvSc = P.combined(va, Math.sqrt(C.MU / r), it - inc);
      out.desc = 'Transfer ellipse 200 × ' + alt + ' km at ' + it.toFixed(1) + '°'; out.dropAlt = 200; out.dropInc = it; out.days = 2; out.kind = 'ellipse';
      out.apogee = alt; out.transferA = a;
      return out;
    }
    if (cls === 'GEO') {
      var gi = P.gtoInc(v), rpg = C.RE + 200, rg = C.RE + 35786, ag = (rpg + rg) / 2;
      var vag = Math.sqrt(C.MU * (2 / rg - 1 / ag));
      out.cap = v.gto; out.dvSc = P.combined(vag, Math.sqrt(C.MU / rg), gi);
      out.desc = 'GTO 200 × 35,786 km at ' + gi.toFixed(1) + '°'; out.dropAlt = 200; out.dropInc = gi; out.days = 10; out.kind = 'ellipse';
      out.apogee = 35786; out.transferA = ag;
      return out;
    }
    if (cls === 'LUNAR') {
      var il = Math.max(v.lat, 10);
      out.cap = v.leo * Math.exp(-(3.14 + P.rotPenalty(v.lat, il)) / c);
      var rl = C.R_MOON + alt, vinf = 0.83;
      var loi = Math.sqrt(vinf * vinf + 2 * C.MU_MOON / rl) - Math.sqrt(C.MU_MOON / rl);
      out.dvSc = 0.05 + loi; out.loi = loi; out.desc = 'Trans-lunar injection (C3 ≈ −2 km²/s²)'; out.days = 5; out.kind = 'lunar';
      return out;
    }
    if (cls === 'MARS') {
      out.cap = v.leo * Math.exp(-(3.6 + P.rotPenalty(v.lat, Math.max(v.lat, 10))) / c);
      var rpm = C.R_MARS + 300, ram = C.R_MARS + 70000, am = (rpm + ram) / 2, vinfm = 2.7;
      var moi = Math.sqrt(vinfm * vinfm + 2 * C.MU_MARS / rpm) - Math.sqrt(C.MU_MARS * (2 / rpm - 1 / am));
      out.dvSc = 0.06 + moi; out.moi = moi; out.desc = 'Trans-Mars injection (C3 ≈ 12 km²/s²)'; out.days = 260; out.kind = 'mars';
      return out;
    }
    out.feasible = false; out.reason = 'Unknown orbit'; return out;
  };

  /* ---------- Δv budget (m/s) ---------- */
  P.dvBudget = function (m, v, prop, drop, dragInfo) {
    var cls = m.orbit, items = [], life = m.life, ep = prop && !prop.impulsive;
    var push = function (name, dv, req, note) { if (dv > 0.01) items.push({ name: name, dv: dv, required: req, note: note || '' }); };
    var precise = !(cls === 'LEO' || cls === 'SSO');
    push('Injection error correction', 3 * v.injSigma, precise, '3σ dispersion of ' + v.name);
    var tdv = drop.dvSc * 1000;
    if (tdv > 0) push(cls === 'GEO' ? 'GTO → GEO circularisation' : cls === 'MEO' ? 'Circularise at apogee' : cls === 'LUNAR' ? 'Lunar orbit insertion + corrections' : cls === 'MARS' ? 'Mars orbit insertion + deep-space manoeuvres' : 'Orbit raising from drop-off', tdv * (ep ? 1.3 : 1), true, ep ? 'includes 30% low-thrust gravity loss' : '');
    var sk = 0, skNote = '';
    if (cls === 'LEO' || cls === 'SSO') { sk = dragInfo.dvPerYear * 1.3 + (cls === 'SSO' ? 3 : 1); skNote = 'drag make-up at solar maximum' + (cls === 'SSO' ? ' + inclination upkeep' : ''); }
    else if (cls === 'MEO') { sk = 10; skNote = 'luni-solar perturbations'; }
    else if (cls === 'GEO') { sk = 50; skNote = 'N–S 47 m/s/yr + E–W 3 m/s/yr'; }
    else if (cls === 'LUNAR') { sk = 80; skNote = 'lunar mascon perturbations'; }
    else if (cls === 'MARS') { sk = 10; skNote = 'periapsis maintenance'; }
    var skRequired = cls === 'GEO' || cls === 'MEO' || cls === 'LUNAR' || ((cls === 'LEO' || cls === 'SSO') && dragInfo.lifetime < 1.5 * life);
    push('Station keeping (' + sk.toFixed(1) + ' m/s/yr × ' + life + ' yr)', sk * life, skRequired, skNote);
    if (P.isEarthBound(cls)) push('Collision avoidance & momentum dumping', 2 * life, false, '2 m/s per year');
    if (cls === 'LEO' || cls === 'SSO') { var dd = P.deorbitDv(m.alt); push('End-of-life de-orbit (perigee → 300 km)', dd, dragInfo.lifetime > 25, dragInfo.lifetime > 25 ? '25-year rule applies' : 'natural decay < 25 yr, optional'); }
    else if (cls === 'GEO') push('Graveyard orbit (+300 km)', 11, true, 'IADC guideline');
    else if (cls === 'MEO') push('Graveyard orbit', 50, true, '');
    var sub = 0, reqSub = 0; items.forEach(function (i) { sub += i.dv; if (i.required) reqSub += i.dv; });
    var marginPct = ep ? 0.05 : 0.10;
    push('Margin (' + Math.round(marginPct * 100) + '%)', sub * marginPct, reqSub > 0, 'preliminary design allowance');
    var total = 0; items.forEach(function (i) { total += i.dv; });
    return { items: items, total: total, required: reqSub * (1 + marginPct), skPerYear: sk, skRequired: skRequired };
  };

  /* ---------- power budget ---------- */
  P.powerBudget = function (m, prop, pert) {
    pert = pert || {};
    var cls = m.orbit, o = MP.ORBITS[cls];
    var busPower = 20 + 0.25 * m.power, pReq = m.power + busPower;
    var ep = prop && !prop.impulsive;
    var pEP = ep ? Math.min(10000, Math.max(400, 1.5 * pReq)) : 0;
    var pSize = Math.max(pReq, ep ? pEP + busPower : 0);
    var fe = P.eclipseFraction(cls, m.alt), T = cls === 'GEO' ? 86164 : cls === 'MARS' ? 3600 * 24 : P.period(C.RE + m.alt, cls === 'LUNAR' ? C.MU_MOON : C.MU);
    if (cls === 'LUNAR') T = P.period(C.R_MOON + m.alt, C.MU_MOON);
    var Td = T * (1 - fe), Te = T * fe;
    var pSA = (pSize * Td / 0.8 + pSize * Te / 0.6) / Td;           // array output needed in sunlight (EOL)
    var degr = o.degr * (pert.degr || 1);
    var lifeYrs = m.life + (cls === 'MARS' ? 0.75 : 0);
    var ld = Math.pow(1 - degr, lifeYrs), pBOL = pSA / ld * (m.arrayOversize || 1);
    var flux = C.SOLAR * (cls === 'MARS' ? 0.43 : 1);
    var area = pBOL / (flux * 0.30 * 0.85 * 0.90), arrayMass = area * 3.8;
    var eBatt = pReq * Te / 3600 / (o.dod * 0.9), battMass = eBatt / 140;
    var pcdu = 1.5 + 0.05 * pSize;
    var pEOL = pBOL * ld;                                               // what the array gives at end of life (sunlight)
    var margin = (pEOL - pSA) / pSA;                                    // relative to sizing need
    return { busPower: busPower, pReq: pReq, pEP: pEP, pSize: pSize, eclipseFrac: fe, periodS: T, eclipseMin: Te / 60,
             pSA: pSA, pBOL: pBOL, pEOL: pEOL, area: area, arrayMass: arrayMass, eBatt: eBatt, battMass: battMass, pcduMass: pcdu,
             mass: arrayMass + battMass + pcdu, margin: margin, degr: degr, flux: flux };
  };

  /* ---------- mass budget ---------- */
  P.massBudget = function (m, prop, dvTotal, pw, pert) {
    pert = pert || {};
    var cls = m.orbit, deep = cls === 'LUNAR' || cls === 'MARS';
    var payload = m.payload * (pert.payload || 1), growth = pert.bus || 1;
    var isp = prop.isp * (pert.isp || 1), dry = payload * 3, propMass = 0, sub = {};
    for (var k = 0; k < 40; k++) {
      sub = {
        payload: payload,
        structure: 0.18 * dry * growth,
        power: pw.mass * growth,
        adcs: (2 + 0.04 * dry) * (deep ? 1.5 : 1) * growth,
        avionics: (3 + 0.02 * dry) * growth,
        comms: (2 + 0.03 * dry) * (deep ? 3 : 1) * growth,
        thermal: 0.04 * dry * growth,
        harness: 0.05 * dry * growth
      };
      var propDry = prop.id === 'none' ? 0 : (prop.baseMass + prop.tankFrac * propMass + (prop.impulsive ? 0 : 0.02 * pw.pEP)) * growth;
      sub.propulsionDry = propDry;
      var dryNoMargin = 0; for (var key in sub) dryNoMargin += sub[key];
      sub.margin = 0.15 * dryNoMargin;
      var newDry = dryNoMargin + sub.margin;
      propMass = prop.id === 'none' || isp <= 0 ? 0 : newDry * (Math.exp(dvTotal / (isp * C.G0)) - 1) * 1.03;
      if (Math.abs(newDry - dry) < 0.01) { dry = newDry; break; }
      dry = newDry;
    }
    var wet = dry + propMass, bus = dry - payload;
    var diameter = 0.25 * Math.pow(wet, 1 / 3);
    return { sub: sub, dry: dry, bus: bus, prop: propMass, wet: wet, diameter: diameter, payloadFrac: payload / dry, isp: isp };
  };

  /* ---------- orbit facts for display ---------- */
  P.orbitInfo = function (m) {
    var cls = m.orbit, o = {};
    if (cls === 'LUNAR') { var r = C.R_MOON + m.alt; o.period = P.period(r, C.MU_MOON); o.v = P.vCirc(r, C.MU_MOON); o.body = 'Moon'; }
    else if (cls === 'MARS') { var rp = C.R_MARS + 300, ra = C.R_MARS + 70000, a = (rp + ra) / 2; o.period = P.period(a, C.MU_MARS); o.v = Math.sqrt(C.MU_MARS * (2 / rp - 1 / a)); o.body = 'Mars'; o.ellipse = '300 × 70,000 km'; }
    else { var re = C.RE + m.alt; o.period = P.period(re); o.v = P.vCirc(re); o.body = 'Earth'; o.raan = P.raanDrift(m.alt, m.inc); o.revsPerDay = 86400 / o.period; }
    o.eclipseFrac = P.eclipseFraction(cls, m.alt); o.eclipseMin = o.eclipseFrac * o.period / 60;
    if (cls === 'SSO') o.ssoInc = P.ssoInc(m.alt);
    if (P.isEarthBound(cls)) { var rr = C.RE + m.alt; o.footprintFrac = (1 - C.RE / rr) / 2; o.horizonKm = C.RE * Math.acos(C.RE / rr); o.swathKm = 2 * o.horizonKm; }
    return o;
  };
})();

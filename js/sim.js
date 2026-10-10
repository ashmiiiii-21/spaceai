/* =========================================================================
   DIGITAL MISSION SIMULATION
   Builds a phased mission timeline from an evaluated configuration and
   animates it on a canvas with live telemetry.
   ========================================================================= */
(function () {
  var C = MP.CONST, P = MP.physics, DAY = 86400;
  var kepler = function (M, e) { M = M % (2 * Math.PI); if (M < 0) M += 2 * Math.PI; var E = e < 0.8 ? M : Math.PI; for (var i = 0; i < 30; i++) { var d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E)); E -= d; if (Math.abs(d) < 1e-9) break; } var nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2)); return { E: E, nu: nu }; };
  var ease = function (u) { return u * u * (3 - 2 * u); };

  var Sim = MP.Sim = function (ev, canvas) {
    this.ev = ev; this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.speed = 1; this.playing = true; this.t = 0; this.log = []; this.trail = [];
    this.soc = 1; this.thetaVis = 0; this.Mvis = 0; this.lastPhase = -1; this.skBurns = 0; this.lastSk = 0;
    this.stars = []; var r = MP.engine.rng(99); for (var i = 0; i < 140; i++) this.stars.push([r(), r(), 0.4 + r() * 1.2]);
    this.build();
  };
  var S = Sim.prototype;

  S.build = function () {
    var ev = this.ev, m = ev.mission, drop = ev.drop, cls = m.orbit, mu = cls === 'LUNAR' ? C.MU_MOON : cls === 'MARS' ? C.MU_MARS : C.MU;
    var R = cls === 'LUNAR' ? C.R_MOON : cls === 'MARS' ? C.R_MARS : C.RE;
    this.R = R; this.mu = mu; this.body = cls === 'LUNAR' ? 'Moon' : cls === 'MARS' ? 'Mars' : 'Earth';
    var ph = [], burns = [], t = 0, self = this;
    var add = function (name, dur, real, extra) { var p = Object.assign({ name: name, t0: t, dur: dur, real: real, rate: dur / real }, extra || {}); ph.push(p); t += dur; return p; };
    var ep = !ev.prop.impulsive, isp = ev.mass.isp;
    this.rTarget = cls === 'MARS' ? null : R + m.alt;
    this.T = cls === 'MARS' ? P.period((C.R_MARS + 300 + C.R_MARS + 70000) / 2, C.MU_MARS) : P.period(this.rTarget, mu);
    add('Launch & ascent', 600, 14, { kind: 'ascent', view: 'earth' });
    var tInj = t;
    this.segments = [];
    if (cls === 'LUNAR') {
      add('Trans-lunar coast', 5 * DAY, 14, { kind: 'lunarCoast', view: 'cislunar' });
      burns.push({ t: t, name: 'Lunar orbit insertion', dv: (drop.loi || 0.85) * 1000 });
      add('Lunar orbit insertion', 1200, 4, { kind: 'orbit', view: 'moon', burn: true });
    } else if (cls === 'MARS') {
      add('Interplanetary cruise', 259 * DAY, 20, { kind: 'cruise', view: 'helio' });
      burns.push({ t: t, name: 'Mars orbit insertion', dv: (drop.moi || 1.05) * 1000 });
      add('Mars orbit insertion', 1800, 4, { kind: 'orbit', view: 'mars', burn: true });
    } else if (drop.kind === 'ellipse') {
      var rp = C.RE + drop.dropAlt, ra = C.RE + drop.apogee, dvTot = drop.dvSc * 1000;
      if (ep) {
        var dur = (ev.transferDays || 120) * DAY;
        this.segments.push({ t0: t, rp: rp, ra: ra, spiral: true, dur: dur, mu: mu });
        add('Electric orbit raising', dur, 20, { kind: 'spiral', view: 'earth' });
      } else {
        var nb = cls === 'GEO' ? 3 : 1, rps = cls === 'GEO' ? [rp, C.RE + 9000, C.RE + 22000, ra] : [rp, ra], tb = t, seg0 = { t0: t, rp: rp, ra: ra, M0: 0, mu: mu };
        this.segments.push(seg0);
        var T0 = P.period((rp + ra) / 2, mu), tBurn = t + (nb === 1 ? 0.5 : 1.5) * T0, cur = seg0;
        for (var k = 1; k <= nb; k++) {
          var seg = { t0: tBurn, rp: rps[k], ra: ra, M0: Math.PI, mu: mu }; this.segments.push(seg);
          burns.push({ t: tBurn, name: 'Apogee burn ' + k + ' of ' + nb, dv: dvTot / nb });
          var Tk = P.period((rps[k] + ra) / 2, mu); tBurn += 2 * Tk; cur = seg;
        }
        var durC = tBurn - t - 1.5 * P.period((rps[nb] + ra) / 2, mu);
        add(cls === 'GEO' ? 'GTO apogee burns' : 'Transfer & circularisation', durC, 18, { kind: 'ellipses', view: 'earth' });
      }
    } else if (drop.kind === 'transfer' && drop.dvSc > 0.001) {
      var r1 = C.RE + drop.dropAlt, r2 = C.RE + m.alt, h = P.hohmann(r1, r2), t1 = t + DAY;
      this.segments.push({ t0: t, rp: r1, ra: r1, M0: 0, mu: mu, circ: true });
      this.segments.push({ t0: t1, rp: Math.min(r1, r2), ra: Math.max(r1, r2), M0: r2 > r1 ? 0 : Math.PI, mu: mu });
      burns.push({ t: t1, name: 'Hohmann burn 1', dv: h.dv1 * 1000 }); burns.push({ t: t1 + h.tof, name: 'Hohmann burn 2', dv: h.dv2 * 1000 });
      add('Drift & orbit raising', DAY + h.tof + 3600, 12, { kind: 'ellipses', view: 'earth' });
    } else {
      add('Separation & detumble', 3600, 5, { kind: 'orbit', view: 'earth' });
    }
    this.tOps0 = t;
    add('Commissioning', 14 * DAY, 10, { kind: 'orbit', view: this.body.toLowerCase() });
    var opsName = { eo: 'Imaging operations', comms: 'Service operations', nav: 'Navigation service', sci: 'Science operations', tech: 'Technology demonstration', explore: 'Science operations' }[m.type] || 'Operations';
    add(opsName, m.life * C.YEAR, 40, { kind: 'orbit', view: this.body.toLowerCase(), ops: true });
    var dis = ev.dv.items.filter(function (i) { return /de-orbit|Graveyard/.test(i.name); })[0];
    if ((cls === 'LEO' || cls === 'SSO') && ev.prop.id !== 'none' && dis) { burns.push({ t: t, name: 'De-orbit burn', dv: dis.dv }); add('De-orbit & re-entry', 30 * DAY, 8, { kind: 'decay', view: 'earth', burn: true }); }
    else if ((cls === 'LEO' || cls === 'SSO')) add('Passive decay (' + Math.min(ev.drag.lifetime, 25).toFixed(0) + ' yr)', Math.min(ev.drag.lifetime, 25) * C.YEAR, 8, { kind: 'decay', view: 'earth' });
    else if ((cls === 'GEO' || cls === 'MEO') && dis) { burns.push({ t: t, name: 'Graveyard orbit burn', dv: dis.dv }); add('Graveyard orbit', 5 * DAY, 5, { kind: 'graveyard', view: 'earth', burn: true }); }
    else if (cls === 'LUNAR') { burns.push({ t: t, name: 'Disposal (controlled impact)', dv: 30 }); add('Controlled impact', 3600, 4, { kind: 'decay', view: 'moon', burn: true }); }
    else add('End of mission', 5 * DAY, 4, { kind: 'orbit', view: this.body.toLowerCase() });
    add('Mission complete', 1e12, 1e12, { kind: 'end', view: ph[ph.length - 1].view });
    this.phases = ph; this.burns = burns; this.tEnd = t; this.tInj = tInj;
    this.isp = isp; this.mDry = ev.mass.dry; this.mWet = ev.mass.wet; this.prop0 = ev.mass.prop;
    this.skRate = ev.dv.skPerYear / C.YEAR;  // m/s per second during operations
    this.pReq = ev.power.pReq; this.pBOL = ev.power.pBOL; this.pEOL = ev.power.pEOL; this.eBatt = ev.power.eBatt; this.degr = ev.power.degr;
    this.events = []; this.push(0, 'Liftoff: ' + ev.vehicle.name + ' from ' + ev.vehicle.site);
  };
  S.push = function (t, msg) { this.events.unshift({ t: t, msg: msg }); if (this.events.length > 60) this.events.pop(); this.dirtyLog = true; };
  S.phaseIndex = function (t) { var ph = this.phases; for (var i = ph.length - 1; i >= 0; i--) if (t >= ph[i].t0) return i; return 0; };
  S.segmentAt = function (t) { var s = null; this.segments.forEach(function (g) { if (t >= g.t0) s = g; }); return s; };
  // propellant used (kg) up to time t, from burns + station keeping + EP spiral
  S.propUsed = function (t) {
    var m = this.mWet, used = 0, self = this, c = this.isp * C.G0;
    if (this.ev.prop.id === 'none') return 0;
    var dvCont = 0;
    this.segments.forEach(function (g) { if (g.spiral && t > g.t0) dvCont += self.ev.drop.dvSc * 1000 * 1.3 * Math.min(1, (t - g.t0) / g.dur); });
    var opsStart = this.tOps0 + 14 * DAY, opsEnd = opsStart + this.ev.mission.life * C.YEAR;
    if (t > opsStart && this.ev.dv.skRequired !== false) dvCont += this.skRate * (Math.min(t, opsEnd) - opsStart);
    var dv = dvCont; this.burns.forEach(function (b) { if (t >= b.t) dv += b.dv; });
    used = m * (1 - Math.exp(-dv / c));
    return Math.min(used, this.prop0);
  };
  S.jump = function (i) { this.t = this.phases[i].t0; this.trail = []; this.soc = 1; this.thetaVis = this.realTheta(this.t); this.lastPhase = -1; };
  S.realTheta = function (t) { return 2 * Math.PI * (t - this.tInj) / this.T; };

  /* geometric state at time t: {view, pos[km], r, v, inShadow, path[] etc} */
  S.state = function (t, thetaVis) {
    var ev = this.ev, m = ev.mission, cls = m.orbit, ph = this.phases[this.phaseIndex(t)], R = this.R, st = { phase: ph, view: ph.view, orbits: [] };
    var lat = ev.vehicle.lat * Math.PI / 180, site = { x: C.RE * Math.cos(-0.6 + lat * 0.3), y: C.RE * Math.sin(-0.6 + lat * 0.3) };
    st.site = site;
    if (ph.kind === 'ascent') {
      var u = Math.min(1, (t - ph.t0) / ph.dur), ang = -0.6 + lat * 0.3 + 0.55 * ease(u), rr = C.RE + ev.drop.dropAlt * ease(u);
      st.pos = { x: rr * Math.cos(ang), y: rr * Math.sin(ang) }; st.r = rr; st.v = 0.4 + (Math.sqrt(C.MU / (C.RE + ev.drop.dropAlt)) - 0.4) * u; st.alt = rr - C.RE; st.ascent = u; st.R = C.RE;
      st.orbits.push({ type: 'circle', r: C.RE + ev.drop.dropAlt, style: 'target' });
      return st;
    }
    if (ph.kind === 'lunarCoast') {
      var uL = Math.min(1, (t - ph.t0) / ph.dur); st.u = uL; st.pos = null; st.alt = uL * C.D_MOON; st.v = 10.9 - 10 * uL + 0.6 * uL * uL; st.cislunar = true; st.R = C.RE; return st;
    }
    if (ph.kind === 'cruise') {
      var uC = Math.min(1, (t - ph.t0) / ph.dur), aT = (C.AU + C.A_MARS) / 2, eT = (C.A_MARS - C.AU) / (C.A_MARS + C.AU), Tt = 2 * Math.PI * Math.sqrt(aT * aT * aT / C.MU_SUN);
      var kp = kepler(Math.PI * uC * 2 * (0.5), eT); // half an orbit over the cruise
      var rh = aT * (1 - eT * Math.cos(kp.E)), th0 = 0.3;
      st.helio = { a: aT, e: eT, th0: th0, nu: kp.nu, r: rh, earthTh: th0 + 2 * Math.PI * (t - ph.t0) / (365.25 * DAY), marsTh: th0 + Math.PI - 2 * Math.PI * 259 / 687 + 2 * Math.PI * (t - ph.t0) / (687 * DAY) };
      st.pos = { x: rh * Math.cos(th0 + kp.nu), y: rh * Math.sin(th0 + kp.nu) }; st.alt = (rh - C.AU); st.v = Math.sqrt(C.MU_SUN * (2 / rh - 1 / aT)); st.R = C.RE; return st;
    }
    st.R = R;
    var seg = this.segmentAt(t), r, nu, a, e;
    if (cls === 'MARS') { var rpM = C.R_MARS + 300, raM = C.R_MARS + 70000; a = (rpM + raM) / 2; e = (raM - rpM) / (raM + rpM); var kM = kepler(thetaVis, e); nu = kM.nu; r = a * (1 - e * Math.cos(kM.E)); st.orbits.push({ type: 'ellipse', rp: rpM, ra: raM, style: 'target' }); }
    else if (seg && t >= seg.t0 && (ph.kind === 'ellipses' || ph.kind === 'spiral')) {
      var rp = seg.rp, ra = seg.ra;
      if (seg.spiral) { var us = Math.min(1, (t - seg.t0) / seg.dur); rp = seg.rp + (seg.ra - seg.rp) * us; }
      a = (rp + ra) / 2; e = (ra - rp) / (ra + rp); var kk = kepler(thetaVis, e); nu = kk.nu; r = a * (1 - e * Math.cos(kk.E));
      st.orbits.push({ type: 'ellipse', rp: rp, ra: ra, style: 'transfer' }); st.orbits.push({ type: 'circle', r: this.rTarget, style: 'target' });
      if (seg.spiral) st.orbits.push({ type: 'ellipse', rp: seg.rp, ra: seg.ra, style: 'faint' });
    } else if (ph.kind === 'decay' && this.body === 'Earth') {
      var ud = Math.min(1, (t - ph.t0) / ph.dur); r = this.rTarget - (this.rTarget - C.RE - 120) * ease(ud); nu = thetaVis; a = r; e = 0; st.decaying = true; st.orbits.push({ type: 'circle', r: r, style: 'transfer' });
    } else if (ph.kind === 'graveyard') { r = this.rTarget + 300; nu = thetaVis; a = r; e = 0; st.orbits.push({ type: 'circle', r: this.rTarget, style: 'faint' }); st.orbits.push({ type: 'circle', r: r, style: 'target' }); }
    else if (ph.kind === 'decay') { var um = Math.min(1, (t - ph.t0) / ph.dur); r = this.rTarget - (this.rTarget - R) * ease(um); nu = thetaVis; a = r; e = 0; st.decaying = true; st.orbits.push({ type: 'circle', r: this.rTarget, style: 'faint' }); }
    else { r = this.rTarget; nu = thetaVis; a = r; e = 0; st.orbits.push({ type: 'circle', r: r, style: 'target' }); }
    st.pos = { x: r * Math.cos(nu), y: r * Math.sin(nu) }; st.r = r; st.alt = r - R; st.v = Math.sqrt(this.mu * (2 / r - 1 / a)); st.a = a; st.e = e;
    st.inShadow = st.pos.x < 0 && Math.abs(st.pos.y) < R && st.view !== 'helio';
    return st;
  };

  /* ---------- frame update ---------- */
  S.update = function (dtReal) {
    if (!this.playing) return;
    var ph = this.phases[this.phaseIndex(this.t)], cls = this.ev.mission.orbit;
    var dt = ph.rate * this.speed * dtReal; if (ph.kind === 'end') dt = 0;
    this.t += dt;
    var pi = this.phaseIndex(this.t);
    if (pi !== this.lastPhase) { if (this.lastPhase >= 0 || pi > 0) this.push(this.t, this.phases[pi].name + (this.phases[pi].ops ? ' begin (' + this.ev.mission.life + ' yr)' : '')); if (pi === 1 && this.lastPhase === 0) this.push(this.t, cls === 'LUNAR' || cls === 'MARS' ? 'Payload separation after ' + (cls === 'LUNAR' ? 'trans-lunar' : 'trans-Mars') + ' injection' : 'Payload separation at ' + Math.round(this.ev.drop.dropAlt) + ' km'); this.lastPhase = pi; this.trail = []; }
    var self = this; this.burns.forEach(function (b) { if (!b.done && self.t >= b.t) { b.done = true; self.push(self.t, b.name + ': Δv ' + Math.round(b.dv) + ' m/s'); self.flash = 1; } });
    // visual orbit angle: real rate, but never faster than one orbit per `minSec` real seconds
    var T = this.T, seg = this.segmentAt(this.t);
    if (seg && (ph.kind === 'ellipses' || ph.kind === 'spiral')) { var rp = seg.spiral ? seg.rp + (seg.ra - seg.rp) * Math.min(1, (this.t - seg.t0) / seg.dur) : seg.rp; T = P.period((rp + seg.ra) / 2, seg.mu); }
    var minSec = (ph.kind === 'ellipses' || ph.kind === 'spiral') ? 1.4 : 5;
    var dth = 2 * Math.PI * dt / T, cap = 2 * Math.PI * dtReal * this.speed / minSec;
    this.slowed = dth > cap; this.thetaVis += Math.min(dth, cap);
    if (seg && this.lastSeg !== seg) { this.thetaVis = seg.M0 || 0; this.lastSeg = seg; }
    var st = this.state(this.t, this.thetaVis); this.st = st;
    // battery (uses the visual orbit so the eclipse cycle is visible)
    var dtVis = Math.min(dth, cap) / (2 * Math.PI) * T, yrs = Math.max(0, (this.t - this.tOps0) / C.YEAR);
    this.pArray = st.inShadow || st.view === 'helio' && false ? 0 : this.pBOL * Math.pow(1 - this.degr, yrs) * (cls === 'MARS' && st.view !== 'mars' ? 1 : 1);
    if (st.view === 'helio') this.pArray = this.pBOL * Math.pow(1 - this.degr, yrs) * (0.43 + 0.57 * (1 - Math.min(1, st.u || (this.t - ph.t0) / ph.dur)));
    if (st.inShadow || ph.kind === 'ascent') this.pArray = 0;
    var load = ph.ops || ph.name === 'Commissioning' ? this.pReq : this.ev.power.busPower + (st.inShadow ? 0 : this.ev.power.pEP);
    this.load = load;
    var charge = st.inShadow ? -load / 0.6 : Math.max(0, this.pArray - load / 0.8) * 0.9;
    if (this.eBatt > 0 && ph.kind !== 'ascent') this.soc = Math.max(0, Math.min(1, this.soc + charge * dtVis / 3600 / this.eBatt));
    if (ph.ops && this.ev.dv.skRequired && this.ev.prop.id !== 'none') { var n = Math.floor((this.t - ph.t0) / (30 * DAY)); if (n > this.skBurns) { this.skBurns = n; if (n <= 3) this.push(this.t, 'Station-keeping burn ' + n + ' (' + (this.ev.dv.skPerYear / 12).toFixed(1) + ' m/s)'); else if (n === 4) this.push(this.t, 'Station-keeping continues monthly…'); } }
    if (st.pos) { this.trail.push([st.pos.x, st.pos.y]); if (this.trail.length > 90) this.trail.shift(); }
    if (this.flash) this.flash = Math.max(0, this.flash - dtReal * 1.5);
  };

  S.telemetry = function () {
    var t = this.t, st = this.st || this.state(t, 0), ph = st.phase, used = this.propUsed(t), mNow = this.mWet - used, c = this.isp * C.G0;
    var dvLeft = this.ev.prop.id === 'none' ? 0 : c * Math.log(Math.max(mNow, this.mDry) / this.mDry);
    var orbits = t > this.tInj ? (t - this.tInj) / this.T : 0, yrs = Math.max(0, (t - this.tOps0) / C.YEAR);
    return { t: t, phase: ph.name, view: st.view, alt: st.alt, v: st.v, inShadow: !!st.inShadow, soc: this.soc, pArray: this.pArray || 0, pReq: this.pReq,
      load: this.load || this.pReq, propLeft: Math.max(0, this.prop0 - used), propFrac: this.prop0 ? Math.max(0, 1 - used / this.prop0) : 1, dvLeft: dvLeft, mass: mNow, orbits: orbits, yrs: yrs, slowed: this.slowed, done: ph.kind === 'end', progress: Math.min(1, t / this.tEnd) };
  };
  Sim.fmtT = function (t) {
    if (t < DAY) { var h = Math.floor(t / 3600), mi = Math.floor(t % 3600 / 60), s = Math.floor(t % 60); return 'T+ ' + (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi + ':' + (s < 10 ? '0' : '') + s; }
    if (t < C.YEAR) { var d = Math.floor(t / DAY), hh = Math.floor(t % DAY / 3600); return 'T+ ' + d + 'd ' + (hh < 10 ? '0' : '') + hh + 'h'; }
    var y = Math.floor(t / C.YEAR), dd = Math.floor(t % C.YEAR / DAY); return 'T+ ' + y + 'y ' + dd + 'd';
  };
  Sim.fmtDur = function (s) { if (s < 3600) return Math.round(s / 60) + ' min'; if (s < DAY) return (s / 3600).toFixed(1) + ' h'; if (s < C.YEAR) return Math.round(s / DAY) + ' d'; return (s / C.YEAR).toFixed(1) + ' yr'; };

  /* ---------- drawing ---------- */
  S.draw = function () {
    var cv = this.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 600, h = cv.clientHeight || 400;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var css = MP.charts.css, col = { fg: css('--fg'), fg2: css('--fg2'), line: css('--line'), accent: css('--accent'), cyan: css('--cyan'), violet: css('--violet'), bad: css('--bad'), good: css('--good') };
    var dark = css('--scheme') !== 'light';
    ctx.fillStyle = dark ? '#05080F' : '#0B1326'; ctx.fillRect(0, 0, w, h);
    var self = this; this.stars.forEach(function (s) { ctx.fillStyle = 'rgba(220,230,255,' + (0.25 + s[2] * 0.3) + ')'; ctx.fillRect(s[0] * w, s[1] * h, s[2], s[2]); });
    var st = this.st || this.state(this.t, 0); if (!st) return;
    ctx.font = '11px ' + css('--mono'); ctx.textBaseline = 'middle';
    if (st.view === 'cislunar') return this.drawCislunar(ctx, w, h, st, col);
    if (st.view === 'helio') return this.drawHelio(ctx, w, h, st, col);
    // body-centred view
    var R = st.R, maxR = R; st.orbits.forEach(function (o) { maxR = Math.max(maxR, o.type === 'circle' ? o.r : o.ra); }); if (st.r) maxR = Math.max(maxR, st.r);
    var cx = w * 0.5, cy = h * 0.5, sc = Math.min(w, h) * 0.45 / maxR;
    var X = function (p) { return cx + p.x * sc; }, Y = function (p) { return cy - p.y * sc; };
    // shadow cone (sun at +x)
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, cy - R * sc, cx, 2 * R * sc);
    // orbits
    st.orbits.forEach(function (o) {
      ctx.setLineDash(o.style === 'target' ? [] : [4, 5]); ctx.lineWidth = o.style === 'faint' ? 0.8 : 1.2; ctx.strokeStyle = o.style === 'target' ? col.cyan : o.style === 'transfer' ? col.violet : col.line; ctx.globalAlpha = o.style === 'faint' ? 0.5 : 0.9; ctx.beginPath();
      if (o.type === 'circle') ctx.arc(cx, cy, o.r * sc, 0, Math.PI * 2);
      else { var a = (o.rp + o.ra) / 2, e = (o.ra - o.rp) / (o.ra + o.rp), b = a * Math.sqrt(1 - e * e); ctx.ellipse(cx - a * e * sc, cy, a * sc, b * sc, 0, 0, Math.PI * 2); }
      ctx.stroke(); ctx.globalAlpha = 1; ctx.setLineDash([]);
    });
    // body
    var body = this.body === 'Moon' && st.view !== 'earth' ? 'Moon' : this.body === 'Mars' && st.view === 'mars' ? 'Mars' : 'Earth';
    var g = ctx.createRadialGradient(cx - R * sc * 0.4, cy - R * sc * 0.4, R * sc * 0.1, cx, cy, R * sc);
    if (body === 'Earth') { g.addColorStop(0, '#5BA9E8'); g.addColorStop(0.7, '#1D5EA8'); g.addColorStop(1, '#0B2B5C'); }
    else if (body === 'Moon') { g.addColorStop(0, '#D8DCE4'); g.addColorStop(0.7, '#8E95A3'); g.addColorStop(1, '#4A5160'); }
    else { g.addColorStop(0, '#F0A070'); g.addColorStop(0.7, '#C25A33'); g.addColorStop(1, '#5A2514'); }
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, Math.PI * 2); ctx.clip(); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(cx - R * sc, cy - R * sc, R * sc, 2 * R * sc); ctx.restore();
    ctx.strokeStyle = 'rgba(160,200,255,0.35)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R * sc + 1, 0, Math.PI * 2); ctx.stroke();
    if (body === 'Earth' && st.site) { ctx.fillStyle = col.accent; ctx.beginPath(); ctx.arc(X(st.site), Y(st.site), 3, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = col.fg2; ctx.textAlign = 'left'; ctx.fillText(this.ev.vehicle.site, X(st.site) + 6, Y(st.site) + 10); }
    // trail
    if (this.trail.length > 1) { ctx.lineWidth = 2; for (var i = 1; i < this.trail.length; i++) { ctx.strokeStyle = 'rgba(244,185,66,' + (i / this.trail.length * 0.8) + ')'; ctx.beginPath(); ctx.moveTo(X({ x: this.trail[i - 1][0], y: this.trail[i - 1][1] }), Y({ x: this.trail[i - 1][0], y: this.trail[i - 1][1] })); ctx.lineTo(X({ x: this.trail[i][0], y: this.trail[i][1] }), Y({ x: this.trail[i][0], y: this.trail[i][1] })); ctx.stroke(); } }
    // spacecraft
    if (st.pos) { var px = X(st.pos), py = Y(st.pos); if (this.flash) { ctx.fillStyle = 'rgba(244,185,66,' + this.flash * 0.5 + ')'; ctx.beginPath(); ctx.arc(px, py, 10 + 14 * (1 - this.flash), 0, Math.PI * 2); ctx.fill(); } ctx.fillStyle = col.accent; ctx.shadowColor = col.accent; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0; }
    // sun indicator & labels
    ctx.fillStyle = col.accent; ctx.textAlign = 'right'; ctx.fillText('☉ Sun →', w - 10, 16); ctx.fillStyle = col.fg2; ctx.textAlign = 'left'; ctx.fillText(body + ' · ' + st.phase.name, 10, 16);
    var bar = Math.pow(10, Math.floor(Math.log10(maxR))); if (bar * sc < 40) bar *= 5; if (bar * sc > w * 0.4) bar /= 2;
    ctx.strokeStyle = col.fg2; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(10, h - 14); ctx.lineTo(10 + bar * sc, h - 14); ctx.stroke(); ctx.fillText(bar.toLocaleString() + ' km', 14 + bar * sc, h - 14);
    if (st.inShadow) { ctx.fillStyle = col.fg2; ctx.textAlign = 'right'; ctx.fillText('in eclipse', w - 10, h - 14); }
  };
  S.drawCislunar = function (ctx, w, h, st, col) {
    var ex = w * 0.14, mx = w * 0.86, cy = h * 0.5, sc = (mx - ex) / C.D_MOON, rE = Math.max(6, C.RE * sc * 3), rM = Math.max(4, C.R_MOON * sc * 3);
    ctx.strokeStyle = col.line; ctx.setLineDash([3, 6]); ctx.beginPath(); ctx.moveTo(ex, cy); ctx.lineTo(mx, cy); ctx.stroke(); ctx.setLineDash([]);
    var gE = ctx.createRadialGradient(ex - rE * 0.3, cy - rE * 0.3, 1, ex, cy, rE); gE.addColorStop(0, '#5BA9E8'); gE.addColorStop(1, '#0B2B5C'); ctx.fillStyle = gE; ctx.beginPath(); ctx.arc(ex, cy, rE, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#B9BFCB'; ctx.beginPath(); ctx.arc(mx, cy, rM, 0, Math.PI * 2); ctx.fill();
    // translunar arc: quadratic bezier
    var p0 = { x: ex, y: cy - rE - 6 }, p1 = { x: (ex + mx) / 2, y: cy - h * 0.32 }, p2 = { x: mx - rM - 4, y: cy - rM - 6 };
    ctx.strokeStyle = col.violet; ctx.setLineDash([4, 5]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y); ctx.stroke(); ctx.setLineDash([]);
    var u = ease(st.u || 0), bx = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x, by = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y;
    ctx.fillStyle = col.accent; ctx.shadowColor = col.accent; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(bx, by, 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = col.fg2; ctx.textAlign = 'center'; ctx.fillText('Earth', ex, cy + rE + 14); ctx.fillText('Moon', mx, cy + rM + 14); ctx.textAlign = 'left'; ctx.fillText('Trans-lunar coast · ' + Math.round((st.alt || 0) / 1000) + ',000 km from Earth', 10, 16);
    ctx.fillStyle = col.accent; ctx.textAlign = 'right'; ctx.fillText('☉ Sun →', w - 10, 16);
  };
  S.drawHelio = function (ctx, w, h, st, col) {
    var cx = w * 0.5, cy = h * 0.5, sc = Math.min(w, h) * 0.44 / C.A_MARS, hl = st.helio;
    ctx.fillStyle = '#FFD86B'; ctx.shadowColor = '#FFB800'; ctx.shadowBlur = 18; ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = col.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, C.AU * sc, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(cx, cy, C.A_MARS * sc, 0, Math.PI * 2); ctx.stroke();
    var a = hl.a, e = hl.e, b = a * Math.sqrt(1 - e * e);
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(-hl.th0); ctx.strokeStyle = col.violet; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.ellipse(-a * e * sc, 0, a * sc, b * sc, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    var pt = function (r, th) { return [cx + r * sc * Math.cos(th), cy - r * sc * Math.sin(th)]; };
    var pe = pt(C.AU, hl.earthTh), pm = pt(C.A_MARS, hl.marsTh), ps = pt(hl.r, hl.th0 + hl.nu);
    ctx.fillStyle = '#4D9BE8'; ctx.beginPath(); ctx.arc(pe[0], pe[1], 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#D9643A'; ctx.beginPath(); ctx.arc(pm[0], pm[1], 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col.accent; ctx.shadowColor = col.accent; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(ps[0], ps[1], 4, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = col.fg2; ctx.textAlign = 'left'; ctx.fillText('Earth', pe[0] + 8, pe[1]); ctx.fillText('Mars', pm[0] + 8, pm[1]); ctx.fillText('Heliocentric view · Hohmann transfer, ' + Math.round(((this.t - st.phase.t0) / DAY)) + ' / 259 days', 10, 16);
  };
})();

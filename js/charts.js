/* Small canvas chart library: theme-aware, DPR-aware, no dependencies */
(function () {
  var CH = MP.charts = {};
  CH.css = function (n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); };
  CH.setup = function (cv, h) {
    var dpr = window.devicePixelRatio || 1, w = cv.clientWidth || (cv.parentNode && cv.parentNode.clientWidth) || 600;
    h = h || parseInt(cv.getAttribute('data-h') || '240', 10);
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.width = w + 'px'; cv.style.height = h + 'px';
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var t = { ctx: ctx, w: w, h: h, fg: CH.css('--fg'), fg2: CH.css('--fg2'), fg3: CH.css('--fg3'), line: CH.css('--line'), accent: CH.css('--accent'), cyan: CH.css('--cyan'), good: CH.css('--good'), bad: CH.css('--bad'), warn: CH.css('--warn'), violet: CH.css('--violet'), surface2: CH.css('--surface2') };
    t.mono = '11px ' + (CH.css('--mono') || 'monospace'); t.sans = '12px ' + (CH.css('--body') || 'sans-serif');
    ctx.font = t.sans; ctx.textBaseline = 'middle';
    return t;
  };
  var fmtDefault = function (v) { return Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2); };
  CH.fmt = fmtDefault;
  var niceTicks = function (lo, hi, n) { var span = hi - lo || 1, step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step; step *= err >= 7.5 ? 10 : err >= 3 ? 5 : err >= 1.5 ? 2 : 1; var t = [], v = Math.ceil(lo / step) * step; for (; v <= hi + 1e-9; v += step) t.push(Math.round(v / step) * step); return t; };
  var trunc = function (ctx, s, w) { if (ctx.measureText(s).width <= w) return s; while (s.length > 1 && ctx.measureText(s + '…').width > w) s = s.slice(0, -1); return s + '…'; };

  /* horizontal bars */
  CH.hbars = function (cv, o) {
    var items = o.items, rowH = o.rowH || 26, labelW = o.labelW || Math.min(190, Math.round((cv.clientWidth || 600) * 0.38)), valW = o.valW || 70;
    var t = CH.setup(cv, items.length * rowH + 10), ctx = t.ctx, max = o.max || Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); })) || 1;
    var x0 = labelW + 8, bw = t.w - x0 - valW - 6, fmt = o.format || fmtDefault;
    items.forEach(function (it, i) {
      var y = 5 + i * rowH, h = rowH - 8;
      ctx.fillStyle = it.dim ? t.fg3 : t.fg; ctx.font = t.sans; ctx.textAlign = 'right'; ctx.fillText(trunc(ctx, it.label, labelW), labelW, y + h / 2);
      ctx.fillStyle = t.surface2; ctx.fillRect(x0, y, bw, h);
      var w = Math.max(2, bw * Math.abs(it.value) / max);
      ctx.fillStyle = it.color || t.cyan; ctx.globalAlpha = it.dim ? 0.45 : 1; ctx.fillRect(x0, y, w, h); ctx.globalAlpha = 1;
      if (it.marker != null) { var mx = x0 + bw * it.marker / max; ctx.strokeStyle = t.fg; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(mx, y - 2); ctx.lineTo(mx, y + h + 2); ctx.stroke(); }
      ctx.fillStyle = t.fg2; ctx.font = t.mono; ctx.textAlign = 'left'; ctx.fillText(fmt(it.value), x0 + bw + 6, y + h / 2);
    });
  };

  /* vertical bars, optional stacked series, optional horizontal reference line */
  CH.vbars = function (cv, o) {
    var t = CH.setup(cv, o.height), ctx = t.ctx, labels = o.labels, series = o.series, pl = 46, pr = 10, pt = 16, pb = o.rotate ? 58 : 28;
    var n = labels.length, totals = labels.map(function (_, i) { return o.stacked ? series.reduce(function (s, se) { return s + se.values[i]; }, 0) : Math.max.apply(null, series.map(function (se) { return se.values[i]; })); });
    var max = Math.max.apply(null, totals.concat(o.hline ? [o.hline.value] : [])) * 1.12 || 1, ticks = niceTicks(0, max, 4);
    var X = function (i) { return pl + (t.w - pl - pr) * (i + 0.5) / n; }, Y = function (v) { return pt + (t.h - pt - pb) * (1 - v / max); }, bw = (t.w - pl - pr) / n * (o.stacked || series.length === 1 ? 0.6 : 0.8 / series.length);
    ctx.strokeStyle = t.line; ctx.fillStyle = t.fg2; ctx.font = t.mono; ctx.textAlign = 'right';
    ticks.forEach(function (v) { ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(t.w - pr, Y(v)); ctx.stroke(); ctx.fillText((o.format || fmtDefault)(v), pl - 6, Y(v)); });
    labels.forEach(function (l, i) {
      var base = 0;
      series.forEach(function (se, k) {
        var v = se.values[i], x = o.stacked || series.length === 1 ? X(i) - bw / 2 : X(i) - bw * series.length / 2 + k * bw;
        ctx.fillStyle = (se.colors && se.colors[i]) || se.color || t.cyan;
        if (o.stacked) { ctx.fillRect(x, Y(base + v), bw, Y(base) - Y(base + v)); base += v; }
        else ctx.fillRect(x, Y(v), bw, Y(0) - Y(v));
      });
      if (o.showValues) { ctx.fillStyle = t.fg; ctx.font = t.mono; ctx.textAlign = 'center'; ctx.fillText((o.format || fmtDefault)(totals[i]), X(i), Y(totals[i]) - 8); }
      ctx.fillStyle = t.fg2; ctx.font = t.sans;
      if (o.rotate) { ctx.save(); ctx.translate(X(i), t.h - pb + 8); ctx.rotate(-0.6); ctx.textAlign = 'right'; ctx.fillText(trunc(ctx, l, 110), 0, 0); ctx.restore(); }
      else { ctx.textAlign = 'center'; ctx.fillText(trunc(ctx, l, (t.w - pl - pr) / n - 4), X(i), t.h - pb / 2); }
    });
    if (o.hline) { ctx.strokeStyle = o.hline.color || t.accent; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(pl, Y(o.hline.value)); ctx.lineTo(t.w - pr, Y(o.hline.value)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = o.hline.color || t.accent; ctx.font = t.mono; ctx.textAlign = 'right'; ctx.fillText(o.hline.label, t.w - pr - 2, Y(o.hline.value) - 8); }
    if (series.length > 1 && !o.noLegend) CH.legend(t, series.map(function (s) { return [s.name, s.color]; }), pl, 4);
  };

  CH.legend = function (t, items, x, y) { var ctx = t.ctx; ctx.font = t.sans; ctx.textAlign = 'left'; items.forEach(function (it) { ctx.fillStyle = it[1]; ctx.fillRect(x, y, 10, 10); ctx.fillStyle = t.fg2; ctx.fillText(it[0], x + 14, y + 5); x += 20 + ctx.measureText(it[0]).width + 10; }); };

  /* histogram with optional vertical reference line */
  CH.hist = function (cv, o) {
    var t = CH.setup(cv, o.height), ctx = t.ctx, vals = o.values, bins = o.bins || 30, pl = 36, pr = 10, pt = 16, pb = 26;
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals); if (o.vline) { lo = Math.min(lo, o.vline.value); hi = Math.max(hi, o.vline.value); } if (hi === lo) hi = lo + 1;
    var span = hi - lo; lo -= span * 0.03; hi += span * 0.03; var counts = new Array(bins).fill(0);
    vals.forEach(function (v) { var b = Math.min(bins - 1, Math.floor((v - lo) / (hi - lo) * bins)); counts[b]++; });
    var max = Math.max.apply(null, counts) || 1, X = function (v) { return pl + (t.w - pl - pr) * (v - lo) / (hi - lo); }, Y = function (c) { return pt + (t.h - pt - pb) * (1 - c / max); };
    ctx.fillStyle = o.color || t.cyan;
    counts.forEach(function (c, i) { var x1 = X(lo + (hi - lo) * i / bins), x2 = X(lo + (hi - lo) * (i + 1) / bins); var col = o.colorFn ? o.colorFn(lo + (hi - lo) * (i + 0.5) / bins) : (o.color || t.cyan); ctx.fillStyle = col; ctx.fillRect(x1 + 0.5, Y(c), Math.max(1, x2 - x1 - 1), Y(0) - Y(c)); });
    ctx.strokeStyle = t.line; ctx.beginPath(); ctx.moveTo(pl, Y(0)); ctx.lineTo(t.w - pr, Y(0)); ctx.stroke();
    ctx.fillStyle = t.fg2; ctx.font = t.mono; ctx.textAlign = 'center';
    niceTicks(lo, hi, 5).forEach(function (v) { ctx.fillText((o.format || fmtDefault)(v), X(v), t.h - pb / 2); });
    if (o.vline) { ctx.strokeStyle = o.vline.color || t.accent; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(o.vline.value), pt); ctx.lineTo(X(o.vline.value), Y(0)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = o.vline.color || t.accent; ctx.textAlign = X(o.vline.value) > t.w / 2 ? 'right' : 'left'; ctx.fillText(o.vline.label, X(o.vline.value) + (X(o.vline.value) > t.w / 2 ? -4 : 4), pt - 4); }
    if (o.markers) o.markers.forEach(function (m) { ctx.strokeStyle = m.color || t.fg2; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(X(m.value), pt + 10); ctx.lineTo(X(m.value), Y(0)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = m.color || t.fg2; ctx.textAlign = 'center'; ctx.fillText(m.label, X(m.value), pt + 4); });
  };

  /* scatter plot */
  CH.scatter = function (cv, o) {
    var t = CH.setup(cv, o.height), ctx = t.ctx, pts = o.points, pl = 48, pr = 12, pt = 14, pb = 34;
    var xs = pts.map(function (p) { return p.x; }), ys = pts.map(function (p) { return p.y; });
    var xlo = o.xlo != null ? o.xlo : Math.min.apply(null, xs), xhi = o.xhi != null ? o.xhi : Math.max.apply(null, xs), ylo = o.ylo != null ? o.ylo : Math.min.apply(null, ys), yhi = o.yhi != null ? o.yhi : Math.max.apply(null, ys);
    if (xhi === xlo) xhi = xlo + 1; if (yhi === ylo) yhi = ylo + 1; var sx = (xhi - xlo) * 0.06, sy = (yhi - ylo) * 0.08; if (o.xlo == null) xlo -= sx; if (o.xhi == null) xhi += sx; if (o.ylo == null) ylo -= sy; if (o.yhi == null) yhi += sy;
    var X = function (v) { return pl + (t.w - pl - pr) * (v - xlo) / (xhi - xlo); }, Y = function (v) { return pt + (t.h - pt - pb) * (1 - (v - ylo) / (yhi - ylo)); };
    ctx.strokeStyle = t.line; ctx.fillStyle = t.fg2; ctx.font = t.mono;
    niceTicks(ylo, yhi, 4).forEach(function (v) { ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(t.w - pr, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText((o.yfmt || fmtDefault)(v), pl - 5, Y(v)); });
    niceTicks(xlo, xhi, 5).forEach(function (v) { ctx.beginPath(); ctx.moveTo(X(v), pt); ctx.lineTo(X(v), t.h - pb); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText((o.xfmt || fmtDefault)(v), X(v), t.h - pb + 10); });
    if (o.diag) { ctx.strokeStyle = t.fg3; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(Math.max(xlo, ylo)), Y(Math.max(xlo, ylo))); ctx.lineTo(X(Math.min(xhi, yhi)), Y(Math.min(xhi, yhi))); ctx.stroke(); ctx.setLineDash([]); }
    if (o.line) { ctx.strokeStyle = o.line.color || t.accent; ctx.lineWidth = 1.5; ctx.beginPath(); o.line.points.forEach(function (p, i) { i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)); }); ctx.stroke(); }
    pts.forEach(function (p) { ctx.fillStyle = p.color || t.cyan; ctx.globalAlpha = p.alpha != null ? p.alpha : 0.8; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), p.r || 3, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; if (p.ring) { ctx.strokeStyle = p.ring; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), (p.r || 3) + 3, 0, Math.PI * 2); ctx.stroke(); } });
    pts.forEach(function (p) { if (p.label) { ctx.fillStyle = t.fg; ctx.font = t.sans; ctx.textAlign = 'left'; ctx.fillText(p.label, X(p.x) + 8, Y(p.y) - 8); } });
    ctx.fillStyle = t.fg2; ctx.font = t.sans; ctx.textAlign = 'center'; if (o.xLabel) ctx.fillText(o.xLabel, pl + (t.w - pl - pr) / 2, t.h - 7);
    if (o.yLabel) { ctx.save(); ctx.translate(10, pt + (t.h - pt - pb) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(o.yLabel, 0, 0); ctx.restore(); }
    if (o.legend) CH.legend(t, o.legend, pl + 4, pt - 8);
  };

  /* line chart */
  CH.line = function (cv, o) {
    var t = CH.setup(cv, o.height), ctx = t.ctx, pl = 48, pr = 12, pt = 16, pb = 30, series = o.series;
    var xlo = Infinity, xhi = -Infinity, ylo = Infinity, yhi = -Infinity;
    series.forEach(function (s) { s.xs.forEach(function (x, i) { xlo = Math.min(xlo, x); xhi = Math.max(xhi, x); ylo = Math.min(ylo, s.ys[i]); yhi = Math.max(yhi, s.ys[i]); }); });
    if (o.ylo != null) ylo = o.ylo; if (yhi === ylo) yhi = ylo + 1; if (xhi === xlo) xhi = xlo + 1; var sy = (yhi - ylo) * 0.08; yhi += sy; if (o.ylo == null) ylo -= sy;
    var X = function (v) { return pl + (t.w - pl - pr) * (v - xlo) / (xhi - xlo); }, Y = function (v) { return pt + (t.h - pt - pb) * (1 - (v - ylo) / (yhi - ylo)); };
    ctx.strokeStyle = t.line; ctx.fillStyle = t.fg2; ctx.font = t.mono;
    niceTicks(ylo, yhi, 4).forEach(function (v) { ctx.beginPath(); ctx.moveTo(pl, Y(v)); ctx.lineTo(t.w - pr, Y(v)); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText((o.yfmt || fmtDefault)(v), pl - 5, Y(v)); });
    niceTicks(xlo, xhi, 5).forEach(function (v) { ctx.textAlign = 'center'; ctx.fillText((o.xfmt || fmtDefault)(v), X(v), t.h - pb + 10); });
    series.forEach(function (s) { ctx.strokeStyle = s.color || t.cyan; ctx.lineWidth = s.width || 1.8; ctx.setLineDash(s.dash || []); ctx.beginPath(); s.xs.forEach(function (x, i) { i ? ctx.lineTo(X(x), Y(s.ys[i])) : ctx.moveTo(X(x), Y(s.ys[i])); }); ctx.stroke(); ctx.setLineDash([]); });
    ctx.fillStyle = t.fg2; ctx.font = t.sans; ctx.textAlign = 'center'; if (o.xLabel) ctx.fillText(o.xLabel, pl + (t.w - pl - pr) / 2, t.h - 6);
    if (o.yLabel) { ctx.save(); ctx.translate(10, pt + (t.h - pt - pb) / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(o.yLabel, 0, 0); ctx.restore(); }
    if (series.length > 1) CH.legend(t, series.map(function (s) { return [s.name, s.color || t.cyan]; }), pl + 4, pt - 8);
  };

  /* waterfall: cumulative contributions */
  CH.waterfall = function (cv, o) {
    var items = o.items, rowH = 28, labelW = o.labelW || Math.min(200, Math.round((cv.clientWidth || 600) * 0.4));
    var t = CH.setup(cv, (items.length + 1) * rowH + 8), ctx = t.ctx, fmt = o.format || fmtDefault;
    var cum = o.start || 0, lo = Math.min(0, cum), hi = Math.max(0, cum), c = cum;
    items.forEach(function (i) { c += i.value; lo = Math.min(lo, c); hi = Math.max(hi, c); });
    var x0 = labelW + 8, bw = t.w - x0 - 64, X = function (v) { return x0 + bw * (v - lo) / (hi - lo || 1); };
    var row = function (i, label, from, to, color, text) { var y = 4 + i * rowH, h = rowH - 9; ctx.fillStyle = t.fg; ctx.font = t.sans; ctx.textAlign = 'right'; ctx.fillText(trunc(ctx, label, labelW), labelW, y + h / 2); ctx.fillStyle = color; ctx.fillRect(Math.min(X(from), X(to)), y, Math.max(2, Math.abs(X(to) - X(from))), h); ctx.fillStyle = t.fg2; ctx.font = t.mono; ctx.textAlign = 'left'; ctx.fillText(text, Math.max(X(from), X(to)) + 6, y + h / 2); };
    c = o.start || 0;
    if (o.startLabel) { row(0, o.startLabel, 0, c, t.fg3, fmt(c)); }
    items.forEach(function (it, i) { var from = c; c += it.value; row(i + (o.startLabel ? 1 : 0), it.label, from, c, it.value >= 0 ? (it.color || t.bad) : (it.color || t.good), (it.value >= 0 ? '+' : '−') + fmt(Math.abs(it.value))); });
    row(items.length + (o.startLabel ? 1 : 0), o.endLabel || 'Total', 0, c, t.fg, fmt(c));
  };

  /* donut */
  CH.donut = function (cv, o) {
    var t = CH.setup(cv, o.height || 200), ctx = t.ctx, items = o.items, total = items.reduce(function (s, i) { return s + i.value; }, 0) || 1;
    var cx = Math.min(t.h / 2, 100), cy = t.h / 2, R = Math.min(cx, cy) - 8, r = R * 0.6, a = -Math.PI / 2;
    items.forEach(function (i) { var da = Math.PI * 2 * i.value / total; ctx.fillStyle = i.color; ctx.beginPath(); ctx.arc(cx, cy, R, a, a + da); ctx.arc(cx, cy, r, a + da, a, true); ctx.closePath(); ctx.fill(); a += da; });
    ctx.fillStyle = t.fg; ctx.font = 'bold 16px ' + (CH.css('--display') || 'sans-serif'); ctx.textAlign = 'center'; ctx.fillText(o.center || '', cx, cy - 6); ctx.font = t.mono; ctx.fillStyle = t.fg2; ctx.fillText(o.centerSub || '', cx, cy + 12);
    var lx = cx + R + 18, ly = 12, lh = Math.min(20, (t.h - 10) / items.length);
    items.forEach(function (i) { ctx.fillStyle = i.color; ctx.fillRect(lx, ly - 5, 10, 10); ctx.fillStyle = t.fg2; ctx.font = t.sans; ctx.textAlign = 'left'; ctx.fillText(trunc(ctx, i.label, t.w - lx - 90), lx + 15, ly); ctx.fillStyle = t.fg; ctx.font = t.mono; ctx.textAlign = 'right'; ctx.fillText((o.format || fmtDefault)(i.value) + ' · ' + Math.round(i.value / total * 100) + '%', t.w - 6, ly); ly += lh; });
  };

  /* tornado: signed bars around zero */
  CH.tornado = function (cv, o) {
    var items = o.items, rowH = 26, labelW = o.labelW || Math.min(180, Math.round((cv.clientWidth || 600) * 0.36));
    var t = CH.setup(cv, items.length * rowH + 26), ctx = t.ctx, max = Math.max.apply(null, items.map(function (i) { return Math.abs(i.value); })) || 1;
    var x0 = labelW + 8, bw = t.w - x0 - 50, xm = x0 + bw / 2;
    ctx.strokeStyle = t.line; ctx.beginPath(); ctx.moveTo(xm, 2); ctx.lineTo(xm, t.h - 20); ctx.stroke();
    items.forEach(function (it, i) { var y = 4 + i * rowH, h = rowH - 9, w = bw / 2 * Math.abs(it.value) / max; ctx.fillStyle = t.fg; ctx.font = t.sans; ctx.textAlign = 'right'; ctx.fillText(trunc(ctx, it.label, labelW), labelW, y + h / 2); ctx.fillStyle = it.value >= 0 ? (o.posColor || t.bad) : (o.negColor || t.good); ctx.fillRect(it.value >= 0 ? xm : xm - w, y, Math.max(2, w), h); ctx.fillStyle = t.fg2; ctx.font = t.mono; ctx.textAlign = it.value >= 0 ? 'left' : 'right'; ctx.fillText((it.value >= 0 ? '+' : '') + (o.format || fmtDefault)(it.value), it.value >= 0 ? xm + w + 5 : xm - w - 5, y + h / 2); });
    ctx.fillStyle = t.fg2; ctx.font = t.sans; ctx.textAlign = 'left'; ctx.fillText(o.negLabel || '', x0, t.h - 9); ctx.textAlign = 'right'; ctx.fillText(o.posLabel || '', t.w - 6, t.h - 9);
  };
})();

/* ============================================================
   Panel SVG puro — escalas, ticks, tooltip y responsive a mano.
   ------------------------------------------------------------
   Ticks "bonitos" (Wilkinson y nuestro caso):
   El algoritmo original de Wilkinson (2005, "The Grammar of
   Graphics") puntúa cada candidatura de marcas con:
     1) simplicidad (¿el paso es 1, 2, 5 ×10^n?),
     2) cobertura (¿cubre bien [dmin, dmax] sin pasarse mucho?),
     3) densidad (¿nº de ticks ≈ objetivo, aquí 4-6?),
     4) legibilidad (evitar solapes).
   Como versión simplificada (estilo "nice numbers" de Heckbert /
   d3.tickStep) enumeramos pasos candidatos Q = {1, 2, 2.5, 5, 10}
   × 10^k alrededor del paso bruto (rango/objetivo), les damos una
   puntuación de simplicidad s(Q) = {1:1, 5:0.9, 2:0.7, 2.5:0.5,
   10:1} y elegimos el que minimiza
     coste = |pasoBruto - Q·10^k| / pasoBruto  - 0.15·s(Q)
   es decir, cercanía al paso ideal bonificada por simplicidad.
   Luego anclamos el dominio a múltiplos del paso elegido.
   Para tiempo hacemos lo mismo pero sobre intervalos de
   calendario (hora, día, semana, mes): elegimos el intervalo cuyo
   nº de marcas se acerca más al objetivo y redondeamos el inicio
   a frontera de calendario (medianoche, lunes, día 1).

   Responsive "de verdad":
   NO usamos viewBox escalado (eso estiraría el texto). Medimos
   clientWidth del contenedor con ResizeObserver y RE-dibujamos el
   SVG con width/height en píxeles nuevos, manteniendo font-size
   constante (12px). Así el texto nunca se deforma.

   Tooltip con punto más cercano:
   En cada gráfico guardamos las coordenadas ya proyectadas a
   píxeles (sx, sy) y en mousemove hacemos búsqueda lineal del
   mínimo de (dx²+dy²) — un "Voronoi por fuerza bruta", sin
   librerías — y mostramos ese dato.
   ============================================================ */

const NS = "http://www.w3.org/2000/svg";
const tooltipEl = document.getElementById("tooltip");
let DATA = null;
let renderQueued = false;

function el(tag, attrs = {}, parent = null) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function effectiveTheme() {
  const t = document.documentElement.dataset.theme || "auto";
  if (t === "light" || t === "dark") return t;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function palette() {
  const dark = effectiveTheme() === "dark";
  return dark
    ? { lines: ["#60A5FA", "#FB923C"], bars: ["#60A5FA", "#A78BFA", "#34D399"], scatter: ["#60A5FA", "#F472B6", "#34D399"], heatLow: "#1E293B", heatHigh: "#60A5FA" }
    : { lines: ["#1D4ED8", "#C2410C"], bars: ["#1D4ED8", "#6D28D9", "#047857"], scatter: ["#1D4ED8", "#BE123C", "#047857"], heatLow: "#EFF6FF", heatHigh: "#1D4ED8" };
}

/* ---------- escalas lineales / temporales calculadas a mano ---------- */

function linearScale(d0, d1, r0, r1) {
  const span = d1 - d0 === 0 ? 1 : d1 - d0;
  return {
    map: (v) => r0 + ((v - d0) / span) * (r1 - r0),
    invert: (p) => d0 + ((p - r0) / (r1 - r0)) * span,
  };
}

function timeScale(t0, t1, r0, r1) {
  const s = linearScale(t0, t1, r0, r1);
  return { map: (d) => s.map(d instanceof Date ? +d : d), invert: s.invert };
}

/* Ticks lineales bonitos. Devuelve { ticks, niceMin, niceMax, step }. */
function niceLinearTicks(dMin, dMax, target = 5) {
  if (!isFinite(dMin) || !isFinite(dMax)) return { ticks: [], niceMin: 0, niceMax: 1, step: 1 };
  if (dMin === dMax) { dMin -= 1; dMax += 1; }
  const raw = (dMax - dMin) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const candidates = [
    { q: 1, s: 1.0 }, { q: 2, s: 0.7 }, { q: 2.5, s: 0.5 }, { q: 5, s: 0.9 }, { q: 10, s: 1.0 },
  ];
  let best = candidates[0], bestCost = Infinity;
  for (const c of candidates) {
    const cost = Math.abs(raw - c.q * mag) / raw - 0.15 * c.s;
    if (cost < bestCost) { bestCost = cost; best = c; }
  }
  const step = best.q * mag;
  const niceMin = Math.floor(dMin / step) * step;
  const niceMax = Math.ceil(dMax / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return { ticks, niceMin, niceMax, step };
}

/* Ticks temporales bonitos sobre intervalos de calendario. */
function niceTimeTicks(dateMin, dateMax, target = 6) {
  const span = +dateMax - +dateMin;
  const H = 3600e3, D = 24 * H;
  const cands = [
    { id: "12h", ms: 12 * H }, { id: "1d", ms: D }, { id: "2d", ms: 2 * D },
    { id: "4d", ms: 4 * H * 24 }, { id: "1w", ms: 7 * D }, { id: "2w", ms: 14 * D },
    { id: "1M", months: 1 }, { id: "2M", months: 2 },
  ];
  let best = cands[1], bestScore = Infinity;
  for (const c of cands) {
    const approx = c.ms ? c.ms : c.months * 30.44 * D;
    const score = Math.abs(span / approx - target);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  const ticks = [];
  const cur = new Date(dateMin);
  if (best.months) {
    cur.setDate(1); cur.setHours(0, 0, 0, 0);
    if (cur < dateMin) cur.setMonth(cur.getMonth() + best.months);
    while (cur <= dateMax) { ticks.push(new Date(cur)); cur.setMonth(cur.getMonth() + best.months); }
  } else if (best.ms >= D) {
    const stepDays = Math.round(best.ms / D);
    cur.setHours(0, 0, 0, 0);
    if (best.id === "1w" || best.id === "2w") {
      const dow = (cur.getDay() + 6) % 7; // lunes = 0
      cur.setDate(cur.getDate() - dow);
      if (cur < new Date(dateMin.getFullYear(), dateMin.getMonth(), dateMin.getDate())) {
        cur.setDate(cur.getDate() + (best.id === "1w" ? 7 : 14));
      }
    }
    while (cur < dateMin) cur.setDate(cur.getDate() + stepDays);
    while (cur <= dateMax) { ticks.push(new Date(cur)); cur.setDate(cur.getDate() + stepDays); }
  } else {
    const stepH = best.ms / H;
    cur.setMinutes(0, 0, 0);
    while (cur < dateMin) cur.setHours(cur.getHours() + stepH);
    while (cur <= dateMax) { ticks.push(new Date(cur)); cur.setHours(cur.getHours() + stepH); }
  }
  return { ticks, interval: best.id };
}

function bandScale(cats, x0, x1, padInner = 0.25, padOuter = 0.2) {
  const n = cats.length;
  const total = x1 - x0;
  const step = total / (n + padOuter * 2 - padInner);
  const bw = step * (1 - padInner);
  const start = x0 + padOuter * step;
  const pos = new Map(cats.map((c, i) => [c, start + i * step]));
  return { map: (c) => pos.get(c), bandwidth: bw, step };
}

const fmtInt = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 });
const fmtTickDate = (spanMs) => {
  if (spanMs > 300 * 864e5) return new Intl.DateTimeFormat("es", { month: "short", year: "numeric" });
  return new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });
};
const fmtFullDate = new Intl.DateTimeFormat("es", { weekday: "short", day: "numeric", month: "short" });

function hexLerp(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function luminance(hex) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/* ---------- tooltip ---------- */
function showTooltip(html, clientX, clientY) {
  tooltipEl.innerHTML = html;
  tooltipEl.hidden = false;
  const pad = 14;
  const r = tooltipEl.getBoundingClientRect();
  let x = clientX + pad, y = clientY + pad;
  if (x + r.width > innerWidth - 8) x = clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = clientY - r.height - pad;
  tooltipEl.style.left = Math.max(8, x) + "px";
  tooltipEl.style.top = Math.max(8, y) + "px";
}
function hideTooltip() { tooltipEl.hidden = true; }

/* Búsqueda del punto más cercano en píxeles (fuerza bruta, sin libs). */
function nearest(px, py, list) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < list.length; i++) {
    const dx = list[i].sx - px, dy = list[i].sy - py;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; bi = i; }
  }
  return list[bi];
}

function drawAxes(g, { xScaleTicks, yTicks, yMap, xMap, plotW, plotH, xLabel }) {
  const grid = el("g", {}, g);
  for (const t of yTicks) {
    const y = yMap(t);
    el("line", { x1: 0, y1: y, x2: plotW, y2: y, class: "grid-line" }, grid);
    const tx = el("text", { x: -8, y: y + 4, "text-anchor": "end", class: "axis-text" }, grid);
    tx.textContent = fmtInt.format(t);
  }
  for (const t of xScaleTicks) {
    const x = xMap(t.value);
    el("line", { x1: x, y1: 0, x2: x, y2: plotH, class: "grid-line", opacity: "0.55" }, grid);
    const tx = el("text", { x, y: plotH + 18, "text-anchor": "middle", class: "axis-text" }, grid);
    tx.textContent = t.label;
  }
  el("line", { x1: 0, y1: plotH, x2: plotW, y2: plotH, class: "axis-line" }, g);
  if (xLabel) {
    const tx = el("text", { x: plotW, y: plotH + 34, "text-anchor": "end", class: "axis-title" }, g);
    tx.textContent = xLabel;
  }
}

function makeSvg(wrap, W, H, label) {
  wrap.innerHTML = "";
  const svg = el("svg", { width: W, height: H, role: "img", "aria-label": label });
  wrap.appendChild(svg);
  return svg;
}

function setLegend(id, items) {
  document.getElementById(id).innerHTML = items.map(
    (d) => `<span class="legend-item"><span class="swatch" style="background:${d.color}"></span>${d.label}</span>`
  ).join("");
}

/* ---------- 1. LÍNEAS (temporal X + lineal Y) ---------- */
function renderLine() {
  const wrap = document.getElementById("chart-line");
  const W = Math.max(280, wrap.clientWidth || 560);
  const H = Math.max(260, Math.min(360, Math.round(W * 0.55)));
  const M = { l: 52, r: 14, t: 12, b: 52 };
  const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
  const pal = palette();
  const svg = makeSvg(wrap, W, H, "Gráfico de líneas de visitas y registros por día");
  const g = el("g", { transform: `translate(${M.l},${M.t})` }, svg);

  const series = DATA.linea.series.map((s, si) => ({
    ...s,
    color: pal.lines[si % pal.lines.length],
    pts: s.valores.map((d) => ({ date: new Date(d.fecha + "T12:00:00"), value: d.valor, raw: d })),
  }));
  const allDates = series.flatMap((s) => s.pts.map((p) => +p.date));
  const allVals = series.flatMap((s) => s.pts.map((p) => p.value));
  const x = timeScale(Math.min(...allDates), Math.max(...allDates), 0, plotW);
  const span = Math.max(...allDates) - Math.min(...allDates);
  const { ticks: dTicks } = niceTimeTicks(new Date(Math.min(...allDates)), new Date(Math.max(...allDates)), Math.max(3, Math.floor(plotW / 90)));
  const yNice = niceLinearTicks(Math.min(0, ...allVals), Math.max(...allVals) * 1.05, 5);
  const y = linearScale(yNice.niceMin, yNice.niceMax, plotH, 0);
  const dfmt = fmtTickDate(span);
  drawAxes(g, {
    xScaleTicks: dTicks.map((d) => ({ value: +d, label: dfmt.format(d) })),
    yTicks: yNice.ticks, yMap: (v) => y.map(v), xMap: (v) => x.map(v), plotW, plotH, xLabel: "fecha",
  });

  const candidates = [];
  series.forEach((s) => {
    const d = s.pts.map((p) => `${x.map(+p.date).toFixed(1)},${y.map(p.value).toFixed(1)}`).join(" L");
    el("path", { d: "M" + d, fill: "none", stroke: s.color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, g);
    for (const p of s.pts) {
      const sx = x.map(+p.date), sy = y.map(p.value);
      el("circle", { cx: sx, cy: sy, r: 2.6, fill: s.color }, g);
      candidates.push({ sx, sy, serie: s.etiqueta, color: s.color, fecha: p.date, valor: p.value });
    }
  });

  const ring = el("circle", { r: 6, class: "hover-ring", visibility: "hidden" }, g);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left - M.l, py = e.clientY - r.top - M.t;
    if (px < 0 || py < 0 || px > plotW || py > plotH) { ring.setAttribute("visibility", "hidden"); hideTooltip(); return; }
    const n = nearest(px, py, candidates);
    ring.setAttribute("cx", n.sx); ring.setAttribute("cy", n.sy);
    ring.setAttribute("visibility", "visible");
    showTooltip(`<strong style="color:${n.color}">${n.serie}</strong>${fmtFullDate.format(n.fecha)}<br><strong>${fmtInt.format(n.valor)}</strong>`, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { ring.setAttribute("visibility", "hidden"); hideTooltip(); });

  setLegend("legend-line", series.map((s) => ({ color: s.color, label: s.etiqueta })));
}

/* ---------- 2. BARRAS APILADAS ---------- */
function renderBars() {
  const wrap = document.getElementById("chart-bars");
  const W = Math.max(280, wrap.clientWidth || 560);
  const H = Math.max(260, Math.min(360, Math.round(W * 0.55)));
  const M = { l: 52, r: 14, t: 12, b: 40 };
  const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
  const pal = palette();
  const svg = makeSvg(wrap, W, H, "Gráfico de barras apiladas por mes");
  const g = el("g", { transform: `translate(${M.l},${M.t})` }, svg);

  const cats = DATA.barrasApiladas.categorias;
  const series = DATA.barrasApiladas.series.map((s, i) => ({ ...s, color: pal.bars[i % pal.bars.length] }));
  const totals = cats.map((_, ci) => series.reduce((a, s) => a + s.valores[ci], 0));
  const yNice = niceLinearTicks(0, Math.max(...totals) * 1.08, 5);
  const y = linearScale(yNice.niceMin, yNice.niceMax, plotH, 0);
  const band = bandScale(cats, 0, plotW);
  drawAxes(g, {
    xScaleTicks: cats.map((c) => ({ value: band.map(c) + band.bandwidth / 2, label: c })),
    yTicks: yNice.ticks, yMap: (v) => y.map(v), xMap: (v) => v, plotW, plotH, xLabel: "",
  });
  // Eje X por bandas: las etiquetas ya vienen centradas en cada banda.

  const candidates = [];
  cats.forEach((cat, ci) => {
    let acc = 0;
    series.forEach((s) => {
      const v = s.valores[ci];
      const y0 = y.map(acc), y1 = y.map(acc + v);
      const bx = band.map(cat), bw = band.bandwidth;
      el("rect", { x: bx, y: y1, width: bw, height: Math.max(1, y0 - y1), fill: s.color, rx: 2 }, g);
      candidates.push({ sx: bx + bw / 2, sy: (y0 + y1) / 2, cat, serie: s.etiqueta, color: s.color, valor: v, total: totals[ci] });
      acc += v;
    });
    const tx = el("text", { x: band.map(cat) + band.bandwidth / 2, y: y.map(totals[ci]) - 6, "text-anchor": "middle", class: "axis-text" }, g);
    tx.textContent = fmtInt.format(totals[ci]);
  });

  const ring = el("rect", { class: "hover-ring", visibility: "hidden", rx: 3 }, g);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left - M.l, py = e.clientY - r.top - M.t;
    if (px < 0 || py < 0 || px > plotW || py > plotH) { ring.setAttribute("visibility", "hidden"); hideTooltip(); return; }
    const n = nearest(px, py, candidates);
    const half = band.bandwidth / 2;
    ring.setAttribute("x", n.sx - half); ring.setAttribute("width", half * 2);
    ring.setAttribute("y", n.sy - 10); ring.setAttribute("height", 20);
    ring.setAttribute("visibility", "visible");
    showTooltip(`<strong>${n.cat} · ${n.serie}</strong>${fmtInt.format(n.valor)} (total ${fmtInt.format(n.total)})`, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { ring.setAttribute("visibility", "hidden"); hideTooltip(); });

  setLegend("legend-bars", series.map((s) => ({ color: s.color, label: s.etiqueta })));
}

/* ---------- 3. DISPERSIÓN ---------- */
function renderScatter() {
  const wrap = document.getElementById("chart-scatter");
  const W = Math.max(280, wrap.clientWidth || 560);
  const H = Math.max(280, Math.min(380, Math.round(W * 0.6)));
  const M = { l: 52, r: 14, t: 12, b: 52 };
  const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
  const pal = palette();
  const svg = makeSvg(wrap, W, H, "Gráfico de dispersión de inversión frente a conversiones");
  const g = el("g", { transform: `translate(${M.l},${M.t})` }, svg);

  const pts = DATA.dispersion.puntos;
  const groups = [...new Set(pts.map((p) => p.grupo))];
  const gColor = new Map(groups.map((gr, i) => [gr, pal.scatter[i % pal.scatter.length]]));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const xNice = niceLinearTicks(Math.min(...xs) * 0.95, Math.max(...xs) * 1.03, Math.max(4, Math.floor(plotW / 90)));
  const yNice = niceLinearTicks(0, Math.max(...ys) * 1.08, 5);
  const x = linearScale(xNice.niceMin, xNice.niceMax, 0, plotW);
  const y = linearScale(yNice.niceMin, yNice.niceMax, plotH, 0);
  drawAxes(g, {
    xScaleTicks: xNice.ticks.map((t) => ({ value: t, label: fmtInt.format(t) })),
    yTicks: yNice.ticks, yMap: (v) => y.map(v), xMap: (v) => x.map(v), plotW, plotH, xLabel: DATA.dispersion.xEtiqueta,
  });
  const yl = el("text", { x: -M.l + 4, y: -4, class: "axis-title" }, g);
  yl.textContent = DATA.dispersion.yEtiqueta;

  const candidates = pts.map((p) => {
    const sx = x.map(p.x), sy = y.map(p.y);
    el("circle", { cx: sx, cy: sy, r: 4.6, fill: gColor.get(p.grupo), opacity: 0.88, stroke: "rgba(0,0,0,0.25)", "stroke-width": 1 }, g);
    return { sx, sy, ...p, color: gColor.get(p.grupo) };
  });

  const ring = el("circle", { r: 8, class: "hover-ring", visibility: "hidden" }, g);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left - M.l, py = e.clientY - r.top - M.t;
    if (px < 0 || py < 0 || px > plotW || py > plotH) { ring.setAttribute("visibility", "hidden"); hideTooltip(); return; }
    const n = nearest(px, py, candidates);
    ring.setAttribute("cx", n.sx); ring.setAttribute("cy", n.sy);
    ring.setAttribute("visibility", "visible");
    showTooltip(`<strong style="color:${n.color}">${n.etiqueta} · ${n.grupo}</strong>Inversión: ${fmtInt.format(n.x)} €<br>Conversiones: <strong>${fmtInt.format(n.y)}</strong>`, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { ring.setAttribute("visibility", "hidden"); hideTooltip(); });

  setLegend("legend-scatter", groups.map((gr) => ({ color: gColor.get(gr), label: gr })));
}

/* ---------- 4. MAPA DE CALOR ---------- */
function renderHeat() {
  const wrap = document.getElementById("chart-heat");
  const W = Math.max(280, wrap.clientWidth || 560);
  const M = { l: 44, r: 10, t: 10, b: 56 };
  const plotW = W - M.l - M.r;
  const pal = palette();
  const xCats = DATA.mapaCalor.xEtiquetas, yCats = DATA.mapaCalor.yEtiquetas;
  const vals = DATA.mapaCalor.valores;
  const flat = vals.flat();
  const vMin = Math.min(...flat), vMax = Math.max(...flat);
  const cellW = plotW / xCats.length;
  const cellH = 30;
  const plotH = cellH * yCats.length;
  const H = plotH + M.t + M.b;
  const svg = makeSvg(wrap, W, H, "Mapa de calor de actividad por hora y día");
  const g = el("g", { transform: `translate(${M.l},${M.t})` }, svg);

  const candidates = [];
  vals.forEach((row, ri) => {
    row.forEach((v, ci) => {
      const t = (v - vMin) / (vMax - vMin || 1);
      const fill = hexLerp(pal.heatLow, pal.heatHigh, Math.pow(t, 0.8));
      el("rect", { x: ci * cellW + 1, y: ri * cellH + 1, width: cellW - 2, height: cellH - 2, fill, rx: 3 }, g);
      // Texto dentro de la celda solo si cabe; color elegido por luminancia (AA).
      if (cellW > 34 && cellH > 20) {
        const tx = el("text", { x: ci * cellW + cellW / 2, y: ri * cellH + cellH / 2 + 4, "text-anchor": "middle", "font-size": 10 }, g);
        const dark = luminance(fill) > 0.35;
        tx.setAttribute("fill", dark ? "#0F172A" : "#FFFFFF");
        tx.textContent = Math.round(v);
      }
      candidates.push({ sx: ci * cellW + cellW / 2, sy: ri * cellH + cellH / 2, dia: yCats[ri], hora: xCats[ci], valor: v, fill });
    });
  });

  // Etiquetas Y (días)
  yCats.forEach((d, ri) => {
    const tx = el("text", { x: -8, y: ri * cellH + cellH / 2 + 4, "text-anchor": "end", class: "axis-text" }, g);
    tx.textContent = d;
  });
  // Etiquetas X (horas): muestra 1 de cada N según ancho para no solapar.
  const every = cellW < 26 ? 4 : cellW < 40 ? 3 : 2;
  xCats.forEach((h, ci) => {
    if (ci % every !== 0) return;
    const tx = el("text", { x: ci * cellW + cellW / 2, y: plotH + 18, "text-anchor": "middle", class: "axis-text" }, g);
    tx.textContent = h;
  });
  const xl = el("text", { x: plotW, y: plotH + 36, "text-anchor": "end", class: "axis-title" }, g);
  xl.textContent = `${DATA.mapaCalor.xNombre} · ${DATA.mapaCalor.yNombre}`;

  const ring = el("rect", { class: "hover-ring", visibility: "hidden", rx: 4 }, g);
  svg.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left - M.l, py = e.clientY - r.top - M.t;
    if (px < 0 || py < 0 || px > plotW || py > plotH) { ring.setAttribute("visibility", "hidden"); hideTooltip(); return; }
    const n = nearest(px, py, candidates);
    const ci = xCats.indexOf(n.hora), ri = yCats.indexOf(n.dia);
    ring.setAttribute("x", ci * cellW); ring.setAttribute("y", ri * cellH);
    ring.setAttribute("width", cellW); ring.setAttribute("height", cellH);
    ring.setAttribute("visibility", "visible");
    showTooltip(`<strong>${n.dia} · ${n.hora}</strong>Actividad: <strong>${n.valor}</strong> (min ${Math.round(vMin)}, max ${Math.round(vMax)})`, e.clientX, e.clientY);
  });
  svg.addEventListener("mouseleave", () => { ring.setAttribute("visibility", "hidden"); hideTooltip(); });

  document.getElementById("legend-heat").innerHTML =
    `<span class="legend-item"><span class="swatch" style="background:linear-gradient(90deg, ${pal.heatLow}, ${pal.heatHigh});width:90px"></span>${Math.round(vMin)} → ${Math.round(vMax)} actividad</span>`;
}

/* ---------- responsive real: re-dibuja, no re-escala ---------- */
function renderAll() {
  if (!DATA) return;
  renderLine(); renderBars(); renderScatter(); renderHeat();
}
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

function initTheme() {
  const saved = localStorage.getItem("panel-theme");
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
  else document.documentElement.dataset.theme = "auto";
  const btn = document.getElementById("theme-toggle");
  const sync = () => {
    const dark = effectiveTheme() === "dark";
    btn.textContent = dark ? "☀️ Tema" : "🌙 Tema";
    btn.setAttribute("aria-pressed", String(dark));
  };
  sync();
  btn.addEventListener("click", () => {
    const cur = effectiveTheme();
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("panel-theme", next);
    sync(); queueRender(); // el calor usa colores por tema
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((document.documentElement.dataset.theme || "auto") === "auto") { sync(); queueRender(); }
  });
}

fetch("data.json")
  .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status} al pedir data.json`); return r.json(); })
  .then((json) => {
    DATA = json;
    initTheme();
    try {
      renderAll();
    } catch (e) {
      console.error(e);
      document.querySelector("main").innerHTML = `<p style="padding:2rem">Error dibujando los gráficos: ${e.message}</p>`;
      return;
    }
    const ro = new ResizeObserver(() => queueRender());
    document.querySelectorAll(".chart-wrap").forEach((w) => ro.observe(w));
  })
  .catch((err) => {
    console.error(err);
    document.querySelector("main").innerHTML = `<p style="padding:2rem">Error cargando <code>data.json</code>: ${err.message}. Sirve la carpeta con un servidor local (p. ej. <code>python3 -m http.server</code>).</p>`;
  });

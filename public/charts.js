// public/charts.js - wykresy SVG generowane recznie. Zero bibliotek zewnetrznych.
import { t } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  return node;
}

const W = 1000;
const H = 260;
const PAD = { top: 12, right: 12, bottom: 22, left: 52 };

function scales(points, valueKey) {
  const values = points.map((p) => p[valueKey]).filter(Number.isFinite);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  min -= span * 0.06;
  max += span * 0.06;
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  return {
    min,
    max,
    x: (i) => PAD.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW),
    y: (value) => PAD.top + innerH - ((value - min) / (max - min)) * innerH,
  };
}

function axis(svg, scale, points, formatValue) {
  for (let i = 0; i <= 4; i += 1) {
    const value = scale.min + ((scale.max - scale.min) * i) / 4;
    const y = scale.y(value);
    svg.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: y, y2: y, stroke: '#24335d', 'stroke-width': 1 }));
    const label = svgEl('text', { x: PAD.left - 6, y: y + 3.5, fill: '#8b98c4', 'font-size': 10, 'text-anchor': 'end' });
    label.textContent = formatValue(value);
    svg.append(label);
  }
  // Znaczniki poczatku roku - pomagaja czytac dlugie zakresy.
  points.forEach((point, i) => {
    if (!point.day?.endsWith('-01-01')) return;
    const x = scale.x(i);
    svg.append(svgEl('line', { x1: x, x2: x, y1: PAD.top, y2: H - PAD.bottom, stroke: '#3b4b80', 'stroke-dasharray': '3 3' }));
    const label = svgEl('text', { x: x + 3, y: PAD.top + 10, fill: '#8b98c4', 'font-size': 9 });
    label.textContent = point.day.slice(0, 4);
    svg.append(label);
  });
}

function xLabels(svg, scale, points) {
  if (!points.length) return;
  const step = Math.max(1, Math.floor(points.length / 6));
  for (let i = 0; i < points.length; i += step) {
    const label = svgEl('text', { x: scale.x(i), y: H - 6, fill: '#8b98c4', 'font-size': 9.5, 'text-anchor': 'middle' });
    label.textContent = points[i].day.slice(2);
    svg.append(label);
  }
}

function path(points, scale, valueKey) {
  return points
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${scale.x(i).toFixed(2)},${scale.y(point[valueKey]).toFixed(2)}`)
    .join(' ');
}

/** Wykres wartosci portfela: linia + wypelnienie + punkty skrajne. */
export function lineChart(points, { valueKey = 'value', color = '#4fc3f7', fill = true, format = (v) => Math.round(v / 1000) + 'k' } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  const usable = points.filter((p) => Number.isFinite(p[valueKey]));
  if (usable.length < 2) {
    const text = svgEl('text', { x: W / 2, y: H / 2, fill: '#8b98c4', 'font-size': 13, 'text-anchor': 'middle' });
    text.textContent = t('chart.notEnoughData');
    svg.append(text);
    return svg;
  }
  const scale = scales(usable, valueKey);
  axis(svg, scale, usable, format);
  xLabels(svg, scale, usable);

  const d = path(usable, scale, valueKey);
  if (fill) {
    const area = `${d} L${scale.x(usable.length - 1).toFixed(2)},${H - PAD.bottom} L${scale.x(0).toFixed(2)},${H - PAD.bottom} Z`;
    const gradientId = `grad-${Math.random().toString(36).slice(2, 8)}`;
    const defs = svgEl('defs');
    const gradient = svgEl('linearGradient', { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.append(svgEl('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.35 }));
    gradient.append(svgEl('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.append(gradient);
    svg.append(defs);
    svg.append(svgEl('path', { d: area, fill: `url(#${gradientId})` }));
  }
  svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));

  const last = usable[usable.length - 1];
  svg.append(svgEl('circle', { cx: scale.x(usable.length - 1), cy: scale.y(last[valueKey]), r: 3.5, fill: color }));
  const label = svgEl('text', {
    x: Math.min(W - PAD.right, scale.x(usable.length - 1) + 6),
    y: scale.y(last[valueKey]) - 7, fill: '#e8edff', 'font-size': 11, 'text-anchor': 'end',
  });
  label.textContent = format(last[valueKey]);
  svg.append(label);
  return svg;
}

/**
 * Wykres wielu serii wyrownanych po dacie (indeks portfela + benchmarki).
 * @param {Array<{label:string,color:string,points:Array<{day:string,value:number}>}>} series
 */
export function multiLineChart(series, { format = (v) => v.toFixed(0) } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  const active = series.filter((s) => s.points.length > 1);
  if (!active.length) {
    const text = svgEl('text', { x: W / 2, y: H / 2, fill: '#8b98c4', 'font-size': 13, 'text-anchor': 'middle' });
    text.textContent = t('chart.noData');
    svg.append(text);
    return svg;
  }
  // Wspolna os X: unia dni wszystkich serii.
  const days = [...new Set(active.flatMap((s) => s.points.map((p) => p.day)))].sort();
  const merged = days.map((day) => ({ day }));
  const values = [];
  for (const item of active) {
    const map = new Map(item.points.map((p) => [p.day, p.value]));
    let previous = null;
    item.aligned = merged.map(({ day }) => {
      const value = map.get(day) ?? previous;
      previous = value ?? previous;
      if (Number.isFinite(value)) values.push(value);
      return { day, value };
    });
  }
  const scale = scales(values.map((value) => ({ value })), 'value');
  scale.x = (i) => PAD.left + (merged.length <= 1 ? 0 : (i / (merged.length - 1)) * (W - PAD.left - PAD.right));
  axis(svg, scale, merged, format);
  xLabels(svg, scale, merged);

  for (const item of active) {
    const d = item.aligned
      .map((point, i) => (Number.isFinite(point.value) ? `${i === 0 ? 'M' : 'L'}${scale.x(i).toFixed(2)},${scale.y(point.value).toFixed(2)}` : ''))
      .filter(Boolean).join(' ').replace(/(?<=.)M/g, 'L');
    svg.append(svgEl('path', {
      d, fill: 'none', stroke: item.color,
      'stroke-width': item.emphasis ? 2.4 : 1.5,
      'stroke-dasharray': item.dashed ? '5 4' : null,
      opacity: item.emphasis ? 1 : 0.85,
    }));
  }
  return svg;
}

/** Wykres slupkowy wyniku - dodatnie zielone, ujemne czerwone. */
export function barChart(items, { format = (v) => Math.round(v / 1000) + 'k' } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
  if (!items.length) {
    const text = svgEl('text', { x: W / 2, y: H / 2, fill: '#8b98c4', 'font-size': 13, 'text-anchor': 'middle' });
    text.textContent = t('chart.noRealized');
    svg.append(text);
    return svg;
  }
  const values = items.map((item) => item.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = (max - min) || 1;
  const innerH = H - PAD.top - PAD.bottom;
  const innerW = W - PAD.left - PAD.right;
  const zeroY = PAD.top + innerH - ((0 - min) / span) * innerH;
  const barW = Math.max(2, Math.min(38, (innerW / items.length) * 0.65));

  svg.append(svgEl('line', { x1: PAD.left, x2: W - PAD.right, y1: zeroY, y2: zeroY, stroke: '#3b4b80' }));

  items.forEach((item, i) => {
    const cx = PAD.left + ((i + 0.5) / items.length) * innerW;
    const y = PAD.top + innerH - ((item.value - min) / span) * innerH;
    const top = Math.min(y, zeroY);
    const height = Math.max(1, Math.abs(zeroY - y));
    svg.append(svgEl('rect', {
      x: cx - barW / 2, y: top, width: barW, height, rx: 2,
      fill: item.value >= 0 ? '#7cffb2' : '#ff8d8d', opacity: 0.85,
    }));
    if (items.length <= 24) {
      const label = svgEl('text', { x: cx, y: H - 6, fill: '#8b98c4', 'font-size': 9.5, 'text-anchor': 'middle' });
      label.textContent = item.label;
      svg.append(label);
    }
  });

  const maxLabel = svgEl('text', { x: PAD.left - 6, y: PAD.top + 10, fill: '#8b98c4', 'font-size': 10, 'text-anchor': 'end' });
  maxLabel.textContent = format(max);
  svg.append(maxLabel);
  return svg;
}

/** Metadane wykresu: zakres, start, koniec, maksimum z data, zmiana. */
export function seriesMeta(points, valueKey = 'value') {
  const usable = points.filter((p) => Number.isFinite(p[valueKey]));
  if (!usable.length) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const peak = usable.reduce((best, point) => (point[valueKey] > best[valueKey] ? point : best), usable[0]);
  return {
    count: usable.length,
    from: first.day,
    to: last.day,
    first: first[valueKey],
    last: last[valueKey],
    maxValue: peak[valueKey],
    maxDay: peak.day,
    change: last[valueKey] - first[valueKey],
    changePct: first[valueKey] ? ((last[valueKey] - first[valueKey]) / Math.abs(first[valueKey])) * 100 : null,
  };
}

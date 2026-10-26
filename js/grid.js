// Week timetable: schedule blocks, a friend/saved-schedule overlay, hatched breaks, and break painting
import { DAY_SHORT, DAY_NAMES, meetingsOf } from './engine.js';
import { esc, fmtRange, fmtHour, fmtTime, icons, roomText } from './util.js';

const SLOT = 15; // minutes per paint cell

function lanes(items) {
  // Side-by-side layout for blocks that overlap in time (e.g. two 8-week halves at the same hour)
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const laneEnds = [];
    for (const it of cluster) {
      let l = laneEnds.findIndex((end) => end <= it.s);
      if (l === -1) {
        l = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[l] = it.e;
      it.lane = l;
    }
    for (const it of cluster) it.lanes = laneEnds.length;
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return items;
}

// Only label classes that start or end at least a week inside the term (e.g. 8-week halves), not ones
// whose first meeting just falls a day or two after the term's first day
function isPartial(r, term) {
  const day = 86400000;
  return Date.parse(r.sd) - Date.parse(term.sd) >= 7 * day || Date.parse(term.ed) - Date.parse(r.ed) >= 7 * day;
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * opts: {
 *   entries: [{ sec, color, locked, key, muted, clash }], ghost: [{ sec, label }], breaks: [{d,s,e}],
 *   limits: { earliest, latest, daysOff }  (time filters, drawn like breaks with a boundary line),
 *   days: number[] (0 = Mon), painting: bool, termRange: { sd, ed }, warnings: Set<crn>,
 *   onBlock(crn), onPaint(breaks)
 * }
 */
export function renderGrid(el, opts) {
  const { entries = [], ghost = [], breaks = [], painting = false, termRange } = opts;
  const limits = opts.limits || {};
  let lo = 8 * 60;
  let hi = 17 * 60;
  const daysUsed = new Set(opts.days || [0, 1, 2, 3, 4]);
  const consider = (m) => {
    lo = Math.min(lo, m.s);
    hi = Math.max(hi, m.e);
    for (let d = 0; d < 7; d++) if (m.days & (1 << d)) daysUsed.add(d);
  };
  for (const { sec } of [...entries, ...ghost, ...(opts.rangeFrom || [])]) for (const m of meetingsOf(sec)) if (!m.once) consider(m);
  for (const b of breaks) {
    lo = Math.min(lo, b.s);
    hi = Math.max(hi, b.e);
    daysUsed.add(b.d);
  }
  if (painting) {
    lo = Math.min(lo, 7 * 60);
    hi = Math.max(hi, 22 * 60);
  }
  // Keep the earliest / latest filter lines on screen, with at least an hour of shaded time beyond them
  if (limits.earliest != null) lo = Math.min(lo, limits.earliest - 60);
  if (limits.latest != null) hi = Math.max(hi, limits.latest + 60);
  lo = Math.max(lo, 6 * 60);
  hi = Math.min(hi, 23 * 60);
  lo = Math.floor(lo / 60) * 60;
  hi = Math.ceil(hi / 60) * 60;
  const days = [...daysUsed].sort((a, b) => a - b);
  const hours = (hi - lo) / 60;

  const perDay = days.map(() => []);
  const addItems = (list, kind) => {
    for (const ent of list) {
      // Banner splits some sections into several date ranges or single days at the same time
      // (hybrid weeks, breaks, "MW" plus a few extra "M" weeks); draw one block per day and time
      const groups = new Map();
      for (const m of meetingsOf(ent.sec)) {
        if (m.once) continue;
        const raw = ent.sec.mt[m.ri];
        const room = roomText(raw);
        days.forEach((d, di) => {
          if (!(m.days & (1 << d))) return;
          const key = `${d}|${m.s}|${m.e}`;
          const g = groups.get(key);
          if (!g) {
            groups.set(key, { di, m, sd: raw.sd, ed: raw.ed, rooms: room ? [room] : [] });
          } else {
            if (raw.sd && (!g.sd || raw.sd < g.sd)) g.sd = raw.sd;
            if (raw.ed && (!g.ed || raw.ed > g.ed)) g.ed = raw.ed;
            if (room && !g.rooms.includes(room)) g.rooms.push(room);
          }
        });
      }
      for (const { di, m, sd, ed, rooms } of groups.values()) {
        perDay[di].push({ ...ent, kind, s: m.s, e: m.e, m, raw: { sd, ed, where: rooms.join(' / ') } });
      }
    }
  };
  addItems(ghost, 'ghost');
  addItems(entries, 'block');

  const pos = (s, e) => `--t:${(s - lo) / 60};--h:${(e - s) / 60}`;
  const dayOff = (d) => !!(limits.daysOff & (1 << d));

  const cols = days
    .map((d, di) => {
      const brk = breaks
        .filter((b) => b.d === d)
        .map((b) => `<div class="wk-break" style="${pos(b.s, b.e)};--ci:${di}" title="Break ${fmtRange(b.s, b.e)}"></div>`)
        .join('');
      let zones = '';
      if (dayOff(d)) {
        zones = `<div class="wk-limit is-dayoff" style="${pos(lo, hi)};--ci:${di}" title="Day off: no classes on ${DAY_NAMES[d]}"></div>`;
      } else {
        if (limits.earliest != null && limits.earliest > lo) {
          zones += `<div class="wk-limit is-before" style="${pos(lo, limits.earliest)};--ci:${di}" title="No classes before ${fmtTime(limits.earliest)}"></div>`;
        }
        if (limits.latest != null && limits.latest < hi) {
          zones += `<div class="wk-limit is-after" style="${pos(limits.latest, hi)};--ci:${di}" title="Done by ${fmtTime(limits.latest)}"></div>`;
        }
      }
      const mine = new Set(entries.map((e) => e.sec.crn));
      const ghosts = lanes(perDay[di].filter((x) => x.kind === 'ghost'))
        .map((x) => {
          // Same section in both schedules: outline only (the block already says what it is)
          const same = mine.has(x.sec.crn);
          return `<div class="wk-ghost${same ? ' is-same' : ''}" style="${pos(x.s, x.e)}" title="${esc(x.label || '')}: ${esc(x.sec.subj)} ${esc(x.sec.num)}${same ? ' (same section)' : ''}">${same ? '' : `<span>${esc(x.sec.subj)} ${esc(x.sec.num)}</span>`}</div>`;
        })
        .join('');
      const blocks = lanes(perDay[di].filter((x) => x.kind === 'block'))
        .map((x) => {
          const s = x.sec;
          const r = x.raw || {};
          const partial =
            termRange && r.sd && r.ed && isPartial(r, termRange)
              ? `<span class="wk-partial">${shortDate(r.sd)} – ${shortDate(r.ed)}</span>`
              : '';
          const where = r.where || '';
          const warn = opts.warnings?.has(`${s.crn}:${d}:${x.s}`)
            ? `<span class="wk-warn" title="Less than 15 minutes to get here from another building">${icons.warn}</span>`
            : '';
          const style = `${pos(x.s, x.e)};--lane:${x.lane};--lanes:${x.lanes}`;
          const len = x.e - x.s;
          const size = len < 40 ? ' is-short is-tiny' : len < 65 ? ' is-short' : '';
          const state = `${x.muted ? ' is-muted' : ''}${x.clash ? ' is-clash' : ''}`;
          const note = x.clash ? `, ${(x.issue || 'conflicts with another class').toLowerCase()}` : x.muted ? ', does not fit your current settings' : '';
          return `<button type="button" class="wk-block c${x.color}${x.locked ? ' is-locked' : ''}${size}${state}" style="${style}" data-crn="${esc(s.crn)}" aria-label="${esc(`${s.subj} ${s.num} section ${s.seq}, ${DAY_NAMES[d]} ${fmtRange(x.s, x.e)}${where ? `, ${where}` : ''}${note}`)}">
            <span class="wk-code">${esc(s.subj)} ${esc(s.num)}${x.locked ? `<span class="wk-lock">${icons.lock}</span>` : ''}${x.clash ? `<span class="wk-warn" title="${esc(x.issue || 'Conflicts with another class')}">${icons.warn}</span>` : warn}</span>
            <span class="wk-time">${fmtRange(x.s, x.e)}</span>
            <span class="wk-meta">${esc(s.seq)}${where ? ` – ${esc(where)}` : ''}</span>
            ${partial}
          </button>`;
        })
        .join('');
      return `<div class="wk-col" data-d="${d}">${zones}${brk}${ghosts}${blocks}</div>`;
    })
    .join('');

  // Filter times sit in the time column (nothing can cover them there) and replace the hour label they land on
  const marks = [
    [limits.earliest, 'Earliest class'],
    [limits.latest, 'Done by'],
  ].filter(([t]) => t != null && t > lo && t < hi);
  const labels =
    Array.from({ length: hours }, (_, i) => lo + i * 60)
      .filter((t) => !marks.some(([m]) => m === t))
      .map((t) => `<div class="wk-hour" style="--t:${(t - lo) / 60}">${fmtHour(t)}</div>`)
      .join('') +
    marks.map(([t, what]) => `<div class="wk-limit-mark${t % 60 ? ' has-min' : ''}" style="--t:${(t - lo) / 60}" title="${what} ${fmtTime(t)}">${fmtTime(t, false)}<span class="wk-mer"> ${t >= 720 ? 'PM' : 'AM'}</span></div>`).join('');
  const offNames = days.filter(dayOff).map((d) => `${DAY_NAMES[d]}s`);
  const keyParts = [
    limits.earliest != null ? `before ${fmtTime(limits.earliest)}` : '',
    limits.latest != null ? `after ${fmtTime(limits.latest)}` : '',
    offNames.length ? offNames.join(', ') : '',
    breaks.length ? 'your breaks' : '',
  ].filter(Boolean);
  const key = keyParts.length
    ? `<p class="wk-key"><span class="wk-key-swatch" aria-hidden="true"></span>Shaded: ${keyParts.length > 1 ? `${keyParts.slice(0, -1).join(', ')} and ${keyParts[keyParts.length - 1]}` : keyParts[0]}</p>`
    : '';

  el.innerHTML = `
    <div class="wk${painting ? ' is-painting' : ''}" style="--hours:${hours};--days:${days.length}">
      <div class="wk-head">
        <div class="wk-corner"></div>
        ${days.map((d) => `<div class="wk-day${dayOff(d) ? ' is-off' : ''}"><abbr title="${DAY_NAMES[d]}">${DAY_SHORT[d]}</abbr>${dayOff(d) ? '<span class="wk-day-off">Day off</span>' : ''}</div>`).join('')}
      </div>
      <div class="wk-body">
        <div class="wk-times">${labels}</div>
        <div class="wk-cols">${cols}<div class="wk-preview" hidden></div></div>
      </div>
    </div>${key}`;

  el.querySelectorAll('.wk-block').forEach((b) => b.addEventListener('click', () => opts.onBlock?.(b.dataset.crn)));
  if (painting) attachPainter(el, { lo, hi, days, breaks, onPaint: opts.onPaint });
}

function toSlots(breaks, d) {
  const set = new Set();
  for (const b of breaks) if (b.d === d) for (let t = b.s; t < b.e; t += SLOT) set.add(t);
  return set;
}

function fromSlots(set, d) {
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  for (const t of sorted) {
    const last = out[out.length - 1];
    if (last && last.e === t) last.e = t + SLOT;
    else out.push({ d, s: t, e: t + SLOT });
  }
  return out;
}

/** Drag across the grid to add (or, starting on a break, remove) blocked time. Works with touch */
function attachPainter(el, { lo, hi, days, breaks, onPaint }) {
  const colsEl = el.querySelector('.wk-cols');
  const preview = el.querySelector('.wk-preview');
  let drag = null;

  const cellAt = (ev) => {
    const r = colsEl.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - r.left, 0), r.width - 1);
    const y = Math.min(Math.max(ev.clientY - r.top, 0), r.height - 1);
    const di = Math.floor((x / r.width) * days.length);
    const t = lo + Math.floor(((y / r.height) * (hi - lo)) / SLOT) * SLOT;
    return { di, t };
  };

  const show = () => {
    const a = Math.min(drag.start.di, drag.cur.di);
    const b = Math.max(drag.start.di, drag.cur.di);
    const s = Math.min(drag.start.t, drag.cur.t);
    const e = Math.max(drag.start.t, drag.cur.t) + SLOT;
    preview.hidden = false;
    preview.className = `wk-preview${drag.erase ? ' is-erase' : ''}`;
    preview.style.cssText = `--t:${(s - lo) / 60};--h:${(e - s) / 60};--c0:${a};--cn:${b - a + 1}`;
    preview.textContent = `${drag.erase ? 'Clear' : 'Block'} ${fmtRange(s, e)}`;
    return { a, b, s, e };
  };

  colsEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const c = cellAt(ev);
    const erase = toSlots(breaks, days[c.di]).has(c.t);
    drag = { start: c, cur: c, erase, id: ev.pointerId };
    colsEl.setPointerCapture(ev.pointerId);
    show();
  });
  colsEl.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    drag.cur = cellAt(ev);
    show();
  });
  const finish = (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const { a, b, s, e } = show();
    const next = breaks.filter((br) => !days.slice(a, b + 1).includes(br.d));
    for (let di = a; di <= b; di++) {
      const d = days[di];
      const set = toSlots(breaks, d);
      for (let t = s; t < e; t += SLOT) {
        if (drag.erase) set.delete(t);
        else set.add(t);
      }
      next.push(...fromSlots(set, d));
    }
    drag = null;
    preview.hidden = true;
    next.sort((x, y) => x.d - y.d || x.s - y.s);
    onPaint?.(next);
  };
  colsEl.addEventListener('pointerup', finish);
  colsEl.addEventListener('pointercancel', () => {
    drag = null;
    preview.hidden = true;
  });
}

/** Tiny SVG silhouette of a schedule for the results strip */
export function thumbSvg(entries, { days = 5, lo = 8 * 60, hi = 21 * 60 } = {}) {
  const W = 120;
  const H = 84;
  const colW = W / days;
  const rects = [];
  for (const { sec, color } of entries) {
    for (const m of meetingsOf(sec)) {
      if (m.once) continue;
      for (let d = 0; d < days; d++) {
        if (!(m.days & (1 << d))) continue;
        const y = ((Math.max(m.s, lo) - lo) / (hi - lo)) * H;
        const h = Math.max(2, ((Math.min(m.e, hi) - Math.max(m.s, lo)) / (hi - lo)) * H);
        rects.push(`<rect class="tf c${color}" x="${(d * colW + 1.5).toFixed(1)}" y="${y.toFixed(1)}" width="${(colW - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"/>`);
      }
    }
  }
  const lines = Array.from({ length: days - 1 }, (_, i) => `<line x1="${((i + 1) * colW).toFixed(1)}" y1="0" x2="${((i + 1) * colW).toFixed(1)}" y2="${H}"/>`).join('');
  const noon = (((12 * 60 - lo) / (hi - lo)) * H).toFixed(1);
  return `<svg viewBox="0 0 ${W} ${H}" class="thumb-svg" aria-hidden="true"><g class="tg">${lines}<line class="noon" x1="0" y1="${noon}" x2="${W}" y2="${noon}"/></g>${rects.join('')}</svg>`;
}

import { db, loadTerms, loadTerm, loadRmp, loadGrades, rmpFor, gpaFor, searchCourses } from './data.js';
import {
  REASONS,
  REASONS_PLURAL,
  SORTS,
  DAY_SHORT,
  DAY_NAMES,
  sectionReason,
  lockedTypesOf,
  buildBundles,
  meetingsOf,
  meetingsConflict,
  isTimed,
  hasSeat,
  generate,
  comparator,
  measure,
  balancedScore,
} from './engine.js';
import { renderGrid, thumbSvg } from './grid.js';
import { openCourseModal, meetingText, locationText } from './modal.js';
import { buildICS } from './ics.js';
import {
  $,
  $$,
  esc,
  fmtTime,
  fmtRange,
  fmtDuration,
  fmtNum,
  timeAgo,
  debounce,
  store,
  toast,
  copyText,
  download,
  ratingClass,
  gpaClass,
  icons,
  roomText,
} from './util.js';

const PALETTE = 8;
const CAP = 20000;

const defaultPrefs = () => ({
  earliest: null,
  latest: null,
  daysOff: 0,
  openOnly: false,
  waitlistOk: false,
  campusOff: [],
  methodOff: [],
  breaks: [],
  maxPerDay: null,
  minCredits: null,
  maxCredits: null,
});

const state = {
  term: null,
  plan: { courses: [], prefs: defaultPrefs(), sort: 'balanced' },
  saved: [],
  expanded: new Set(),
  results: [],
  sorted: [],
  total: 0,
  stopped: null,
  trimmed: false,
  diag: null,
  job: null,
  index: 0,
  view: { kind: 'results' },
  overlay: null,
  painting: false,
  tab: 'schedules',
  mobile: 'plan',
  generating: false,
  sideBySide: store.get('ns:sideBySide', false) === true,
  shownThumbs: 0,
  lastShown: [],
};

// Persistence

const planKey = () => `ns:plan:${state.term}`;
const savedKey = () => `ns:saved:${state.term}`;

function persist() {
  store.set(planKey(), state.plan);
  store.set(savedKey(), state.saved);
}

function restore() {
  const p = store.get(planKey(), null);
  state.plan = { courses: [], prefs: defaultPrefs(), sort: 'balanced' };
  if (p) {
    state.plan.prefs = { ...defaultPrefs(), ...(p.prefs || {}) };
    delete state.plan.prefs.lunch; // removed option; drop it from older saved plans
    state.plan.sort = SORTS[p.sort] ? p.sort : 'balanced';
    state.plan.courses = (p.courses || [])
      .filter((c) => db.courses.has(c.key))
      .map((c) => ({ key: c.key, optional: !!c.optional, locked: c.locked || [], excluded: c.excluded || [], color: c.color ?? 0 }));
  }
  state.saved = store.get(savedKey(), []);
  state.expanded = new Set(state.plan.courses.length <= 2 ? state.plan.courses.map((c) => c.key) : []);
  state.view = { kind: 'results' };
  state.overlay = null;
  state.lastShown = [];
}

// Helpers

const courseOf = (key) => state.plan.courses.find((c) => c.key === key);
const primary = (sec) => sec.inst[0] || 'Staff';
const termDays = () => {
  const sat = db.term.sections.some((s) => s.mt.some((m) => m.d?.includes('S')));
  return sat ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4];
};

let termRange = null;
function computeTermRange() {
  const counts = new Map();
  for (const s of db.term.sections) for (const m of s.mt) if (m.sd && m.ed && m.sd !== m.ed) {
    const k = `${m.sd}|${m.ed}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = null;
  let n = 0;
  for (const [k, v] of counts) if (v > n) [best, n] = [k, v];
  termRange = best ? { sd: best.split('|')[0], ed: best.split('|')[1] } : null;
}

function nextColor() {
  const used = new Set(state.plan.courses.map((c) => c.color));
  for (let i = 0; i < PALETTE; i++) if (!used.has(i)) return i;
  return state.plan.courses.length % PALETTE;
}

function sectionGpa(sec) {
  return sec.cr > 0 ? gpaFor(`${sec.subj} ${sec.num}`, primary(sec)) : null;
}

function sectionRating(sec) {
  const p = rmpFor(primary(sec));
  return p ? p.r : null;
}

function seatsText(sec) {
  if (sec.seats == null) return '';
  if (sec.seats > 0) return `${sec.seats} open`;
  const wl = (sec.wcap || 0) - (sec.wcnt || 0);
  return wl > 0 ? `Full, ${wl} waitlist` : 'Full';
}

function whereText(sec) {
  const m = sec.mt.find((x) => x.b);
  return m ? roomText(m) : sec.campus || '';
}

/** Sections + colors for whatever the board is showing right now */
function currentEntries() {
  if (state.view.kind === 'crns') return entriesForCrns(state.view.crns);
  const r = state.sorted[state.index];
  if (!r || !state.job) return state.job && !state.total ? fallbackEntries() : [];
  const out = [];
  r.pick.forEach((bi, ci) => {
    if (bi < 0) return;
    const c = state.job.courses[ci];
    for (const sec of state.job.bundles[ci][bi]) out.push({ sec, color: c.color, locked: c.locked.includes(sec.crn), key: c.key });
  });
  if (out.length) state.lastShown = out.map((e) => e.sec.crn);
  return out;
}

/**
 * Nothing fits: instead of an empty calendar, keep the last schedule on screen (or a stand-in
 * section for each course), grayed out, with the classes that overlap each other flagged.
 */
function fallbackEntries() {
  const last = new Set(state.lastShown);
  const out = [];
  for (const c of state.plan.courses) {
    const course = db.courses.get(c.key);
    if (!course) continue;
    let pick = course.sections.filter((s) => last.has(s.crn));
    if (!pick.length) {
      const lockedTypes = lockedTypesOf(c, course.sections);
      const pool = course.sections.filter((s) => c.locked.includes(s.crn) || (!lockedTypes.has(s.type) && !c.excluded.includes(s.crn)));
      const use = pool.length ? pool : course.sections;
      pick = buildBundles(course.sections, new Set(use.map((s) => s.crn)), db.term.links || {})[0] || [];
      if (!pick.length) {
        const types = new Set();
        pick = use.filter((s) => !types.has(s.type) && types.add(s.type));
      }
    }
    for (const sec of pick) out.push({ sec, color: c.color, locked: c.locked.includes(sec.crn), key: c.key, muted: true });
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      if (out[i].key !== out[j].key && meetingsConflict(meetingsOf(out[i].sec), meetingsOf(out[j].sec))) {
        out[i].clash = true;
        out[j].clash = true;
        out[i].issue ||= `Conflicts with ${out[j].key}`;
        out[j].issue ||= `Conflicts with ${out[i].key}`;
      }
    }
  }
  return out;
}

function entriesForCrns(crns) {
  const out = [];
  for (const crn of crns) {
    const sec = db.byCrn.get(crn);
    if (!sec) continue;
    const key = `${sec.subj} ${sec.num}`;
    const c = courseOf(key);
    out.push({ sec, color: c ? c.color : out.length % PALETTE, locked: c ? c.locked.includes(crn) : false, key });
  }
  return out;
}

function metricsFor(entries) {
  const secs = [];
  const bundles = [];
  const byCourse = new Map();
  for (const e of entries) {
    if (!byCourse.has(e.key)) byCourse.set(e.key, []);
    byCourse.get(e.key).push(e.sec);
  }
  for (const list of byCourse.values()) {
    const idx = list.map((s) => {
      secs.push({ m: meetingsOf(s), rating: sectionRating(s), gpa: sectionGpa(s), seats: s.seats, timed: isTimed(s), main: (s.cr || 0) > 0 });
      return secs.length - 1;
    });
    bundles.push({ secs: idx, m: idx.flatMap((i) => secs[i].m), cr: list.reduce((t, s) => t + (s.cr || 0), 0) });
  }
  const m = measure(bundles, secs, {});
  if (!m) return null;
  m.credits = bundles.reduce((t, b) => t + b.cr, 0);
  m.score = balancedScore(m);
  return m;
}

function tightWarnings(entries) {
  // Back-to-back (<15 min) classes in different buildings get a warning badge.
  const out = new Set();
  for (let d = 0; d < 7; d++) {
    const list = [];
    for (const e of entries) for (const m of meetingsOf(e.sec)) if (!m.once && m.days & (1 << d)) list.push({ e, m });
    list.sort((a, b) => a.m.s - b.m.s);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1].m;
      const b = list[i].m;
      const gap = b.s - a.e;
      if (gap >= 0 && gap < 15 && a.b && b.b && a.b !== b.b) out.add(`${list[i].e.sec.crn}:${d}:${b.s}`);
    }
  }
  return out;
}

const sigOf = (entries) => entries.map((e) => e.sec.crn).sort().join('.');

// Generation (Web Worker with a main-thread fallback)

let worker = null;
let workerBusy = false;
let jobSeq = 0;

function makeWorker() {
  try {
    return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function runGenerate(input) {
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    if (workerBusy && worker) {
      worker.terminate(); // cancel the stale job instantly
      worker = null;
    }
    if (!worker) worker = makeWorker();
    if (!worker) {
      setTimeout(() => {
        if (id !== jobSeq) return;
        try {
          resolve({ id, out: generate(input) });
        } catch (err) {
          reject(err);
        }
      }, 0);
      return;
    }
    workerBusy = true;
    worker.onmessage = (e) => {
      if (e.data.id !== id) return;
      workerBusy = false;
      if (e.data.ok) resolve({ id, out: e.data.out });
      else reject(new Error(e.data.error));
    };
    worker.onerror = (err) => {
      workerBusy = false;
      worker = null;
      try {
        resolve({ id, out: generate(input) });
      } catch (e2) {
        reject(e2 || err);
      }
    };
    worker.postMessage({ id, input });
  });
}

const regenerate = debounce(async () => {
  const prefs = state.plan.prefs;
  const courses = state.plan.courses.map((c) => ({ ...c, locked: [...c.locked], excluded: [...c.excluded] }));
  const secs = [];
  const secIndex = new Map();
  const bundles = [];
  const fit = {};
  const inputCourses = courses.map((c) => {
    const course = db.courses.get(c.key);
    const lt = lockedTypesOf(c, course.sections);
    const allowed = new Set();
    for (const s of course.sections) if (!sectionReason(s, c, prefs, lt)) allowed.add(s.crn);
    const list = buildBundles(course.sections, allowed, db.term.links || {});
    bundles.push(list);
    fit[c.key] = { allowed: allowed.size, bundles: list.length };
    return {
      key: c.key,
      optional: c.optional,
      bundles: list.map((b) => ({
        secs: b.map((s) => {
          if (!secIndex.has(s.crn)) {
            secIndex.set(s.crn, secs.length);
            secs.push({ m: meetingsOf(s), rating: sectionRating(s), gpa: sectionGpa(s), seats: s.seats, timed: isTimed(s), main: (s.cr || 0) > 0 });
          }
          return secIndex.get(s.crn);
        }),
        cr: b.reduce((t, s) => t + (s.cr || 0), 0),
      })),
    };
  });

  const before = sigOf(currentEntries());
  state.fit = fit;
  if (!courses.length) {
    Object.assign(state, { job: null, results: [], sorted: [], total: 0, stopped: null, trimmed: false, diag: null, index: 0, generating: false });
    renderCourses();
    renderBoard();
    return;
  }
  state.generating = true;
  renderResultsBar();
  try {
    const { id, out } = await runGenerate({
      courses: inputCourses,
      secs,
      prefs: { maxPerDay: prefs.maxPerDay, minCredits: prefs.minCredits, maxCredits: prefs.maxCredits },
      cap: CAP,
      countLimit: 1_000_000,
      timeLimit: 5000,
    });
    if (id !== jobSeq) return;
    state.job = { courses, bundles };
    state.results = out.results;
    state.total = out.total;
    state.stopped = out.stopped;
    state.trimmed = out.trimmed;
    state.keep = out.keep;
    state.diag = out.diag;
    state.generating = false;
    sortResults(before);
    renderCourses();
    renderBoard();
  } catch (err) {
    state.generating = false;
    console.error(err);
    toast(`Couldn't build schedules: ${err.message}`);
  }
}, 120);

function sortResults(keepSig) {
  state.sorted = [...state.results].sort(comparator(state.plan.sort));
  state.index = 0;
  if (keepSig && state.view.kind === 'results') {
    const i = state.sorted.findIndex((r) => sigOf(entriesForPick(r)) === keepSig);
    if (i >= 0) state.index = i;
  }
  state.shownThumbs = 0;
}

function entriesForPick(r) {
  const out = [];
  r.pick.forEach((bi, ci) => {
    if (bi < 0) return;
    for (const sec of state.job.bundles[ci][bi]) out.push({ sec, key: state.job.courses[ci].key, color: state.job.courses[ci].color });
  });
  return out;
}

function changed({ regen = true } = {}) {
  persist();
  if (regen) regenerate();
}

// Plan panel: search

function initSearch() {
  const input = $('#course-search');
  const list = $('#search-results');
  let items = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };
  const paint = () => {
    $$('li', list).forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    const el = list.children[active];
    if (el) el.scrollIntoView({ block: 'nearest' });
  };
  const show = () => {
    const q = input.value;
    items = searchCourses(q);
    if (!q.trim()) return close();
    if (!items.length) {
      list.innerHTML = `<li class="sr-empty">No ${esc(db.term.desc)} course matches “${esc(q)}”.</li>`;
    } else {
      list.innerHTML = items
        .map(({ course, crn }, i) => {
          const added = !!courseOf(course.key);
          const open = course.sections.filter((s) => hasSeat(s, false)).length;
          return `<li role="option" id="sr-${i}" data-i="${i}" aria-selected="false" class="${added ? 'is-added' : ''}">
            <span class="sr-code">${esc(course.key)}</span>
            <span class="sr-title">${esc(course.title)}</span>
            <span class="sr-meta">${crn ? `CRN ${esc(crn)}` : added ? 'Added' : `${course.sections.length} sections, ${open} open`}</span>
          </li>`;
        })
        .join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = items.length ? 0 : -1;
    paint();
  };
  const choose = (i) => {
    const it = items[i];
    if (!it) return;
    addCourse(it.course.key, it.crn);
    input.value = '';
    close();
    input.focus();
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', () => input.value && show());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && items.length) {
      active = (active + 1) % items.length;
      paint();
      e.preventDefault();
    } else if (e.key === 'ArrowUp' && items.length) {
      active = (active - 1 + items.length) % items.length;
      paint();
      e.preventDefault();
    } else if (e.key === 'Enter') {
      if (active >= 0) choose(active);
      e.preventDefault();
    } else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) {
      e.preventDefault();
      choose(Number(li.dataset.i));
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search')) close();
  });
}

async function addCourse(key, lockCrn = null) {
  let c = courseOf(key);
  if (!c) {
    c = { key, optional: false, locked: [], excluded: [], color: nextColor() };
    state.plan.courses.push(c);
    state.expanded.add(key);
    toast(`Added ${key}`);
  }
  if (lockCrn) {
    const sec = db.byCrn.get(lockCrn);
    const course = db.courses.get(key);
    c.locked = c.locked.filter((crn) => course.sections.find((s) => s.crn === crn)?.type !== sec.type);
    c.locked.push(lockCrn);
    toast(`Locked ${key} section ${sec.seq} (CRN ${lockCrn})`);
  }
  state.view = { kind: 'results' };
  renderCourses();
  changed();
  await loadGrades(key.split(' ')[0]);
  renderCourses();
  regenerate();
}

// Plan panel: course list

function renderCourses() {
  const el = $('#course-list');
  if (!state.plan.courses.length) {
    el.innerHTML = `<div class="empty-plan">
      <p><strong>Start by adding the courses you want to take.</strong></p>
      <p class="muted">Search by course code, title or CRN. Every combination of sections that doesn't conflict shows up on the right, and you can lock sections, turn off professors and block off time to narrow it down.</p>
    </div>`;
    return;
  }
  const prefs = state.plan.prefs;
  el.innerHTML = state.plan.courses
    .map((c) => {
      const course = db.courses.get(c.key);
      const lt = lockedTypesOf(c, course.sections);
      const reasons = new Map(course.sections.map((s) => [s.crn, sectionReason(s, c, prefs, lt)]));
      const fits = state.fit?.[c.key];
      const usable = course.sections.filter((s) => !reasons.get(s.crn)).length;
      const open = state.expanded.has(c.key);
      const cr = course.crMin === course.crMax ? `${course.crMin} credits` : `${course.crMin}–${course.crMax} credits`;
      const status =
        fits && fits.bundles === 0
          ? `<span class="fit is-bad">${icons.warn} No sections fit</span>`
          : `<span class="fit">${usable} of ${course.sections.length} sections usable</span>`;
      return `<article class="course c${c.color}${open ? ' is-open' : ''}" data-key="${esc(c.key)}">
        <div class="course-head">
          <button type="button" class="course-toggle" data-act="toggle" aria-expanded="${open}">
            <span class="swatch" aria-hidden="true"></span>
            <span class="course-code">${esc(c.key)}</span>
            <span class="course-title">${esc(course.title)}</span>
            <span class="chev" aria-hidden="true">${icons.chevron}</span>
          </button>
          <button type="button" class="icon-btn sm" data-act="info" aria-label="${esc(c.key)} details, ratings and grades" title="Details, ratings and grades">${icons.info}</button>
          <button type="button" class="icon-btn sm" data-act="remove" aria-label="Remove ${esc(c.key)}" title="Remove">${icons.x}</button>
        </div>
        <div class="course-sub">
          <span>${cr}</span>
          ${status}
          <label class="mini-switch" title="Optional courses are only added when they fit"><input type="checkbox" data-act="optional"${c.optional ? ' checked' : ''}><span>Optional</span></label>
        </div>
        ${open ? courseBody(c, course, reasons) : ''}
      </article>`;
    })
    .join('');
}

function courseBody(c, course, reasons) {
  const byInst = new Map();
  for (const s of course.sections) {
    const n = primary(s);
    if (!byInst.has(n)) byInst.set(n, []);
    byInst.get(n).push(s);
  }
  const chips = [...byInst.entries()]
    .map(([name, secs]) => {
      const on = secs.some((s) => !c.excluded.includes(s.crn));
      const p = rmpFor(name);
      const g = secs[0].cr > 0 ? gpaFor(c.key, name) : null;
      return `<button type="button" class="chip${on ? '' : ' is-off'}" data-act="inst" data-name="${esc(name)}" aria-pressed="${on}" title="${on ? 'Turn off' : 'Turn on'} every section ${esc(name)} teaches">
        <span>${esc(name)}</span>
        ${p ? `<span class="pill ${ratingClass(p.r)}" title="${p.n} ratings on Rate My Professors">${p.r.toFixed(1)}</span>` : ''}
        ${g != null ? `<span class="pill sm ${gpaClass(g)}" title="Average GPA in this course">GPA ${g.toFixed(2)}</span>` : ''}
      </button>`;
    })
    .join('');

  const types = [...new Set(course.sections.map((s) => s.type))];
  const groups = types
    .map((t) => {
      const rows = course.sections
        .filter((s) => s.type === t)
        .map((s) => {
          const reason = reasons.get(s.crn);
          const locked = c.locked.includes(s.crn);
          const excluded = c.excluded.includes(s.crn);
          const seat = s.seats == null ? '' : s.seats > 0 ? 'has-seats' : 'is-full';
          const p = rmpFor(primary(s));
          return `<li class="sec${reason ? ' is-off' : ''}${locked ? ' is-locked' : ''}" data-crn="${esc(s.crn)}">
            <input type="checkbox" class="sec-check" data-act="sec" aria-label="Use section ${esc(s.seq)}, CRN ${esc(s.crn)}"${excluded ? '' : ' checked'}${locked ? ' disabled' : ''}>
            <button type="button" class="lock-btn" data-act="lock" aria-pressed="${locked}" aria-label="${locked ? 'Unlock' : 'Lock'} section ${esc(s.seq)}" title="${locked ? 'Unlock' : 'Lock in this section'}">${locked ? icons.lock : icons.unlock}</button>
            <div class="sec-main">
              <div class="sec-l1"><span class="sec-time">${esc(meetingText(s))}</span><span class="sec-seq">${esc(s.seq)}</span></div>
              <div class="sec-l2"><span>${esc(primary(s))}</span>${p ? `<span class="pill sm ${ratingClass(p.r)}">${p.r.toFixed(1)}</span>` : ''}<span class="muted">${esc(whereText(s))}${s.method && !/face/i.test(s.method) ? `, ${esc(s.method)}` : ''}</span></div>
              ${reason && reason !== 'excluded' ? `<div class="sec-reason">${esc(REASONS[reason])}</div>` : ''}
            </div>
            <div class="sec-seats ${seat}" title="${s.enr ?? '?'} of ${s.max ?? '?'} seats taken${s.wcap ? `, waitlist ${s.wcnt}/${s.wcap}` : ''}">
              <span class="sec-crn">${esc(s.crn)}</span>
              <span>${esc(seatsText(s))}</span>
            </div>
          </li>`;
        })
        .join('');
      return `${types.length > 1 ? `<h4 class="sec-type">${esc(t)}</h4>` : ''}<ul class="sec-list">${rows}</ul>`;
    })
    .join('');

  return `<div class="course-body">
    <div class="chips" aria-label="Instructors">${chips}</div>
    <div class="sec-tools">
      <button type="button" class="link-btn" data-act="all">Use all</button>
      <button type="button" class="link-btn" data-act="none">Use none</button>
      <button type="button" class="link-btn" data-act="openonly">Only open seats</button>
    </div>
    ${groups}
  </div>`;
}

function initCourseEvents() {
  $('#course-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const art = btn.closest('.course');
    const key = art?.dataset.key;
    const c = courseOf(key);
    if (!c) return;
    const course = db.courses.get(key);
    const act = btn.dataset.act;
    if (act === 'toggle') {
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderCourses();
      return;
    }
    if (act === 'info') {
      openCourseModal($('#course-modal'), key, { color: c.color });
      return;
    }
    if (act === 'remove') {
      state.plan.courses = state.plan.courses.filter((x) => x.key !== key);
      toast(`Removed ${key}`);
    } else if (act === 'lock') {
      const crn = btn.closest('.sec').dataset.crn;
      const sec = db.byCrn.get(crn);
      if (c.locked.includes(crn)) c.locked = c.locked.filter((x) => x !== crn);
      else {
        c.locked = c.locked.filter((x) => db.byCrn.get(x)?.type !== sec.type);
        c.locked.push(crn);
        c.excluded = c.excluded.filter((x) => x !== crn);
      }
    } else if (act === 'inst') {
      const name = btn.dataset.name;
      const mine = course.sections.filter((s) => primary(s) === name).map((s) => s.crn);
      const anyOn = mine.some((crn) => !c.excluded.includes(crn));
      c.excluded = c.excluded.filter((x) => !mine.includes(x));
      if (anyOn) c.excluded.push(...mine.filter((crn) => !c.locked.includes(crn)));
    } else if (act === 'all') c.excluded = [];
    else if (act === 'none') c.excluded = course.sections.map((s) => s.crn).filter((crn) => !c.locked.includes(crn));
    else if (act === 'openonly') c.excluded = course.sections.filter((s) => !hasSeat(s, false) && !c.locked.includes(s.crn)).map((s) => s.crn);
    else return;
    state.view = { kind: 'results' };
    renderCourses();
    changed();
  });
  $('#course-list').addEventListener('change', (e) => {
    const t = e.target;
    const key = t.closest('.course')?.dataset.key;
    const c = courseOf(key);
    if (!c) return;
    if (t.dataset.act === 'optional') c.optional = t.checked;
    else if (t.dataset.act === 'sec') {
      const crn = t.closest('.sec').dataset.crn;
      c.excluded = c.excluded.filter((x) => x !== crn);
      if (!t.checked) c.excluded.push(crn);
    } else return;
    state.view = { kind: 'results' };
    renderCourses();
    changed();
  });
}

// Plan panel: preferences

function timeOptions(from, to, value, anyLabel = null) {
  let html = anyLabel == null ? '' : `<option value=""${value == null ? ' selected' : ''}>${anyLabel}</option>`;
  for (let t = from; t <= to; t += 30) html += `<option value="${t}"${value === t ? ' selected' : ''}>${fmtTime(t)}</option>`;
  return html;
}

function distinct(field) {
  const counts = new Map();
  for (const s of db.term.sections) if (s[field]) counts.set(s[field], (counts.get(s[field]) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([v]) => v);
}

function renderPrefs() {
  const p = state.plan.prefs;
  const days = termDays();
  const breaks = p.breaks.length
    ? `<ul class="break-list">${p.breaks
        .map((b, i) => `<li><span>${DAY_SHORT[b.d]} ${fmtRange(b.s, b.e)}</span><button type="button" class="icon-btn xs" data-pact="rm-break" data-i="${i}" aria-label="Remove ${DAY_NAMES[b.d]} ${fmtRange(b.s, b.e)} break">${icons.x}</button></li>`)
        .join('')}</ul>`
    : '';
  const campuses = distinct('campus');
  const methods = distinct('method');
  const open = store.get('ns:prefsOpen', { times: true });
  const det = (id, title, body, summaryNote = '') =>
    `<details class="pref-group" data-id="${id}"${open[id] ? ' open' : ''}><summary><span>${title}</span>${summaryNote ? `<span class="pref-note">${summaryNote}</span>` : ''}</summary><div class="pref-body">${body}</div></details>`;

  const daysOffNote = days.filter((d) => p.daysOff & (1 << d)).map((d) => DAY_SHORT[d]).join(', ');
  const timesNote = [p.earliest != null ? `after ${fmtTime(p.earliest)}` : '', p.latest != null ? `before ${fmtTime(p.latest)}` : '', daysOffNote ? `no ${daysOffNote}` : ''].filter(Boolean).join(', ');

  $('#prefs').innerHTML = `
    <h2 class="panel-h">Preferences</h2>
    ${det(
      'times',
      'Times and days',
      `<div class="row2">
        <label>Earliest class<select data-pref="earliest">${timeOptions(7 * 60, 13 * 60, p.earliest, 'Any time')}</select></label>
        <label>Done by<select data-pref="latest">${timeOptions(12 * 60, 22 * 60, p.latest, 'Any time')}</select></label>
      </div>
      <fieldset class="days-off"><legend>Days off</legend>
        ${days.map((d) => `<button type="button" class="day-btn" data-pact="dayoff" data-d="${d}" aria-pressed="${!!(p.daysOff & (1 << d))}" aria-label="No classes on ${DAY_NAMES[d]}">${DAY_SHORT[d]}</button>`).join('')}
      </fieldset>`,
      timesNote,
    )}
    ${det(
      'breaks',
      'Breaks',
      `<p class="muted small">Block off work, practice or commute time. Drag across the calendar to draw breaks; drag over a break to erase it.</p>
      <button type="button" class="btn${state.painting ? ' is-on' : ''}" data-pact="paint" aria-pressed="${state.painting}">${icons.brush}<span>${state.painting ? 'Done drawing' : 'Draw breaks on the calendar'}</span></button>
      ${breaks}
      <div class="quick-break">
        <select data-qb="d" aria-label="Day"><option value="wk">Every weekday</option>${days.map((d) => `<option value="${d}">${DAY_NAMES[d]}</option>`).join('')}</select>
        <select data-qb="s" aria-label="From">${timeOptions(7 * 60, 21 * 60, 12 * 60)}</select>
        <select data-qb="e" aria-label="To">${timeOptions(7 * 60 + 30, 22 * 60, 13 * 60)}</select>
        <button type="button" class="btn" data-pact="add-break">Add</button>
      </div>`,
      p.breaks.length ? `${p.breaks.length} blocked` : '',
    )}
    ${det(
      'sections',
      'Seats, campus and format',
      `<label class="check"><input type="checkbox" data-pref="openOnly"${p.openOnly ? ' checked' : ''}> Only sections with open seats</label>
      <label class="check sub${p.openOnly ? '' : ' is-disabled'}"><input type="checkbox" data-pref="waitlistOk"${p.waitlistOk ? ' checked' : ''}${p.openOnly ? '' : ' disabled'}> Count open waitlist spots as open</label>
      <fieldset><legend>Campus</legend>${campuses.map((v) => `<label class="check"><input type="checkbox" data-list="campusOff" value="${esc(v)}"${p.campusOff.includes(v) ? '' : ' checked'}> ${esc(v)}</label>`).join('')}</fieldset>
      <fieldset><legend>Format</legend>${methods.map((v) => `<label class="check"><input type="checkbox" data-list="methodOff" value="${esc(v)}"${p.methodOff.includes(v) ? '' : ' checked'}> ${esc(v)}</label>`).join('')}</fieldset>`,
      [p.openOnly ? 'open seats' : '', p.campusOff.length || p.methodOff.length ? 'filtered' : ''].filter(Boolean).join(', '),
    )}
    ${det(
      'load',
      'Workload',
      `<div class="row2">
        <label>Min credits<input type="number" inputmode="numeric" min="0" max="30" data-pref="minCredits" value="${p.minCredits ?? ''}" placeholder="Any"></label>
        <label>Max credits<input type="number" inputmode="numeric" min="0" max="30" data-pref="maxCredits" value="${p.maxCredits ?? ''}" placeholder="Any"></label>
      </div>
      <p class="muted small">Credit limits matter most with optional courses: mark extras as optional and set a range, and only combinations in that range show up.</p>
      <label>Most classes in one day<select data-pref="maxPerDay"><option value="">No limit</option>${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}"${p.maxPerDay === n ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`,
      [p.minCredits != null || p.maxCredits != null ? `${p.minCredits ?? 0}–${p.maxCredits ?? '∞'} cr` : '', p.maxPerDay ? `≤${p.maxPerDay}/day` : ''].filter(Boolean).join(', '),
    )}
    <button type="button" class="link-btn reset" data-pact="reset">Reset preferences</button>`;
}

function initPrefEvents() {
  const el = $('#prefs');
  el.addEventListener('toggle', (e) => {
    const d = e.target.closest('details.pref-group');
    if (!d) return;
    const open = store.get('ns:prefsOpen', { times: true });
    open[d.dataset.id] = d.open;
    store.set('ns:prefsOpen', open);
  }, true);
  el.addEventListener('change', (e) => {
    const t = e.target;
    const p = state.plan.prefs;
    if (t.dataset.pref) {
      const k = t.dataset.pref;
      if (t.type === 'checkbox') p[k] = t.checked;
      else p[k] = t.value === '' ? null : Number(t.value);
      if (k === 'openOnly' && !t.checked) p.waitlistOk = false;
    } else if (t.dataset.list) {
      const k = t.dataset.list;
      p[k] = p[k].filter((v) => v !== t.value);
      if (!t.checked) p[k].push(t.value);
    } else return;
    state.view = { kind: 'results' };
    renderPrefs();
    renderCourses();
    changed();
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pact]');
    if (!b || b.tagName === 'INPUT') return;
    const p = state.plan.prefs;
    const act = b.dataset.pact;
    if (act === 'dayoff') p.daysOff ^= 1 << Number(b.dataset.d);
    else if (act === 'paint') {
      setPainting(!state.painting);
      return;
    } else if (act === 'rm-break') p.breaks.splice(Number(b.dataset.i), 1);
    else if (act === 'add-break') {
      const d = $('[data-qb="d"]', el).value;
      const s = Number($('[data-qb="s"]', el).value);
      const en = Number($('[data-qb="e"]', el).value);
      if (en <= s) {
        toast('A break has to end after it starts.');
        return;
      }
      const days = d === 'wk' ? [0, 1, 2, 3, 4] : [Number(d)];
      for (const day of days) p.breaks.push({ d: day, s, e: en });
      p.breaks = mergeBreaks(p.breaks);
    } else if (act === 'reset') {
      state.plan.prefs = defaultPrefs();
      toast('Preferences reset');
    } else return;
    state.view = { kind: 'results' };
    renderPrefs();
    renderCourses();
    changed();
  });
}

function mergeBreaks(list) {
  const out = [];
  for (const b of [...list].sort((x, y) => x.d - y.d || x.s - y.s)) {
    const last = out[out.length - 1];
    if (last && last.d === b.d && b.s <= last.e) last.e = Math.max(last.e, b.e);
    else out.push({ ...b });
  }
  return out;
}

function setPainting(on) {
  state.painting = on;
  if (on) {
    state.tab = 'schedules';
    state.mobile = 'board';
  }
  renderPrefs();
  renderBoard();
  renderLayout();
}

// Board: results bar, grid, thumbnails, details

function renderResultsBar() {
  const el = $('#results-bar');
  const n = state.sorted.length;
  let count;
  if (state.view.kind === 'crns') {
    count = `<div class="rb-count"><span class="rb-label">${esc(state.view.label)}</span><button type="button" class="link-btn" data-bact="back">Back to all schedules</button></div>`;
  } else if (!state.plan.courses.length) {
    count = `<div class="rb-count"><span class="muted">Add courses to see schedules</span></div>`;
  } else if (state.generating && !n) {
    count = `<div class="rb-count"><span class="muted">Building schedules…</span></div>`;
  } else if (!state.total) {
    count = `<div class="rb-count"><strong>No schedules fit</strong></div>`;
  } else {
    const plus = state.stopped ? '+' : '';
    count = `<div class="rb-count"><strong>${fmtNum(state.total)}${plus}</strong> <span>schedule${state.total === 1 ? '' : 's'}</span>${state.generating ? '<span class="spinner" aria-label="Updating"></span>' : ''}</div>`;
  }
  const nav =
    state.view.kind === 'results' && n
      ? `<div class="rb-nav">
        <button type="button" class="icon-btn" data-bact="prev" aria-label="Previous schedule"${state.index === 0 ? ' disabled' : ''}>${icons.left}</button>
        <span class="rb-pos" aria-live="polite">${fmtNum(state.index + 1)} of ${fmtNum(n)}</span>
        <button type="button" class="icon-btn" data-bact="next" aria-label="Next schedule"${state.index >= n - 1 ? ' disabled' : ''}>${icons.right}</button>
      </div>`
      : '';
  const overlayOpts = state.saved
    .map((s) => `<option value="${esc(s.id)}"${state.overlay?.id === s.id ? ' selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  el.innerHTML = `
    ${count}
    ${nav}
    <div class="rb-tools">
      <label class="rb-sort"><span>Sort</span><select data-bact="sort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${state.plan.sort === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <div class="rb-compare">
        <label class="rb-overlay" title="Compare with a saved or shared schedule"><span>${icons.layers}<span class="sr-only">Compare with</span></span><select data-bact="overlay"><option value="">Compare with…</option>${overlayOpts}</select></label>
        <label class="check rb-sbs${state.overlay ? '' : ' is-disabled'}" title="${state.overlay ? 'Show both schedules next to each other instead of as outlines' : 'Pick a schedule to compare with first'}"><input type="checkbox" data-bact="sbs"${state.sideBySide ? ' checked' : ''}${state.overlay ? '' : ' disabled'}> Side by side</label>
      </div>
    </div>`;
}

function renderPaintBar() {
  const el = $('#paint-bar');
  el.hidden = !state.painting;
  el.innerHTML = state.painting
    ? `<p>${icons.brush}<span>Drag across the calendar to block off time. Drag over a break to erase it.</span></p><button type="button" class="btn primary" data-paint="done">Done</button>`
    : '';
}

function openSection(crn) {
  const sec = db.byCrn.get(crn);
  if (!sec) return;
  const key = `${sec.subj} ${sec.num}`;
  openCourseModal($('#course-modal'), key, { color: courseOf(key)?.color ?? 0, focusName: primary(sec), focusCrn: crn });
}

function compareTable(names, metrics) {
  const rows = [
    ['Credits', (m) => m.credits],
    ['Days on campus', (m) => m.days],
    ['First class', (m) => (m.start != null ? fmtTime(m.start) : '–')],
    ['Last class ends', (m) => (m.end != null ? fmtTime(m.end) : '–')],
    ['Time between classes', (m) => fmtDuration(m.gaps)],
    ['Professor rating', (m) => (m.rating != null ? m.rating.toFixed(2) : '–')],
    ['Average GPA', (m) => (m.gpa != null ? m.gpa.toFixed(2) : '–')],
  ];
  return `<div class="table-scroll"><table class="cmp-table"><thead><tr><th></th>${names.map((n) => `<th>${esc(n)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([k, f]) => `<tr><th>${k}</th>${metrics.map((m) => `<td>${m ? f(m) : '–'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function drawGrid(entries) {
  renderPaintBar();
  const other = state.overlay ? entriesForCrns(state.overlay.crns) : [];
  if (state.overlay && state.sideBySide && !state.painting) {
    const el = $('#week-grid');
    const label = state.view.kind === 'crns' ? state.view.label : entries[0]?.muted ? 'Current plan' : 'Current schedule';
    const mine = state.view.kind === 'results' && !entries[0]?.muted ? state.sorted[state.index]?.m : metricsFor(entries);
    el.innerHTML = `<div class="sbs">
      ${compareTable([label, state.overlay.name], [mine, metricsFor(other)])}
      <div class="cmp-grids"><div><h4>${esc(label)}</h4><div class="cmp-grid" data-side="a"></div></div><div><h4>${esc(state.overlay.name)}</h4><div class="cmp-grid" data-side="b"></div></div></div>
    </div>`;
    const shared = {
      breaks: state.plan.prefs.breaks,
      limits: { earliest: state.plan.prefs.earliest, latest: state.plan.prefs.latest, daysOff: state.plan.prefs.daysOff },
      days: termDays().slice(0, 5),
      termRange,
      onBlock: openSection,
    };
    renderGrid(el.querySelector('[data-side="a"]'), { ...shared, entries, rangeFrom: other, warnings: tightWarnings(entries) });
    renderGrid(el.querySelector('[data-side="b"]'), { ...shared, entries: other, rangeFrom: entries, warnings: tightWarnings(other) });
    return;
  }
  const ghost = other.map((e) => ({ ...e, label: state.overlay.name }));
  renderGrid($('#week-grid'), {
    entries,
    ghost,
    breaks: state.plan.prefs.breaks,
    limits: { earliest: state.plan.prefs.earliest, latest: state.plan.prefs.latest, daysOff: state.plan.prefs.daysOff },
    days: termDays().slice(0, 5),
    painting: state.painting,
    termRange,
    warnings: tightWarnings(entries),
    onBlock: openSection,
    onPaint: (breaks) => {
      state.plan.prefs.breaks = mergeBreaks(breaks);
      state.view = { kind: 'results' };
      renderPrefs();
      renderCourses();
      renderBoard();
      changed();
    },
  });
}

function renderBoard() {
  renderResultsBar();
  const entries = currentEntries();
  drawGrid(entries);
  renderUntimed(entries);
  renderDiag();
  renderDetail(entries);
  renderThumbs(true);
}

function renderUntimed(entries) {
  const el = $('#untimed');
  const list = entries.filter((e) => !isTimed(e.sec));
  el.hidden = !list.length;
  el.innerHTML = list.length
    ? `<span class="muted">No set meeting time:</span> ${list.map((e) => `<button type="button" class="untimed-chip c${e.color}${e.muted ? ' is-muted' : ''}" data-crn="${esc(e.sec.crn)}" title="Section details"><span class="swatch"></span>${esc(e.sec.subj)} ${esc(e.sec.num)} ${esc(e.sec.seq)}</button>`).join('')}`
    : '';
}

function renderDiag() {
  const el = $('#diag');
  const show = state.view.kind === 'results' && state.plan.courses.length && !state.total && !state.generating && state.job;
  el.hidden = !show;
  if (!show) return;
  const items = [];
  const prefs = state.plan.prefs;
  for (const c of state.plan.courses) {
    if (c.optional || state.fit?.[c.key]?.bundles) continue;
    const course = db.courses.get(c.key);
    const lt = lockedTypesOf(c, course.sections);
    const counts = {};
    for (const s of course.sections) {
      const r = sectionReason(s, c, prefs, lt);
      if (r) counts[r] = (counts[r] || 0) + 1;
    }
    const why = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${n} ${n === 1 ? REASONS[r].toLowerCase() : REASONS_PLURAL[r]}`)
      .join(', ');
    const linked = course.sections.some((s) => s.linked) && !why ? ' Its linked lecture and lab/recitation sections never line up.' : '';
    items.push(`<li><strong>${esc(c.key)}</strong>: none of its ${course.sections.length} sections can be used${why ? ` (${esc(why)})` : ''}.${linked}</li>`);
  }
  for (const [a, b] of state.diag?.pairs || []) items.push(`<li><strong>${esc(a)}</strong> and <strong>${esc(b)}</strong> overlap in every combination left.</li>`);
  if (!items.length) items.push('<li>Every pair of courses can fit, but your classes-per-day limit, credit range, or a three-way overlap rules out each full combination.</li>');
  el.innerHTML = `<h3>${icons.warn} Why nothing fits</h3><ul>${items.join('')}</ul><p class="muted small">Unlock a section, turn sections back on, or loosen a preference to get schedules back.</p>`;
}

function metricRow(m) {
  if (!m) return '';
  const cells = [
    ['Days on campus', m.days || '0'],
    ['First class', m.start != null ? fmtTime(m.start) : '–'],
    ['Last class ends', m.end != null ? fmtTime(m.end) : '–'],
    ['Time between classes', fmtDuration(m.gaps)],
    ['Professor rating', m.rating != null ? `<span class="pill ${ratingClass(m.rating)}">${m.rating.toFixed(2)}</span>${m.rated < m.ratable ? `<span class="coverage">${m.rated} of ${m.ratable} rated</span>` : ''}` : '–'],
    ['Average GPA', m.gpa != null ? `<span class="pill ${gpaClass(m.gpa)}">${m.gpa.toFixed(2)}</span>` : '–'],
    ['Credits', m.credits],
  ];
  return `<dl class="metrics">${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>
    ${m.tight ? `<p class="tight-note">${icons.warn} ${m.tight === 1 ? 'One class starts' : `${m.tight} classes start`} less than 15 minutes after a class in another building.</p>` : ''}`;
}

function detailTable(entries) {
  return `<div class="table-scroll">
    <table class="detail-table">
      <thead><tr><th>Course</th><th>Section</th><th>CRN</th><th>When</th><th>Where</th><th>Instructor</th><th>Seats</th></tr></thead>
      <tbody>${entries
        .map(({ sec, color, muted, clash, issue }) => {
          const p = rmpFor(primary(sec));
          return `<tr class="c${color}${muted ? ' is-muted' : ''}">
          <td><span class="swatch"></span><strong>${esc(sec.subj)} ${esc(sec.num)}</strong>${clash ? ` <span class="clash-tag">${icons.warn}${esc(issue || 'Conflict')}</span>` : ''}<span class="small muted block">${esc(sec.title)}</span></td>
          <td>${esc(sec.seq)}</td>
          <td><button type="button" class="crn-btn" data-crn="${esc(sec.crn)}" title="Copy CRN">${esc(sec.crn)}${icons.copy}</button></td>
          <td>${esc(meetingText(sec))}</td>
          <td>${esc(whereText(sec))}</td>
          <td>${esc(primary(sec))}${p ? ` <span class="pill sm ${ratingClass(p.r)}">${p.r.toFixed(1)}</span>` : ''}</td>
          <td class="${sec.seats != null && sec.seats <= 0 ? 'is-full' : ''}">${esc(seatsText(sec)) || '–'}</td>
        </tr>`;
        })
        .join('')}</tbody>
    </table>
    </div>`;
}

function renderDetail(entries) {
  const el = $('#schedule-detail');
  if (!entries.length) {
    el.innerHTML = '';
    return;
  }
  if (entries[0].muted) {
    el.innerHTML = detailTable(entries);
    return;
  }
  const m = state.view.kind === 'results' ? state.sorted[state.index]?.m : metricsFor(entries);
  const isSaved = state.saved.some((s) => sigOf(entriesForCrns(s.crns)) === sigOf(entries));
  el.innerHTML = `
    ${metricRow(m)}
    <div class="actions">
      <button type="button" class="btn primary" data-dact="copy">${icons.copy}<span>Copy CRNs</span></button>
      <button type="button" class="btn${isSaved ? ' is-on' : ''}" data-dact="save">${icons.star}<span>${isSaved ? 'Saved' : 'Save'}</span></button>
      <button type="button" class="btn" data-dact="share">${icons.link}<span>Share link</span></button>
      <button type="button" class="btn" data-dact="ics">${icons.cal}<span>Add to calendar</span></button>
      <button type="button" class="btn" data-dact="lockall" title="Lock every section here so you can swap just one">${icons.lock}<span>Lock these sections</span></button>
      <button type="button" class="btn" data-dact="print">${icons.print}<span>Print</span></button>
    </div>
    ${detailTable(entries)}`;
}

/** A clean one-page version of the schedule on screen, used only when printing */
function buildPrintSheet() {
  const el = $('#print-sheet');
  const entries = currentEntries();
  if (!entries.length) {
    el.innerHTML = '<p class="ps-empty">Add courses and pick a schedule to print it.</p>';
    return;
  }
  const m = state.view.kind === 'results' && !entries[0].muted ? state.sorted[state.index]?.m : metricsFor(entries);
  const title = state.view.kind === 'crns' ? state.view.label : `${db.term.desc} schedule`;
  const crns = entries.map((e) => e.sec.crn);
  const span = m?.start != null ? `, ${fmtTime(m.start)} to ${fmtTime(m.end)}` : '';
  const facts = m ? `${m.credits} credit${m.credits === 1 ? '' : 's'}, ${m.days} day${m.days === 1 ? '' : 's'} on campus${span}` : '';
  // The term is already in the default title; saved schedules have their own name, so add it there
  const summary = state.view.kind === 'crns' ? [db.term.desc, facts].filter(Boolean).join(', ') : facts;
  const updated = db.term.updated ? new Date(db.term.updated).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const printed = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  el.innerHTML = `
    <header class="ps-head">
      <div>
        <p class="ps-brand"><img src="icons/icon-48.png" alt="" width="16" height="16">Niner Scheduler</p>
        <h1>${esc(title)}</h1>
        <p class="ps-sub">${esc(summary)}</p>
      </div>
      <div class="ps-crns">
        <p>CRNs for Banner</p>
        <ol>${crns.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
      </div>
    </header>
    <div class="ps-grid"></div>
    <table class="ps-table">
      <thead><tr><th>Course</th><th>Title</th><th>Section</th><th>CRN</th><th>When</th><th>Where</th><th>Instructor</th><th>Credits</th></tr></thead>
      <tbody>${entries
        .map(
          ({ sec, color }) => `<tr class="c${color}">
            <td><span class="swatch"></span><strong>${esc(sec.subj)} ${esc(sec.num)}</strong></td>
            <td>${esc(sec.title)}</td>
            <td>${esc(sec.seq)}</td>
            <td class="ps-crn">${esc(sec.crn)}</td>
            <td>${esc(meetingText(sec))}</td>
            <td>${esc(locationText(sec))}</td>
            <td>${esc(sec.inst.join(', ') || 'Staff')}</td>
            <td>${sec.cr || 0}</td>
          </tr>`,
        )
        .join('')}</tbody>
    </table>
    <footer class="ps-foot">
      <span>${updated ? `Seat counts as of ${esc(updated)}. ` : ''}</span>
      <span>Printed ${esc(printed)}</span>
    </footer>`;
  renderGrid(el.querySelector('.ps-grid'), { entries, days: termDays().slice(0, 5), termRange });
}

const THUMB_BATCH = 60;
let thumbObserver = null;

function thumbNote(m) {
  switch (state.plan.sort) {
    case 'late':
      return m.start != null ? `starts ${fmtTime(m.start)}` : 'online';
    case 'early':
      return m.end != null ? `done ${fmtTime(m.end)}` : 'online';
    case 'gaps':
      return `${fmtDuration(m.gaps)} gaps`;
    case 'rating':
      return m.rating != null ? `rating ${m.rating.toFixed(1)}` : 'no ratings';
    case 'gpa':
      return m.gpa != null ? `GPA ${m.gpa.toFixed(2)}` : 'no GPA';
    default:
      return `${m.days} day${m.days === 1 ? '' : 's'}${m.start != null ? `, ${fmtTime(m.start)}` : ''}`;
  }
}

function renderThumbs(reset) {
  const el = $('#thumbs');
  const show = state.view.kind === 'results' && state.sorted.length > 1;
  el.hidden = !show;
  if (!show) {
    el.innerHTML = '';
    return;
  }
  if (reset || !state.shownThumbs) {
    el.innerHTML = state.trimmed
      ? `<p class="thumbs-note small muted">Showing the best ${fmtNum(state.keep)} for each sort out of ${fmtNum(state.total)}${state.stopped ? '+' : ''}. Lock sections or add breaks to narrow it down.</p>`
      : '';
    state.shownThumbs = 0;
  }
  const end = Math.min(state.sorted.length, Math.max(state.shownThumbs + THUMB_BATCH, state.index + 1));
  let html = '';
  for (let i = state.shownThumbs; i < end; i++) {
    const r = state.sorted[i];
    html += `<button type="button" class="thumb${i === state.index ? ' is-current' : ''}" data-i="${i}" aria-label="Schedule ${i + 1}: ${esc(thumbNote(r.m))}" aria-current="${i === state.index}">
      ${thumbSvg(entriesForPick(r))}
      <span class="thumb-cap"><span class="thumb-n">${i + 1}</span>${esc(thumbNote(r.m))}</span>
    </button>`;
  }
  el.querySelector('.thumb-more')?.remove();
  el.insertAdjacentHTML('beforeend', html);
  state.shownThumbs = end;
  if (end < state.sorted.length) {
    el.insertAdjacentHTML('beforeend', '<div class="thumb-more" aria-hidden="true"></div>');
    thumbObserver?.disconnect();
    thumbObserver = new IntersectionObserver((ents) => {
      if (ents.some((x) => x.isIntersecting)) renderThumbs(false);
    }, { root: el, rootMargin: '400px' });
    thumbObserver.observe(el.querySelector('.thumb-more'));
  }
}

function goTo(i) {
  if (!state.sorted.length) return;
  state.index = Math.max(0, Math.min(state.sorted.length - 1, i));
  state.view = { kind: 'results' };
  const thumbs = $('#thumbs');
  if (state.index >= state.shownThumbs) renderThumbs(false);
  $$('.thumb', thumbs).forEach((t) => {
    const cur = Number(t.dataset.i) === state.index;
    t.classList.toggle('is-current', cur);
    t.setAttribute('aria-current', String(cur));
    if (cur) t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
  const entries = currentEntries();
  renderResultsBar();
  drawGrid(entries);
  renderUntimed(entries);
  renderDetail(entries);
}

function initBoardEvents() {
  $('#results-bar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-bact]');
    if (!b) return;
    const act = b.dataset.bact;
    if (act === 'prev') goTo(state.index - 1);
    else if (act === 'next') goTo(state.index + 1);
    else if (act === 'back') {
      state.view = { kind: 'results' };
      $('#share-banner').hidden = true;
      renderBoard();
    }
  });
  $('#results-bar').addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.bact === 'sort') {
      state.plan.sort = t.value;
      persist();
      sortResults(null);
      renderBoard();
    } else if (t.dataset.bact === 'sbs') {
      state.sideBySide = t.checked;
      store.set('ns:sideBySide', state.sideBySide);
      renderBoard();
    } else if (t.dataset.bact === 'overlay') {
      const s = state.saved.find((x) => x.id === t.value);
      state.overlay = s ? { id: s.id, name: s.name, crns: s.crns } : null;
      renderBoard();
    }
  });
  $('#untimed').addEventListener('click', (e) => {
    const b = e.target.closest('[data-crn]');
    if (b) openSection(b.dataset.crn);
  });
  $('#paint-bar').addEventListener('click', (e) => {
    if (e.target.closest('[data-paint="done"]')) setPainting(false);
  });
  $('#thumbs').addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (t) goTo(Number(t.dataset.i));
  });
  $('#schedule-detail').addEventListener('click', async (e) => {
    const crnBtn = e.target.closest('.crn-btn');
    if (crnBtn) {
      if (await copyText(crnBtn.dataset.crn)) toast(`Copied CRN ${crnBtn.dataset.crn}`);
      return;
    }
    const b = e.target.closest('[data-dact]');
    if (!b) return;
    const entries = currentEntries();
    const crns = entries.map((x) => x.sec.crn);
    const act = b.dataset.dact;
    if (act === 'copy') {
      if (await copyText(crns.join(', '))) toast(`Copied ${crns.length} CRNs`);
    } else if (act === 'save') saveSchedule(crns);
    else if (act === 'share') {
      const url = shareUrl(crns, state.view.kind === 'crns' ? state.view.label : '');
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        navigator.share({ title: 'My class schedule', url }).catch(() => {});
      } else if (await copyText(url)) toast('Share link copied');
    } else if (act === 'ics') {
      download(`schedule-${state.term}.ics`, buildICS(entries.map((x) => x.sec), db.term.desc), 'text/calendar;charset=utf-8');
      toast('Calendar file downloaded');
    } else if (act === 'lockall') {
      for (const { sec, key } of entries) {
        let c = courseOf(key);
        if (!c) {
          c = { key, optional: false, locked: [], excluded: [], color: nextColor() };
          state.plan.courses.push(c);
        }
        if (!c.locked.includes(sec.crn)) {
          c.locked = c.locked.filter((x) => db.byCrn.get(x)?.type !== sec.type);
          c.locked.push(sec.crn);
        }
      }
      state.view = { kind: 'results' };
      toast('Locked. Unlock any one section to see alternatives for it.');
      renderCourses();
      changed();
    } else if (act === 'print') {
      buildPrintSheet();
      window.print();
    }
  });
}

// Saved schedules, sharing and comparing

function saveSchedule(crns, name) {
  const sig = [...crns].sort().join('.');
  const existing = state.saved.find((s) => [...s.crns].sort().join('.') === sig);
  if (existing) {
    toast(`Already saved as “${existing.name}”`);
    return existing;
  }
  const item = { id: Math.random().toString(36).slice(2, 9), name: name || `Schedule ${state.saved.length + 1}`, crns: [...crns], created: new Date().toISOString() };
  state.saved.push(item);
  persist();
  toast(`Saved as “${item.name}”`);
  renderDetail(currentEntries());
  renderResultsBar();
  renderSaved();
  renderTabs();
  return item;
}

function shareUrl(crns, name = '') {
  const u = new URL(location.href);
  u.hash = `s=${encodeURIComponent(state.term)}~${crns.join('.')}${name ? `~${encodeURIComponent(name)}` : ''}`;
  return u.toString();
}

function parseShare(text) {
  const m = String(text).match(/[#&]s=([^~\s]+)~([\d.]+)(?:~([^\s&]*))?/);
  if (!m) return null;
  return { term: decodeURIComponent(m[1]), crns: m[2].split('.').filter(Boolean), name: m[3] ? decodeURIComponent(m[3]) : '' };
}

function renderSaved() {
  const el = $('#saved-view');
  const items = state.saved;
  const friend = `<form class="friend-form" data-sv="friend">
      <label for="friend-link">Add a friend's schedule</label>
      <div class="friend-row"><input id="friend-link" type="url" placeholder="Paste their share link" autocomplete="off"><button class="btn" type="submit">Add</button></div>
      <p class="small muted">Then pick it under “Compare with…” to see their classes on your calendar, or tick “Side by side” to see both schedules next to each other.</p>
    </form>`;
  if (!items.length) {
    el.innerHTML = `<div class="empty-saved"><p><strong>No saved schedules for ${esc(db.term.desc)} yet.</strong></p><p class="muted">Press Save under any schedule to keep it here. Saved schedules stay in this browser.</p></div>${friend}`;
    return;
  }
  el.innerHTML = `
    <ul class="saved-list">
      ${items
        .map((s) => {
          const entries = entriesForCrns(s.crns);
          const missing = s.crns.length - entries.length;
          const m = metricsFor(entries);
          return `<li class="saved-item" data-id="${esc(s.id)}">
            <button type="button" class="saved-thumb" data-sv="open" aria-label="Open ${esc(s.name)}">${thumbSvg(entries)}</button>
            <div class="saved-main">
              <input class="saved-name" data-sv="rename" value="${esc(s.name)}" aria-label="Schedule name">
              <p class="small muted">${m ? `${m.credits} credits, ${m.days} days${m.start != null ? `, ${fmtTime(m.start)}–${fmtTime(m.end)}` : ''}` : ''}${missing ? `<span class="warn-text"> ${missing} section${missing === 1 ? ' is' : 's are'} no longer offered</span>` : ''}</p>
              <p class="small crns">${s.crns.map(esc).join(', ')}</p>
              <div class="saved-actions">
                <button type="button" class="link-btn" data-sv="open">Open</button>
                <button type="button" class="link-btn" data-sv="overlay">Compare</button>
                <button type="button" class="link-btn" data-sv="share">Share</button>
                <button type="button" class="link-btn danger" data-sv="delete">Delete</button>
              </div>
            </div>
          </li>`;
        })
        .join('')}
    </ul>
    ${friend}`;
}

function initSavedEvents() {
  const el = $('#saved-view');
  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sv]');
    if (!b || b.tagName === 'INPUT' || b.tagName === 'FORM') return;
    const id = b.closest('.saved-item')?.dataset.id;
    const s = state.saved.find((x) => x.id === id);
    if (!s) return;
    const act = b.dataset.sv;
    if (act === 'open') {
      state.view = { kind: 'crns', crns: s.crns, label: s.name };
      state.tab = 'schedules';
      state.mobile = 'board';
      renderLayout();
      renderBoard();
    } else if (act === 'overlay') {
      state.overlay = { id: s.id, name: s.name, crns: s.crns };
      state.tab = 'schedules';
      state.mobile = 'board';
      renderLayout();
      renderBoard();
      toast(`Comparing with “${s.name}”`);
    } else if (act === 'share') {
      if (await copyText(shareUrl(s.crns, s.name))) toast('Share link copied');
    } else if (act === 'delete') {
      state.saved = state.saved.filter((x) => x.id !== id);
      if (state.overlay?.id === id) state.overlay = null;
      persist();
      renderSaved();
      renderTabs();
      renderBoard();
      toast(`Deleted “${s.name}”`);
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target;
    const id = t.closest('.saved-item')?.dataset.id;
    const s = state.saved.find((x) => x.id === id);
    if (!s) return;
    if (t.dataset.sv === 'rename') {
      s.name = t.value.trim() || s.name;
      persist();
      renderResultsBar();
    }
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#friend-link');
    const share = parseShare(input.value);
    if (!share) {
      toast('That doesn’t look like a Niner Scheduler share link.');
      return;
    }
    if (share.term !== state.term) {
      toast(`That schedule is for a different term (${share.term}).`);
      return;
    }
    saveSchedule(share.crns, share.name || "Friend's schedule");
    input.value = '';
  });
}

function renderShareBanner() {
  const el = $('#share-banner');
  const v = state.view;
  if (v.kind !== 'crns' || v.source !== 'shared') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<p>You're viewing a shared schedule${v.label && v.label !== 'Shared schedule' ? `: <strong>${esc(v.label)}</strong>` : ''}.</p>
    <div class="banner-actions">
      <button type="button" class="btn primary" data-share="save">Save it</button>
      <button type="button" class="btn" data-share="plan">Add these courses to my plan</button>
      <button type="button" class="btn" data-share="dismiss">Close</button>
    </div>`;
}

function initShareEvents() {
  $('#share-banner').addEventListener('click', (e) => {
    const b = e.target.closest('[data-share]');
    if (!b) return;
    const v = state.view;
    if (b.dataset.share === 'save') {
      const item = saveSchedule(v.crns, v.label && v.label !== 'Shared schedule' ? v.label : "Friend's schedule");
      state.overlay = { id: item.id, name: item.name, crns: item.crns };
    } else if (b.dataset.share === 'plan') {
      for (const crn of v.crns) {
        const sec = db.byCrn.get(crn);
        if (!sec) continue;
        const key = `${sec.subj} ${sec.num}`;
        let c = courseOf(key);
        if (!c) {
          c = { key, optional: false, locked: [], excluded: [], color: nextColor() };
          state.plan.courses.push(c);
          loadGrades(sec.subj);
        }
        c.locked = c.locked.filter((x) => db.byCrn.get(x)?.type !== sec.type);
        c.locked.push(crn);
      }
      toast('Added and locked those sections');
      renderCourses();
      changed();
    }
    state.view = { kind: 'results' };
    history.replaceState(null, '', location.pathname + location.search);
    renderShareBanner();
    renderBoard();
  });
}

// Layout, tabs, theme, term

function renderTabs() {
  $$('[data-tab]').forEach((b) => {
    const on = b.dataset.tab === state.tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  });
  const savedTab = $('[data-tab="saved"]');
  savedTab.innerHTML = `Saved${state.saved.length ? ` <span class="count">${state.saved.length}</span>` : ''}`;
  $('#schedules-view').hidden = state.tab !== 'schedules';
  $('#saved-view').hidden = state.tab !== 'saved';
}

function renderLayout() {
  $('#layout').dataset.mobile = state.mobile;
  $$('[data-mob]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.mob === (state.mobile === 'plan' ? 'plan' : state.tab))));
  renderTabs();
}

function initLayoutEvents() {
  $$('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      if (state.tab === 'saved') renderSaved();
      renderLayout();
    }),
  );
  $$('[data-mob]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.mob;
      if (v === 'plan') state.mobile = 'plan';
      else {
        state.mobile = 'board';
        state.tab = v;
        if (v === 'saved') renderSaved();
      }
      renderLayout();
      window.scrollTo({ top: 0 });
    }),
  );
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowRight' && state.tab === 'schedules') goTo(state.index + 1);
    else if (e.key === 'ArrowLeft' && state.tab === 'schedules') goTo(state.index - 1);
    else if (e.key === 'Escape' && state.painting) setPainting(false);
  });
  $('#course-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.close();
  });
  $('#help-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.closest('[data-close]')) e.currentTarget.close();
  });
  $('#help-btn').addEventListener('click', () => $('#help-modal').showModal());
  $$('[data-open-help]').forEach((b) => b.addEventListener('click', () => $('#help-modal').showModal()));
}

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Match system', light: 'Light', dark: 'Dark' };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = t;
  const btn = $('#theme-btn');
  btn.title = `Theme: ${THEME_LABEL[t]}`;
  btn.setAttribute('aria-label', `Theme: ${THEME_LABEL[t]}. Change theme`);
}
function initTheme() {
  let t = store.get('ns:theme', 'auto');
  if (!THEMES.includes(t)) t = 'auto';
  applyTheme(t);
  $('#theme-btn').addEventListener('click', () => {
    t = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    store.set('ns:theme', t);
    applyTheme(t);
    toast(`Theme: ${THEME_LABEL[t]}`);
  });
}

function renderTermSelect() {
  const sel = $('#term-select');
  sel.innerHTML = db.terms.map((t) => `<option value="${esc(t.code)}"${t.code === state.term ? ' selected' : ''}>${esc(t.desc)}</option>`).join('');
}

function renderFreshness() {
  const el = $('#freshness');
  const t = db.term;
  el.textContent = t.updated ? `Seats updated ${timeAgo(t.updated)}` : '';
  el.title = t.updated ? new Date(t.updated).toLocaleString() : '';
}

async function switchTerm(code) {
  if (state.term) persist();
  state.term = code;
  store.set('ns:lastTerm', code);
  $('#board').setAttribute('aria-busy', 'true');
  await loadTerm(code);
  computeTermRange();
  restore();
  await Promise.all([...new Set(state.plan.courses.map((c) => c.key.split(' ')[0]))].map(loadGrades));
  $('#board').removeAttribute('aria-busy');
  renderTermSelect();
  renderFreshness();
  renderCourses();
  renderPrefs();
  renderLayout();
  renderBoard();
  renderSaved();
  regenerate();
}

async function init() {
  initTheme();
  initLayoutEvents();
  initSearch();
  initCourseEvents();
  initPrefEvents();
  initBoardEvents();
  initSavedEvents();
  initShareEvents();
  $('#term-select').addEventListener('change', (e) => switchTerm(e.target.value));
  // Ctrl/Cmd+P prints the same clean sheet as the Print button
  window.addEventListener('beforeprint', () => {
    if (db.term) buildPrintSheet();
  });

  try {
    await loadTerms();
  } catch (err) {
    $('#layout').innerHTML = `<div class="fatal"><h2>Course data isn't published yet</h2><p>This site reads <code>data/terms.json</code>, which the “Update course data” GitHub Action creates. Run that workflow once (Actions tab → Update course data → Run workflow), or run <code>npm run scrape</code> locally.</p><p class="muted small">${esc(err.message)}</p></div>`;
    return;
  }
  if (!db.terms.length) {
    $('#layout').innerHTML = '<div class="fatal"><h2>No terms available</h2><p>The data refresh hasn’t found any terms open for registration yet.</p></div>';
    return;
  }
  const share = parseShare(location.hash);
  const last = store.get('ns:lastTerm', null);
  const pickTerm =
    (share && db.terms.find((t) => t.code === share.term)?.code) ||
    (last && db.terms.find((t) => t.code === last)?.code) ||
    db.terms[0].code;

  await Promise.all([loadRmp(), switchTerm(pickTerm)]);
  if (share && share.term === state.term) {
    state.view = { kind: 'crns', crns: share.crns, label: share.name || 'Shared schedule', source: 'shared' };
    state.tab = 'schedules';
    state.mobile = 'board';
    renderLayout();
  } else if (share) {
    toast('That shared schedule is for a term that is no longer listed.');
  }
  renderShareBanner();
  renderCourses();
  renderBoard();
  regenerate();
}

init();

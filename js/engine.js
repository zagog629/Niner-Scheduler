// Schedule engine: filtering, linked-section bundles, conflict checks, generation and scoring
// Pure functions only, so it runs both in the Web Worker and on the main thread

export const DAY_LETTERS = 'MTWRFSU';
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const REASONS = {
  locked: 'Another section is locked',
  excluded: 'Turned off',
  full: 'Full',
  campus: 'Campus filtered out',
  method: 'Format filtered out',
  dayoff: 'Meets on a day off',
  early: 'Starts too early',
  late: 'Ends too late',
  break: 'Overlaps a break',
};

// Same reasons, phrased for a count of several sections ("3 start too early")
export const REASONS_PLURAL = {
  locked: 'blocked by a locked section',
  excluded: 'turned off',
  full: 'full',
  campus: 'on a filtered-out campus',
  method: 'in a filtered-out format',
  dayoff: 'meet on a day off',
  early: 'start too early',
  late: 'end too late',
  break: 'overlap a break',
};

export function dayMask(letters) {
  let m = 0;
  for (const ch of letters || '') {
    const i = DAY_LETTERS.indexOf(ch);
    if (i >= 0) m |= 1 << i;
  }
  return m;
}

/** Meetings in engine form: days bitmask + minutes + ISO dates. Untimed (online/TBA) meetings are dropped */
export function meetingsOf(sec) {
  if (sec._m) return sec._m;
  const timed = (sec.mt || []).map((m, ri) => ({ m, ri })).filter(({ m }) => m.d && m.s != null && m.e != null);
  // Some sections list every class day as its own one-day meeting (ITIS 3246 alternates
  // in-person and online weeks), so a one-day meeting is only a one-off (an orientation
  // or final exam) when no other meeting shares its day and time and the section also
  // meets regularly
  const pattern = (m) => `${m.d}|${m.s}|${m.e}`;
  const count = new Map();
  for (const { m } of timed) count.set(pattern(m), (count.get(pattern(m)) || 0) + 1);
  const isOneOff = (m) => !!(m.sd && m.sd === m.ed) && count.get(pattern(m)) === 1;
  const meetsRegularly = timed.some(({ m }) => !isOneOff(m));
  const out = timed.map(({ m, ri }) => ({
    ri,
    days: dayMask(m.d),
    s: m.s,
    e: m.e,
    sd: m.sd || '0000-00-00',
    ed: m.ed || '9999-12-31',
    b: /no building needed/i.test(m.b || '') || m.bc === 'ONLINE' ? '' : m.b || m.bc || '',
    once: meetsRegularly && isOneOff(m),
  }));
  Object.defineProperty(sec, '_m', { value: out, enumerable: false });
  return out;
}

export function isTimed(sec) {
  return meetingsOf(sec).length > 0;
}

export function hasSeat(sec, waitlistOk) {
  if (sec.seats == null) return sec.open !== false;
  if (sec.seats > 0) return true;
  return !!waitlistOk && (sec.wcap || 0) > (sec.wcnt || 0);
}

function overlaps(a, b) {
  return (a.days & b.days) !== 0 && a.s < b.e && b.s < a.e && a.sd <= b.ed && b.sd <= a.ed;
}

export function meetingsConflict(ma, mb) {
  for (const a of ma) for (const b of mb) if (overlaps(a, b)) return true;
  return false;
}

/**
 * Why a section can't be used under the current plan, or null when it can
 * `course` = { locked: string[], excluded: string[] }, `lockedTypes` = Set of schedule types with a lock
 */
export function sectionReason(sec, course, prefs, lockedTypes) {
  if (course.locked.includes(sec.crn)) return null;
  if (lockedTypes && lockedTypes.has(sec.type)) return 'locked';
  if (course.excluded.includes(sec.crn)) return 'excluded';
  if (prefs.openOnly && !hasSeat(sec, prefs.waitlistOk)) return 'full';
  if (prefs.campusOff?.length && prefs.campusOff.includes(sec.campus)) return 'campus';
  if (prefs.methodOff?.length && prefs.methodOff.includes(sec.method)) return 'method';
  for (const m of meetingsOf(sec)) {
    if (m.once) continue;
    if (prefs.daysOff & m.days) return 'dayoff';
    if (prefs.earliest != null && m.s < prefs.earliest) return 'early';
    if (prefs.latest != null && m.e > prefs.latest) return 'late';
    for (const br of prefs.breaks || []) {
      if (m.days & (1 << br.d) && m.s < br.e && br.s < m.e) return 'break';
    }
  }
  return null;
}

/** Schedule types in a course that have a locked section */
export function lockedTypesOf(course, sections) {
  const set = new Set();
  for (const s of sections) if (course.locked.includes(s.crn)) set.add(s.type);
  return set;
}

/**
 * Every way to satisfy one course: unlinked sections stand alone; linked sections need one of each
 * schedule type (e.g. Lecture + Laboratory), restricted to Banner's link groups when we have them.
 */
export function buildBundles(sections, allowed, links = {}, cap = 6000) {
  const bundles = [];
  const ok = (s) => allowed.has(s.crn);
  for (const s of sections) if (!s.linked && ok(s)) bundles.push([s]);

  const linked = sections.filter((s) => s.linked);
  if (!linked.length) return bundles;

  const byType = new Map();
  for (const s of linked) {
    if (!byType.has(s.type)) byType.set(s.type, []);
    if (ok(s)) byType.get(s.type).push(s);
  }
  if (byType.size === 1) {
    for (const s of linked) if (ok(s)) bundles.push([s]);
    return bundles;
  }
  const groups = [...byType.values()].sort((a, b) => a.length - b.length);
  if (groups.some((g) => !g.length)) return bundles;

  const linkSet = new Map();
  const setFor = (crn) => {
    if (!linkSet.has(crn)) linkSet.set(crn, links[crn] ? new Set(links[crn].flat()) : null);
    return linkSet.get(crn);
  };
  const compatible = (a, b) => {
    const sa = setFor(a.crn);
    const sb = setFor(b.crn);
    if (!sa && !sb) return true;
    return (sa && sa.has(b.crn)) || (sb && sb.has(a.crn));
  };

  const pick = [];
  const walk = (gi) => {
    if (bundles.length >= cap) return;
    if (gi === groups.length) {
      bundles.push([...pick]);
      return;
    }
    for (const s of groups[gi]) {
      let fine = true;
      for (const p of pick) {
        if (!compatible(p, s) || meetingsConflict(meetingsOf(p), meetingsOf(s))) {
          fine = false;
          break;
        }
      }
      if (!fine) continue;
      pick.push(s);
      walk(gi + 1);
      pick.pop();
    }
  };
  walk(0);
  return bundles;
}

// Generation (runs in the worker)

/**
 * input = {
 *   courses: [{ key, optional, bundles: [{ secs: number[], cr: number }] }],
 *   secs: [{ m: meeting[], rating: number|null, gpa: number|null, seats: number|null, timed: bool }],
 *   prefs: { maxPerDay: number|null, minCredits, maxCredits },
 *   cap, countLimit, timeLimit
 * }
 */
export function generate(input) {
  const { courses, secs, prefs = {} } = input;
  const cap = input.cap ?? 20000;
  const countLimit = input.countLimit ?? 2_000_000;
  const deadline = Date.now() + (input.timeLimit ?? 6000);
  const minCr = prefs.minCredits ?? null;
  const maxCr = prefs.maxCredits ?? null;

  const B = courses.map((c) =>
    c.bundles.map((b) => {
      const m = [];
      for (const i of b.secs) m.push(...secs[i].m);
      return { m, cr: b.cr, secs: b.secs };
    }),
  );

  const idx = courses.map((_, i) => i);
  const order = idx.sort((a, b) => {
    const oa = courses[a].optional ? 1 : 0;
    const ob = courses[b].optional ? 1 : 0;
    return oa - ob || B[a].length - B[b].length;
  });

  // Best-case credits still available from each depth onward (for min-credit pruning)
  const maxCrFrom = new Array(order.length + 1).fill(0);
  for (let d = order.length - 1; d >= 0; d--) {
    const best = B[order[d]].reduce((mx, b) => Math.max(mx, b.cr), 0);
    maxCrFrom[d] = maxCrFrom[d + 1] + best;
  }

  // Lazily filled conflict tables per course pair: 0 unknown, 1 fine, 2 conflict
  const tables = new Map();
  const conflict = (ci, bi, cj, bj) => {
    if (ci > cj) [ci, bi, cj, bj] = [cj, bj, ci, bi];
    const key = ci * 1000 + cj;
    let t = tables.get(key);
    if (!t) {
      t = new Uint8Array(B[ci].length * B[cj].length);
      tables.set(key, t);
    }
    const k = bi * B[cj].length + bj;
    if (!t[k]) t[k] = meetingsConflict(B[ci][bi].m, B[cj][bj].m) ? 2 : 1;
    return t[k] === 2;
  };

  // Keep everything until `cap`; after that keep the best `keep` per sort so every sort stays exact
  let results = [];
  let heaps = null;
  const keep = input.keepPerSort ?? 2000;
  let total = 0;
  let nodes = 0;
  let stopped = null;
  const chosenC = [];
  const chosenB = [];
  const pick = new Array(courses.length).fill(-1);

  const leaf = (credits) => {
    if (!chosenC.length) return;
    if (minCr != null && credits < minCr) return;
    const metrics = measure(chosenC.map((c, i) => B[c][chosenB[i]]), secs, prefs);
    if (!metrics) return;
    metrics.credits = credits;
    metrics.score = balancedScore(metrics);
    total++;
    const item = { pick: pick.slice(), m: metrics };
    if (!heaps) {
      results.push(item);
      if (results.length > cap) {
        heaps = Object.keys(SORTS).map((s) => new TopK(comparator(s), keep, results));
        results = null;
      }
    } else {
      for (const h of heaps) h.offer(item);
    }
    if (total >= countLimit) stopped = 'count';
  };

  const walk = (depth, credits) => {
    if (stopped) return;
    if ((++nodes & 2047) === 0 && Date.now() > deadline) {
      stopped = 'time';
      return;
    }
    if (maxCr != null && credits > maxCr) return;
    if (minCr != null && credits + maxCrFrom[depth] < minCr) return;
    if (depth === order.length) {
      leaf(credits);
      return;
    }
    const ci = order[depth];
    const list = B[ci];
    for (let bi = 0; bi < list.length; bi++) {
      let clash = false;
      for (let k = 0; k < chosenC.length; k++) {
        if (conflict(chosenC[k], chosenB[k], ci, bi)) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      chosenC.push(ci);
      chosenB.push(bi);
      pick[ci] = bi;
      walk(depth + 1, credits + list[bi].cr);
      pick[ci] = -1;
      chosenC.pop();
      chosenB.pop();
      if (stopped) return;
    }
    if (courses[ci].optional) walk(depth + 1, credits);
  };
  walk(0, 0);

  let trimmed = false;
  if (heaps) {
    const set = new Set();
    for (const h of heaps) for (const it of h.items) set.add(it);
    results = [...set];
    trimmed = true;
  }
  let diag = null;
  if (!total && !stopped) diag = diagnose(courses, B, conflict);
  return { total, results, stopped, trimmed, keep, diag };
}

/** Bounded "best K" set: a binary heap whose root is the worst item kept */
class TopK {
  constructor(cmp, k, seed) {
    this.cmp = cmp; // negative when a is better than b
    this.k = k;
    this.items = [...seed].sort(cmp).slice(0, k);
    // Build a max-heap on "worse" by reversing into heap order
    this.items.reverse();
    for (let i = (this.items.length >> 1) - 1; i >= 0; i--) this.down(i);
  }
  worse(a, b) {
    return this.cmp(a, b) > 0;
  }
  offer(item) {
    const h = this.items;
    if (h.length < this.k) {
      h.push(item);
      this.up(h.length - 1);
    } else if (this.worse(h[0], item)) {
      h[0] = item;
      this.down(0);
    }
  }
  up(i) {
    const h = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.worse(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  down(i) {
    const h = this.items;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let w = i;
      if (l < h.length && this.worse(h[l], h[w])) w = l;
      if (r < h.length && this.worse(h[r], h[w])) w = r;
      if (w === i) break;
      [h[i], h[w]] = [h[w], h[i]];
      i = w;
    }
  }
}

/** When nothing fits, find which required courses can't coexist */
function diagnose(courses, B, conflict) {
  const empty = courses.map((c, i) => (!c.optional && !B[i].length ? c.key : null)).filter(Boolean);
  if (empty.length) return { empty };
  const pairs = [];
  const req = courses.map((c, i) => i).filter((i) => !courses[i].optional);
  for (let a = 0; a < req.length; a++) {
    for (let b = a + 1; b < req.length; b++) {
      const i = req[a];
      const j = req[b];
      let any = false;
      outer: for (let x = 0; x < B[i].length; x++) {
        for (let y = 0; y < B[j].length; y++) {
          if (!conflict(i, x, j, y)) {
            any = true;
            break outer;
          }
        }
      }
      if (!any) pairs.push([courses[i].key, courses[j].key]);
    }
  }
  return { pairs };
}

/** Metrics for one candidate schedule, or null when it breaks a whole-schedule rule */
export function measure(bundles, secs, prefs = {}) {
  const perDay = [[], [], [], [], [], [], []];
  let rSum = 0;
  let rN = 0;
  let gSum = 0;
  let gN = 0;
  let seats = null;
  let online = 0;
  let ratable = 0;
  for (const b of bundles) {
    for (const si of b.secs) {
      const s = secs[si];
      if (s.main !== false) ratable++;
      if (s.rating != null && s.main !== false) {
        rSum += s.rating;
        rN++;
      }
      if (s.gpa != null) {
        gSum += s.gpa;
        gN++;
      }
      if (s.seats != null) seats = seats == null ? s.seats : Math.min(seats, s.seats);
      if (!s.timed) online++;
    }
    for (const m of b.m) {
      if (m.once) continue;
      for (let d = 0; d < 7; d++) if (m.days & (1 << d)) perDay[d].push(m);
    }
  }

  let days = 0;
  let start = Infinity;
  let end = -Infinity;
  let startSum = 0;
  let gaps = 0;
  let tight = 0;
  let maxDay = 0;
  let early = 0;
  let late = 0;
  for (let d = 0; d < 7; d++) {
    const list = perDay[d];
    if (!list.length) continue;
    list.sort((a, b) => a.s - b.s || a.e - b.e);
    days++;
    // Distinct time blocks per day (partial-term meetings at the same time count once)
    let blocks = 0;
    let prevE = -1;
    let prevB = '';
    for (const m of list) {
      if (m.s >= prevE) {
        if (prevE >= 0) {
          const g = m.s - prevE;
          if (g > 15) gaps += g;
          else if (g < 15 && prevB && m.b && prevB !== m.b) tight++;
        }
        blocks++;
      }
      if (m.e > prevE) {
        prevE = m.e;
        prevB = m.b;
      }
    }
    maxDay = Math.max(maxDay, blocks);
    const first = list[0].s;
    start = Math.min(start, first);
    end = Math.max(end, prevE);
    startSum += first;
    early += Math.max(0, 600 - first);
    late += Math.max(0, prevE - 1080);
  }
  if (prefs.maxPerDay && maxDay > prefs.maxPerDay) return null;

  const rating = rN ? rSum / rN : null;
  // For ranking, an unrated professor counts as an average 3.0 so one known rating can't dominate
  const ratingAdj = rN ? (rSum + 3 * (ratable - rN)) / ratable : null;
  const gpa = gN ? gSum / gN : null;
  return {
    rated: rN,
    ratable,
    ratingAdj,
    days,
    start: days ? start : null,
    end: days ? end : null,
    avgStart: days ? startSum / days : null,
    gaps,
    tight,
    maxDay,
    rating,
    gpa,
    seats,
    online,
    early,
    late,
  };
}

export const SORTS = {
  balanced: 'Balanced',
  days: 'Fewest days on campus',
  gaps: 'Least time between classes',
  late: 'Start later',
  early: 'Finish earlier',
  rating: 'Best-rated professors',
  gpa: 'Highest average GPA',
};

export function balancedScore(m) {
  let s = m.days * 45 + m.gaps * 0.5 + m.early * 0.35 + m.late * 0.2 + m.tight * 25 - m.credits * 8;
  if (m.ratingAdj != null) s -= (m.ratingAdj - 3) * 30;
  if (m.gpa != null) s -= (m.gpa - 2.8) * 30;
  return s;
}

const nullLast = (a, b, dir) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir * (a - b);
};

export function comparator(sort) {
  const byScore = (a, b) => a.m.score - b.m.score;
  switch (sort) {
    case 'days':
      return (a, b) => a.m.days - b.m.days || a.m.gaps - b.m.gaps || byScore(a, b);
    case 'gaps':
      return (a, b) => a.m.gaps - b.m.gaps || a.m.days - b.m.days || byScore(a, b);
    case 'late':
      return (a, b) => nullLast(a.m.start, b.m.start, -1) || nullLast(a.m.avgStart, b.m.avgStart, -1) || byScore(a, b);
    case 'early':
      return (a, b) => nullLast(a.m.end, b.m.end, 1) || byScore(a, b);
    case 'rating':
      return (a, b) => nullLast(a.m.ratingAdj, b.m.ratingAdj, -1) || nullLast(a.m.rating, b.m.rating, -1) || byScore(a, b);
    case 'gpa':
      return (a, b) => nullLast(a.m.gpa, b.m.gpa, -1) || byScore(a, b);
    default:
      return byScore;
  }
}

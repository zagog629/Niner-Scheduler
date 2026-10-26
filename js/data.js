// Loads the static JSON the GitHub Action publishes and answers lookups about it
import { buildRmpIndex, findRmp, findGrades, gpaOf, courseTotals } from './names.js';

/**
 * A data file that couldn't be loaded. `kind` says why, so the UI can explain it in plain words:
 * 'offline' (no connection), 'missing' (404), 'server' (any other HTTP error) or 'bad-data' (not valid JSON)
 */
export class LoadError extends Error {
  constructor(url, kind, status = null, cause = undefined) {
    super(`${url}: ${status ? `HTTP ${status}` : cause?.message || kind}`, cause ? { cause } : undefined);
    this.name = 'LoadError';
    this.url = url;
    this.kind = kind;
    this.status = status;
  }
}

const cache = new Map();
async function getJson(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url, { cache: 'no-cache' }).then(
        (r) => {
          if (!r.ok) throw new LoadError(url, r.status === 404 ? 'missing' : 'server', r.status);
          return r.json().catch((err) => {
            throw new LoadError(url, err instanceof SyntaxError ? 'bad-data' : 'offline', null, err);
          });
        },
        (err) => {
          throw new LoadError(url, 'offline', null, err);
        },
      ),
    );
  }
  try {
    return await cache.get(url);
  } catch (err) {
    cache.delete(url);
    throw err;
  }
}

export const db = {
  terms: [],
  term: null, // { term, desc, updated, subjects, sections, links }
  courses: new Map(), // "ITSC 2214" -> { key, subj, num, title, sections[], crMin, crMax }
  byCrn: new Map(),
  rmp: null,
  rmpIndex: null,
  rmpUpdated: null,
  grades: {}, // subj -> { "ITSC-2214": { name: {...} } } | null when missing
  catalog: {},
};

export async function loadTerms() {
  const j = await getJson('data/terms.json');
  db.terms = j.terms || [];
  return db.terms;
}

export async function loadTerm(code) {
  const t = await getJson(`data/terms/${encodeURIComponent(code)}.json`);
  db.term = t;
  db.courses = new Map();
  db.byCrn = new Map();
  for (const s of t.sections) {
    const key = `${s.subj} ${s.num}`;
    let c = db.courses.get(key);
    if (!c) {
      c = { key, subj: s.subj, num: s.num, title: s.title, sections: [], crMin: Infinity, crMax: 0, search: '' };
      db.courses.set(key, c);
    }
    c.sections.push(s);
    c.crMin = Math.min(c.crMin, s.cr || 0);
    c.crMax = Math.max(c.crMax, s.crMax || s.cr || 0);
    db.byCrn.set(s.crn, s);
  }
  for (const c of db.courses.values()) {
    // Linked courses keep their credits on the lecture; ignore 0-credit labs when describing the course
    const credited = c.sections.filter((s) => s.cr > 0);
    if (credited.length) c.crMin = Math.min(...credited.map((s) => s.cr));
    if (!Number.isFinite(c.crMin)) c.crMin = 0;
    c.search = `${c.subj}${c.num} ${c.subj} ${c.num} ${c.title} ${t.subjects?.[c.subj] || ''}`.toLowerCase();
  }
  return t;
}

export async function loadRmp() {
  if (db.rmp) return db.rmp;
  try {
    const j = await getJson('data/rmp.json');
    db.rmp = j.profs || [];
    db.rmpUpdated = j.updated || null;
  } catch {
    db.rmp = [];
  }
  db.rmpIndex = buildRmpIndex(db.rmp);
  return db.rmp;
}

export async function loadGrades(subj) {
  if (subj in db.grades) return db.grades[subj];
  try {
    db.grades[subj] = await getJson(`data/grades/${encodeURIComponent(subj)}.json`);
  } catch {
    db.grades[subj] = null;
  }
  return db.grades[subj];
}

export async function loadCatalog(subj) {
  if (subj in db.catalog) return db.catalog[subj];
  try {
    db.catalog[subj] = await getJson(`data/catalog/${encodeURIComponent(subj)}.json`);
  } catch {
    db.catalog[subj] = null;
  }
  return db.catalog[subj];
}

const rmpMemo = new Map();
export function rmpFor(name) {
  if (!db.rmpIndex) return null;
  if (!rmpMemo.has(name)) rmpMemo.set(name, findRmp(db.rmpIndex, name));
  return rmpMemo.get(name);
}

export function courseGrades(courseKey) {
  const [subj, num] = courseKey.split(' ');
  return db.grades[subj]?.[`${subj}-${num}`] || null;
}

/** Historical grades for one instructor in one course, or null */
export function gradesFor(courseKey, name) {
  return findGrades(courseGrades(courseKey), name);
}

export function gpaFor(courseKey, name) {
  const g = gradesFor(courseKey, name);
  return g ? gpaOf(g.all) : null;
}

export function courseGpa(courseKey) {
  const g = courseGrades(courseKey);
  return g ? gpaOf(courseTotals(g)) : null;
}

/** Search courses by code, title, subject name or CRN */
export function searchCourses(q, limit = 40) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  if (/^\d{5}$/.test(query)) {
    const s = db.byCrn.get(query);
    return s ? [{ course: db.courses.get(`${s.subj} ${s.num}`), crn: s.crn }] : [];
  }
  const compact = query.replace(/\s+/g, '');
  const words = query.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of db.courses.values()) {
    const code = `${c.subj}${c.num}`.toLowerCase();
    let score = -1;
    if (code === compact) score = 100;
    else if (code.startsWith(compact)) score = 80 - code.length;
    else if (words.every((w) => c.search.includes(w))) score = 40 - (c.title.toLowerCase().startsWith(words[0]) ? 0 : 5);
    if (score >= 0) scored.push({ course: c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.course.key.localeCompare(b.course.key, undefined, { numeric: true }));
  return scored.slice(0, limit);
}

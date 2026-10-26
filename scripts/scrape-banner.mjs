#!/usr/bin/env node
// Scrapes UNC Charlotte's public Banner 9 "Browse Classes" search into static JSON
//
//   node scripts/scrape-banner.mjs                 # every term that is open for registration
//   TERMS=202710 node scripts/scrape-banner.mjs    # specific term code(s), comma separated
//   SUBJECTS=ITSC,MATH node scripts/scrape-banner.mjs   # quick partial run while testing
//
// Writes:
//   data/terms.json             list of terms the site offers
//   data/terms/<code>.json      every section for that term
//   data/catalog/<SUBJ>.json    course descriptions + prerequisites (cached between runs)
//
// No login is needed: this is the same data anyone sees on the "Browse Classes" page.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeSection,
  parseLinkedReply,
  parseDescriptionHtml,
  parsePrereqHtml,
  decodeEntities,
} from './lib/normalize.mjs';

const BASE = (process.env.BANNER_BASE || 'https://selfservice.uncc.edu/StudentRegistrationSsb/ssb').replace(/\/$/, '');
const OUT = path.resolve(process.env.OUT_DIR || 'data');
const PAGE_SIZE = 500;
const SESSIONS = Math.max(1, Number(process.env.CONCURRENCY || 4));
const CATALOG_MAX_AGE_DAYS = Number(process.env.CATALOG_MAX_AGE_DAYS || 30);
const SKIP_CATALOG = process.env.SKIP_CATALOG === '1';
const SKIP_LINKS = process.env.SKIP_LINKS === '1';
const UA = process.env.SCRAPER_UA || 'NinerScheduler/1.0 (student schedule planner; github.com/zagog629/Niner-Scheduler)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class BannerSession {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
    this.token = '';
    this.uid = Math.random().toString(36).slice(2, 7) + Date.now();
  }

  storeCookies(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(p, { method = 'GET', form = null, accept = 'application/json, text/javascript, */*; q=0.01' } = {}, attempt = 0) {
    const url = p.startsWith('http') ? p : BASE + p;
    const headers = { 'User-Agent': UA, Accept: accept, 'X-Requested-With': 'XMLHttpRequest' };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.token) headers['X-Synchronizer-Token'] = this.token;
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
      body = new URLSearchParams(form).toString();
    }
    try {
      const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      this.storeCookies(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        return this.request(new URL(res.headers.get('location'), url).href, { accept }, attempt);
      }
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} for ${p}`);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (attempt >= 4) throw err;
      const wait = 1500 * 2 ** attempt;
      log(`[${this.name}] ${err.message}; retrying in ${wait / 1000}s`);
      await sleep(wait);
      return this.request(p, { method, form, accept }, attempt + 1);
    }
  }

  async json(p, opts) {
    const r = await this.request(p, opts);
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error(`Expected JSON from ${p} (HTTP ${r.status}): ${r.text.slice(0, 160).replace(/\s+/g, ' ')}`);
    }
  }

  /** Starts a Banner session and selects the term, which every search call depends on */
  async open(term) {
    const page = await this.request('/term/termSelection?mode=search', { accept: 'text/html' });
    const m =
      page.text.match(/name=["']synchronizerToken["'][^>]*content=["']([^"']+)["']/i) ||
      page.text.match(/content=["']([^"']+)["'][^>]*name=["']synchronizerToken["']/i);
    if (m) this.token = m[1];
    await this.request('/term/search?mode=search', {
      method: 'POST',
      form: { term, studyPath: '', studyPathText: '', startDatepicker: '', endDatepicker: '', uniqueSessionId: this.uid },
    });
    await this.request('/classSearch/classSearch', { accept: 'text/html' });
    this.term = term;
    return this;
  }

  async searchSubject(subject) {
    // Banner remembers the last search per session; without this reset the next subject returns stale rows
    await this.request('/classSearch/resetDataForm', { method: 'POST', form: { uniqueSessionId: this.uid } });
    const rows = [];
    let offset = 0;
    let total = Infinity;
    while (offset < total) {
      const q = new URLSearchParams({
        txt_subject: subject,
        txt_term: this.term,
        startDatepicker: '',
        endDatepicker: '',
        uniqueSessionId: this.uid,
        pageOffset: String(offset),
        pageMaxSize: String(PAGE_SIZE),
        sortColumn: 'subjectDescription',
        sortDirection: 'asc',
      });
      const r = await this.json(`/searchResults/searchResults?${q}`);
      if (r.success === false) throw new Error(`Search failed for ${subject}: ${JSON.stringify(r).slice(0, 200)}`);
      const data = r.data || [];
      total = Number(r.totalCount || 0);
      rows.push(...data);
      if (!data.length) break;
      offset += data.length;
    }
    return rows;
  }
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async (_, w) => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i, w);
      }
    }),
  );
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function getTerms() {
  const s = new BannerSession('terms');
  const terms = await s.json('/classSearch/getTerms?searchTerm=&offset=1&max=40');
  return terms.map((t) => ({ code: String(t.code), desc: decodeEntities(t.description) }));
}

function pickTerms(all) {
  if (process.env.TERMS) {
    const want = process.env.TERMS.split(',').map((s) => s.trim()).filter(Boolean);
    return want.map((code) => all.find((t) => t.code === code) || { code, desc: code });
  }
  const open = all.filter((t) => !/view only/i.test(t.desc));
  return open.length ? open : all.slice(0, 1);
}

async function scrapeTerm(term) {
  log(`== ${term.desc} (${term.code})`);
  const probe = await new BannerSession('subjects').open(term.code);
  let subjects = await probe.json(
    `/classSearch/get_subject?searchTerm=&term=${term.code}&offset=1&max=1000&uniqueSessionId=${probe.uid}`,
  );
  subjects = subjects.map((s) => ({ code: s.code, desc: decodeEntities(s.description) }));
  if (process.env.SUBJECTS) {
    const only = new Set(process.env.SUBJECTS.split(',').map((s) => s.trim().toUpperCase()));
    subjects = subjects.filter((s) => only.has(s.code));
  }
  log(`${subjects.length} subjects`);

  const sessions = await Promise.all(
    Array.from({ length: SESSIONS }, (_, i) => new BannerSession(`s${i + 1}`).open(term.code)),
  );

  const bySubject = await pool(subjects, sessions.length, async (subj, i, w) => {
    const session = sessions[w];
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await session.searchSubject(subj.code);
      const wrong = rows.filter((r) => r.subject !== subj.code).length;
      if (!wrong) {
        if (rows.length) log(`[${session.name}] ${subj.code}: ${rows.length}`);
        return rows;
      }
      log(`[${session.name}] ${subj.code}: ${wrong} rows from another subject, reopening session`);
      await session.open(term.code);
    }
    throw new Error(`Could not get clean results for ${subj.code}`);
  });

  const seen = new Set();
  const sections = [];
  for (const raw of bySubject.flat()) {
    const crn = String(raw.courseReferenceNumber);
    if (seen.has(crn)) continue;
    seen.add(crn);
    sections.push(normalizeSection(raw));
  }
  sections.sort((a, b) => a.subj.localeCompare(b.subj) || a.num.localeCompare(b.num) || a.seq.localeCompare(b.seq));
  log(`${sections.length} sections`);
  if (!sections.length) throw new Error(`No sections came back for ${term.code}; refusing to publish an empty term.`);

  // Linked sections (e.g. lecture that must be taken with a specific lab/recitation)
  const links = {};
  if (!SKIP_LINKS) {
    const linked = sections.filter((s) => s.linked);
    let failures = 0;
    await pool(linked, sessions.length, async (sec, i, w) => {
      if (failures > 25) return;
      try {
        const r = await sessions[w].json(
          `/searchResults/fetchLinkedSections?term=${term.code}&courseReferenceNumber=${sec.crn}`,
        );
        const groups = parseLinkedReply(r).map((g) => g.filter((c) => c !== sec.crn));
        if (groups.some((g) => g.length)) links[sec.crn] = groups;
      } catch (err) {
        failures++;
        if (failures === 1 || failures === 26) log(`linked-section lookup failed (${err.message})${failures > 25 ? '; skipping the rest' : ''}`);
      }
    });
    log(`link data for ${Object.keys(links).length} of ${linked.length} linked sections`);
  }

  if (!SKIP_CATALOG) await updateCatalog(term, sections, sessions);

  return {
    term: term.code,
    desc: term.desc.replace(/\s*\(view only\)/i, ''),
    updated: new Date().toISOString(),
    subjects: Object.fromEntries(subjects.map((s) => [s.code, s.desc])),
    sections,
    links,
  };
}

/** Descriptions and prerequisites per course, cached in data/catalog and refreshed monthly */
async function updateCatalog(term, sections, sessions) {
  const dir = path.join(OUT, 'catalog');
  await mkdir(dir, { recursive: true });
  const firstCrn = new Map();
  for (const s of sections) {
    const key = `${s.subj} ${s.num}`;
    if (!firstCrn.has(key)) firstCrn.set(key, s.crn);
  }
  const subjects = [...new Set(sections.map((s) => s.subj))];
  const books = {};
  for (const subj of subjects) books[subj] = await readJson(path.join(dir, `${subj}.json`), {});

  const cutoff = Date.now() - CATALOG_MAX_AGE_DAYS * 86400_000;
  const todo = [...firstCrn].filter(([key]) => {
    const entry = books[key.split(' ')[0]][key];
    return !entry || !entry.at || Date.parse(entry.at) < cutoff;
  });
  log(`catalog: ${todo.length} of ${firstCrn.size} courses need descriptions`);

  let failures = 0;
  await pool(todo, sessions.length, async ([key, crn], i, w) => {
    if (failures > 40) return;
    const form = { term: term.code, courseReferenceNumber: crn };
    try {
      const [desc, prereq] = await Promise.all([
        sessions[w].request('/searchResults/getCourseDescription', { method: 'POST', form, accept: 'text/html' }),
        sessions[w].request('/searchResults/getSectionPrerequisites', { method: 'POST', form, accept: 'text/html' }),
      ]);
      books[key.split(' ')[0]][key] = {
        desc: parseDescriptionHtml(desc.text),
        prereq: parsePrereqHtml(prereq.text),
        at: new Date().toISOString().slice(0, 10),
      };
    } catch (err) {
      failures++;
      if (failures === 1) log(`catalog lookup failed (${err.message})`);
    }
    if (i > 0 && i % 250 === 0) log(`catalog: ${i}/${todo.length}`);
  });

  for (const subj of subjects) {
    const sorted = Object.fromEntries(Object.entries(books[subj]).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(path.join(dir, `${subj}.json`), JSON.stringify(sorted));
  }
}

async function main() {
  await mkdir(path.join(OUT, 'terms'), { recursive: true });
  const all = await getTerms();
  const chosen = pickTerms(all);
  log(`Terms: ${chosen.map((t) => `${t.desc} (${t.code})`).join(', ')}`);

  const index = (await readJson(path.join(OUT, 'terms.json'), { terms: [] })).terms;
  let ok = 0;
  for (const term of chosen) {
    try {
      const data = await scrapeTerm(term);
      await writeFile(path.join(OUT, 'terms', `${term.code}.json`), JSON.stringify(data));
      const entry = { code: term.code, desc: data.desc, updated: data.updated, sections: data.sections.length };
      const at = index.findIndex((t) => t.code === term.code);
      if (at >= 0) index[at] = entry;
      else index.push(entry);
      ok++;
    } catch (err) {
      console.error(`!! ${term.code} failed: ${err.stack || err.message}`);
    }
  }

  // Advertise the terms we were asked to scrape (keeping last run's file if this run failed), newest first
  // Terms that close for registration drop off the list automatically
  const files = new Set((await readdir(path.join(OUT, 'terms'))).map((f) => f.replace(/\.json$/, '')));
  const wanted = new Set(chosen.map((t) => t.code));
  const keep = index.filter((t) => files.has(t.code) && wanted.has(t.code)).sort((a, b) => b.code.localeCompare(a.code));
  await writeFile(path.join(OUT, 'terms.json'), JSON.stringify({ updated: new Date().toISOString(), terms: keep }, null, 1));
  log(`Done: ${ok}/${chosen.length} terms scraped`);
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

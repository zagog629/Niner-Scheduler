#!/usr/bin/env node
// Downloads Rate My Professors summaries for UNC Charlotte instructors into data/rmp.json
// Browsers can't call RMP from a GitHub Pages site (CORS), so the site reads this file instead
//
// Two ways to collect them:
//   1. Bulk: page through every professor listed at the school (fast, a handful of requests)
//   2. By name: look up each instructor in data/terms/*.json by last name. Slower, but uses the
//      simplest form of RMP's search, so it still works if the bulk listing comes back empty
// Bulk runs first; name lookups fill in whatever it missed
//
//   RMP_MODE=names node scripts/scrape-rmp.mjs    # skip the bulk listing
//   RMP_DEBUG=1 node scripts/scrape-rmp.mjs       # print RMP's raw replies when something fails

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve(process.env.OUT_DIR || 'data');
const SCHOOL_ID = process.env.RMP_SCHOOL_ID || 'U2Nob29sLTEyNTM='; // base64("School-1253") = UNC Charlotte
const MODE = process.env.RMP_MODE || 'auto';
const DEBUG = process.env.RMP_DEBUG === '1';
const CONCURRENCY = Number(process.env.RMP_CONCURRENCY || 3);
const ENDPOINT = 'https://www.ratemyprofessors.com/graphql';

const NODE_FIELDS = `
  legacyId
  firstName
  lastName
  department
  avgRating
  avgDifficulty
  numRatings
  wouldTakeAgainPercent
  ratings(first: 1) { edges { node { date } } }`;

const BULK_QUERY = `query TeacherSearchPaginationQuery($count: Int!, $cursor: String, $query: TeacherSearchQuery!) {
  search: newSearch {
    teachers(query: $query, first: $count, after: $cursor) {
      edges { node { ${NODE_FIELDS} } }
      pageInfo { hasNextPage endCursor }
      resultCount
    }
  }
}`;

const NAME_QUERY = `query TeacherSearch($query: TeacherSearchQuery!, $count: Int!) {
  newSearch {
    teachers(query: $query, first: $count) {
      edges { node { ${NODE_FIELDS} } }
    }
  }
}`;

const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  Authorization: 'Basic dGVzdDp0ZXN0',
  Origin: 'https://www.ratemyprofessors.com',
  Referer: 'https://www.ratemyprofessors.com/',
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables, label) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(45_000) });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${res.status}, not JSON (${res.headers.get('content-type') || 'no content-type'}): ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
      }
      if (json.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
      if (DEBUG) console.log(`[debug] ${label}: ${text.slice(0, 300)}`);
      return json.data;
    } catch (err) {
      lastErr = err;
      // Schema errors won't fix themselves; only retry network / rate-limit problems
      if (/GraphQL error/.test(err.message)) break;
      await sleep(1500 * 2 ** attempt);
    }
  }
  throw lastErr;
}

function keep(profs, node) {
  if (!node || !node.numRatings || node.legacyId == null) return;
  profs.set(node.legacyId, {
    id: node.legacyId,
    f: (node.firstName || '').trim(),
    l: (node.lastName || '').trim(),
    dept: node.department || '',
    r: node.avgRating,
    d: node.avgDifficulty,
    n: node.numRatings,
    w: node.wouldTakeAgainPercent >= 0 ? Math.round(node.wouldTakeAgainPercent) : null,
    last: node.ratings?.edges?.[0]?.node?.date?.slice(0, 10) || null,
  });
}

async function bulk(profs) {
  let cursor = '';
  let count = 1000;
  for (let i = 0; i < 200; i++) {
    let t;
    try {
      t = (await gql(BULK_QUERY, { count, cursor, query: { text: '', schoolID: SCHOOL_ID } }, 'bulk'))?.search?.teachers;
    } catch (err) {
      if (count > 50) {
        count = count > 100 ? 100 : 50; // some setups cap the page size
        continue;
      }
      throw err;
    }
    if (!t) throw new Error('bulk listing returned no teachers object');
    for (const { node } of t.edges || []) keep(profs, node);
    console.log(`bulk: ${profs.size} rated professors so far (RMP lists ${t.resultCount ?? '?'})`);
    if (!t.pageInfo?.hasNextPage || !t.edges?.length) break;
    cursor = t.pageInfo.endCursor;
  }
}

/** Last names of everyone teaching in the scraped terms (plus the Banner→RMP name overrides) */
async function instructorLastNames() {
  const names = new Set();
  const dir = path.join(OUT, 'terms');
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const term = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
    for (const s of term.sections || []) for (const n of s.inst || []) names.add(n);
  }
  // Same overrides the site uses when matching names (js/names.js)
  const namesJs = await readFile(new URL('../js/names.js', import.meta.url), 'utf8').catch(() => '');
  for (const m of namesJs.matchAll(/'[^']+':\s*'([^']+)'/g)) names.add(m[1]);
  const last = new Set();
  for (const n of names) {
    const parts = n.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z' -]/g, ' ').trim().split(/\s+/);
    const l = parts[parts.length - 1];
    if (l && l.length > 1 && l !== 'Staff') last.add(l.toLowerCase());
  }
  return [...last].sort();
}

async function byName(profs) {
  const names = await instructorLastNames();
  if (!names.length) {
    console.log('names: no scraped terms found in data/terms, run the Banner scrape first');
    return;
  }
  console.log(`names: looking up ${names.length} instructor last names`);
  let next = 0;
  let done = 0;
  let failures = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < names.length && failures < 25) {
        const name = names[next++];
        try {
          const t = (await gql(NAME_QUERY, { count: 50, query: { text: name, schoolID: SCHOOL_ID } }, `name ${name}`))?.newSearch?.teachers;
          for (const { node } of t?.edges || []) keep(profs, node);
        } catch (err) {
          failures++;
          if (failures <= 3) console.log(`names: lookup for "${name}" failed: ${err.message}`);
        }
        done++;
        if (done % 200 === 0) console.log(`names: ${done}/${names.length}, ${profs.size} rated professors`);
        await sleep(120);
      }
    }),
  );
  if (failures >= 25) console.log('names: stopped after 25 failed lookups');
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const profs = new Map();

  if (MODE !== 'names') {
    try {
      await bulk(profs);
    } catch (err) {
      console.log(`bulk listing failed: ${err.message}`);
    }
  }
  if (MODE === 'names' || profs.size < 300) {
    if (MODE !== 'names') console.log(`bulk listing found only ${profs.size}; looking instructors up by name`);
    await byName(profs);
  }

  const outFile = path.join(OUT, 'rmp.json');
  if (!profs.size) {
    const prev = await readFile(outFile, 'utf8').catch(() => null);
    console.error(`No ratings came back from Rate My Professors. ${prev ? 'Keeping the previous rmp.json.' : 'Run with RMP_DEBUG=1 to see what RMP replied.'}`);
    process.exit(prev ? 0 : 1);
  }
  const list = [...profs.values()].sort((a, b) => a.l.localeCompare(b.l) || a.f.localeCompare(b.f));
  await writeFile(outFile, JSON.stringify({ updated: new Date().toISOString(), profs: list }));
  console.log(`wrote ${list.length} rated professors to ${path.relative(process.cwd(), outFile)}`);
}

main().catch(async (err) => {
  console.error(err);
  const prev = await readFile(path.join(OUT, 'rmp.json'), 'utf8').catch(() => null);
  // Ratings are nice-to-have: never fail the whole data refresh because RMP hiccuped
  process.exit(prev ? 0 : 1);
});

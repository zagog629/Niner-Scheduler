// Turns raw Banner 9 class-search JSON into the compact shape the site reads
// Kept separate from the network code so it can be tested offline

const DAY_FIELDS = [
  ['monday', 'M'],
  ['tuesday', 'T'],
  ['wednesday', 'W'],
  ['thursday', 'R'],
  ['friday', 'F'],
  ['saturday', 'S'],
  ['sunday', 'U'],
];

/** "0830" -> 510 (minutes after midnight); null when missing */
export function hhmmToMinutes(v) {
  if (v == null || v === '') return null;
  const s = String(v).padStart(4, '0');
  const h = Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

/** "01/12/2027" -> "2027-01-12"; passes ISO through; null when missing */
export function bannerDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Banner can show names as "Last, First" or "First Last". Always return "First Last" */
export function toFirstLast(name) {
  if (!name) return '';
  const clean = decodeEntities(String(name)).replace(/\s+/g, ' ').trim();
  const comma = clean.indexOf(',');
  if (comma === -1) return clean;
  const last = clean.slice(0, comma).trim();
  const first = clean.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeMeeting(mf) {
  const t = mf?.meetingTime || mf || {};
  let days = '';
  for (const [field, letter] of DAY_FIELDS) if (t[field]) days += letter;
  const s = hhmmToMinutes(t.beginTime);
  const e = hhmmToMinutes(t.endTime);
  return {
    d: days,
    s: days && s != null ? s : null,
    e: days && e != null ? e : null,
    b: decodeEntities(t.buildingDescription || '').trim() || null,
    bc: t.building || null,
    r: t.room || null,
    sd: bannerDate(t.startDate),
    ed: bannerDate(t.endDate),
    t: t.meetingTypeDescription || null,
  };
}

/** One Banner section object -> compact section */
export function normalizeSection(raw) {
  const faculty = Array.isArray(raw.faculty) ? [...raw.faculty] : [];
  faculty.sort((a, b) => Number(!!b.primaryIndicator) - Number(!!a.primaryIndicator));
  const inst = [];
  for (const f of faculty) {
    const n = toFirstLast(f.displayName);
    if (n && !inst.includes(n)) inst.push(n);
  }

  const meetings = (raw.meetingsFaculty || []).map(normalizeMeeting);
  // Drop exact duplicate meetings (Banner repeats a meeting once per instructor)
  const seen = new Set();
  const mt = meetings.filter((m) => {
    const k = JSON.stringify(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const cr = num(raw.creditHours) ?? num(raw.creditHourLow) ?? 0;
  const crMax = num(raw.creditHourHigh);

  return {
    crn: String(raw.courseReferenceNumber),
    subj: raw.subject,
    num: String(raw.courseNumber),
    seq: raw.sequenceNumber || '',
    title: decodeEntities(raw.courseTitle || '').replace(/\s+/g, ' ').trim(),
    type: raw.scheduleTypeDescription || '',
    cr,
    ...(crMax && crMax > cr ? { crMax } : {}),
    campus: raw.campusDescription || '',
    method: raw.instructionalMethodDescription || raw.instructionalMethod || '',
    pot: raw.partOfTerm || '',
    max: num(raw.maximumEnrollment),
    enr: num(raw.enrollment),
    seats: num(raw.seatsAvailable),
    wcap: num(raw.waitCapacity),
    wcnt: num(raw.waitCount),
    open: !!raw.openSection,
    link: raw.linkIdentifier || null,
    linked: !!raw.isSectionLinked,
    inst,
    mt,
    attr: (raw.sectionAttributes || []).map((a) => decodeEntities(a.description || a.code || '')).filter(Boolean),
  };
}

/** Collect CRN groups out of Banner's fetchLinkedSections reply, whatever its exact nesting */
export function parseLinkedReply(json) {
  const groups = [];
  const root = json?.linkedData ?? json?.data ?? json;
  const crnsIn = (node, acc) => {
    if (!node || typeof node !== 'object') return acc;
    if (node.courseReferenceNumber) acc.push(String(node.courseReferenceNumber));
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      if (v && typeof v === 'object') crnsIn(v, acc);
    }
    return acc;
  };
  if (Array.isArray(root)) {
    for (const g of root) {
      const crns = [...new Set(crnsIn(g, []))];
      if (crns.length) groups.push(crns);
    }
  }
  return groups;
}

// HTML helpers for the description

export function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/�+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDescriptionHtml(html) {
  const section = String(html || '').match(/<section[^>]*courseDescription[^>]*>([\s\S]*?)<\/section>/i);
  const text = stripTags(section ? section[1] : html).replace(/^course description:?\s*/i, '');
  if (!text || /no course description/i.test(text)) return null;
  return text;
}

/**
 * Prerequisite table rows: [and/or, (, test, score, subject, number, level, grade, )]
 * Returns groups where each group is a list of alternatives (OR) and groups are ANDed
 */
export function parsePrereqHtml(html) {
  const rows = [...String(html || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => stripTags(c[1])),
  );
  const groups = [];
  for (const cells of rows) {
    if (!cells.length) continue;
    const andOr = (cells[0] || '').toUpperCase();
    const test = cells[2] || '';
    const score = cells[3] || '';
    const subject = cells[4] || '';
    const courseNum = cells[5] || '';
    const grade = cells[7] || '';
    let entry = '';
    if (subject || courseNum) entry = `${subject} ${courseNum}`.trim() + (grade ? ` (min grade ${grade})` : '');
    else if (test) entry = `${test}${score ? ` ≥ ${score}` : ''}`;
    if (!entry) continue;
    if (!groups.length || andOr === 'AND' || andOr === '') groups.push([entry]);
    else groups[groups.length - 1].push(entry);
  }
  return groups.length ? groups : null;
}

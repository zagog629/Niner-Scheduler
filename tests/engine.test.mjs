import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayMask,
  meetingsOf,
  sectionReason,
  buildBundles,
  generate,
  measure,
  comparator,
  lockedTypesOf,
} from '../js/engine.js';
import { normalizeSection, toFirstLast, parsePrereqHtml, parseDescriptionHtml, parseLinkedReply } from '../scripts/lib/normalize.mjs';

let crn = 10000;
function sec(subj, num, days, s, e, extra = {}) {
  return {
    crn: String(crn++),
    subj,
    num,
    seq: extra.seq || '001',
    type: extra.type || 'Lecture',
    cr: extra.cr ?? 3,
    campus: extra.campus || 'Main Campus',
    method: extra.method || 'Face-to-Face',
    seats: extra.seats ?? 10,
    wcap: extra.wcap ?? 0,
    wcnt: extra.wcnt ?? 0,
    open: (extra.seats ?? 10) > 0,
    linked: !!extra.linked,
    inst: extra.inst || ['Pat Smith'],
    mt: days ? [{ d: days, s, e, b: extra.b || 'Woodward Hall', sd: extra.sd || '2027-01-11', ed: extra.ed || '2027-05-05' }] : [{ d: '', s: null, e: null }],
  };
}
const course = (o = {}) => ({ locked: [], excluded: [], ...o });
const noPrefs = { daysOff: 0, earliest: null, latest: null, breaks: [], openOnly: false };

function toInput(courseDefs, prefs = {}) {
  // courseDefs: [{ key, optional, sections }]
  const secs = [];
  const index = new Map();
  const courses = courseDefs.map((c) => {
    const allowed = new Set(c.sections.map((s) => s.crn));
    const bundles = buildBundles(c.sections, allowed, c.links || {}).map((b) => ({
      secs: b.map((s) => {
        if (!index.has(s.crn)) {
          index.set(s.crn, secs.length);
          secs.push({ m: meetingsOf(s), rating: s.rating ?? null, gpa: s.gpa ?? null, seats: s.seats, timed: meetingsOf(s).length > 0 });
        }
        return index.get(s.crn);
      }),
      cr: b.reduce((t, s) => t + s.cr, 0),
    }));
    return { key: c.key, optional: !!c.optional, bundles };
  });
  return { courses, secs, prefs };
}

test('day masks and minutes', () => {
  assert.equal(dayMask('MWF'), 0b10101);
  assert.equal(dayMask('TR'), 0b01010);
  const s = sec('A', '1', 'MWF', 540, 590);
  assert.equal(meetingsOf(s)[0].days, 0b10101);
});

test('two courses at the same time conflict, different times do not', () => {
  const a = [sec('A', '1', 'MWF', 540, 590)];
  const b1 = sec('B', '1', 'MWF', 560, 610); // overlaps
  const b2 = sec('B', '1', 'TR', 560, 635); // different days
  const out = generate(toInput([{ key: 'A 1', sections: a }, { key: 'B 1', sections: [b1, b2] }]));
  assert.equal(out.total, 1);
  assert.equal(out.results[0].m.days, 5);
});

test('back-to-back classes (end == start) do not conflict', () => {
  const out = generate(
    toInput([
      { key: 'A', sections: [sec('A', '1', 'MW', 540, 590)] },
      { key: 'B', sections: [sec('B', '1', 'MW', 590, 640, { b: 'Fretwell' })] },
    ]),
  );
  assert.equal(out.total, 1);
  assert.equal(out.results[0].m.tight, 2, 'different buildings back-to-back on two days');
});

test('first-half and second-half 8-week sections at the same time do not conflict', () => {
  const first = sec('A', '1', 'TR', 870, 945, { sd: '2027-01-11', ed: '2027-03-05' });
  const second = sec('B', '1', 'TR', 870, 945, { sd: '2027-03-15', ed: '2027-05-05' });
  const out = generate(toInput([{ key: 'A', sections: [first] }, { key: 'B', sections: [second] }]));
  assert.equal(out.total, 1);
});

test('online sections never conflict', () => {
  const out = generate(
    toInput([
      { key: 'A', sections: [sec('A', '1', 'MWF', 540, 590)] },
      { key: 'B', sections: [sec('B', '1', '', null, null)] },
    ]),
  );
  assert.equal(out.total, 1);
  assert.equal(out.results[0].m.online, 1);
});

test('section filters: early, late, day off, breaks, full, locks', () => {
  const s8 = sec('A', '1', 'MWF', 480, 530);
  const sEve = sec('A', '1', 'TR', 1140, 1215);
  const sFull = sec('A', '1', 'TR', 600, 675, { seats: 0, wcap: 5, wcnt: 1 });
  assert.equal(sectionReason(s8, course(), { ...noPrefs, earliest: 540 }), 'early');
  assert.equal(sectionReason(sEve, course(), { ...noPrefs, latest: 1080 }), 'late');
  assert.equal(sectionReason(s8, course(), { ...noPrefs, daysOff: dayMask('F') }), 'dayoff');
  assert.equal(sectionReason(s8, course(), { ...noPrefs, breaks: [{ d: 2, s: 500, e: 520 }] }), 'break');
  assert.equal(sectionReason(s8, course(), { ...noPrefs, breaks: [{ d: 1, s: 500, e: 520 }] }), null, 'Tuesday break does not hit MWF');
  assert.equal(sectionReason(sFull, course(), { ...noPrefs, openOnly: true }), 'full');
  assert.equal(sectionReason(sFull, course(), { ...noPrefs, openOnly: true, waitlistOk: true }), null);
  // A locked section ignores every filter; other lectures are blocked by the lock
  const c = course({ locked: [s8.crn] });
  const lt = lockedTypesOf(c, [s8, sEve]);
  assert.equal(sectionReason(s8, c, noPrefs, lt), null);
  assert.equal(sectionReason(s8, c, { ...noPrefs, earliest: 600 }, lt), null);
  assert.equal(sectionReason(s8, c, { ...noPrefs, breaks: [{ d: 0, s: 500, e: 520 }] }, lt), null);
  assert.equal(sectionReason(s8, c, { ...noPrefs, daysOff: dayMask('F') }, lt), null);
  assert.equal(sectionReason(sEve, c, noPrefs, lt), 'locked');
  const cf = course({ locked: [sFull.crn], excluded: [sFull.crn] });
  assert.equal(sectionReason(sFull, cf, { ...noPrefs, openOnly: true }, lockedTypesOf(cf, [sFull])), null, 'lock beats full and turned off');
});

test('a locked section stays in the schedule even when a break or day off covers it', () => {
  const locked = sec('L', '1', 'MW', 600, 675);
  const other = sec('L', '1', 'TR', 600, 675);
  const free = sec('F', '1', 'TR', 780, 855);
  const plan = [
    { key: 'L 1', sections: [locked, other], c: course({ locked: [locked.crn] }) },
    { key: 'F 1', sections: [free], c: course() },
  ];
  const prefs = { ...noPrefs, breaks: [{ d: 0, s: 630, e: 690 }], daysOff: dayMask('W') }; // both hit the locked MW 10:00
  const defs = plan.map(({ key, sections, c }) => {
    const lt = lockedTypesOf(c, sections);
    return { key, sections: sections.filter((s) => !sectionReason(s, c, prefs, lt)) };
  });
  assert.deepEqual(defs[0].sections, [locked], 'the locked section stays and the lock blocks the other lecture');
  const out = generate(toInput(defs));
  assert.equal(out.total, 1);
});

test('linked lecture + lab bundles respect link groups and internal conflicts', () => {
  const lec1 = sec('C', '1', 'MW', 540, 615, { linked: true });
  const lec2 = sec('C', '1', 'TR', 540, 615, { linked: true });
  const labA = sec('C', '1', 'F', 600, 710, { linked: true, type: 'Laboratory', cr: 1 });
  const labB = sec('C', '1', 'M', 540, 650, { linked: true, type: 'Laboratory', cr: 1 }); // clashes with lec1
  const all = [lec1, lec2, labA, labB];
  const allowed = new Set(all.map((s) => s.crn));
  // Without link data: every non-clashing pairing
  let bundles = buildBundles(all, allowed, {});
  assert.equal(bundles.length, 3);
  // With link data: lec2 only goes with labB
  const links = { [lec1.crn]: [[labA.crn]], [lec2.crn]: [[labB.crn]] };
  bundles = buildBundles(all, allowed, links);
  assert.deepEqual(
    bundles.map((b) => b.map((s) => s.crn).sort()).sort(),
    [[lec1.crn, labA.crn].sort(), [lec2.crn, labB.crn].sort()].sort(),
  );
  // If every lab is filtered out, the course can't be satisfied at all
  bundles = buildBundles(all, new Set([lec1.crn, lec2.crn]), {});
  assert.equal(bundles.length, 0);
});

test('optional courses and credit range', () => {
  const req = { key: 'R', sections: [sec('R', '1', 'MWF', 540, 590)] };
  const o1 = { key: 'O1', optional: true, sections: [sec('O', '1', 'TR', 540, 615)] };
  const o2 = { key: 'O2', optional: true, sections: [sec('O', '2', 'TR', 660, 735)] };
  let out = generate(toInput([req, o1, o2]));
  assert.equal(out.total, 4, 'R alone, R+O1, R+O2, R+O1+O2');
  out = generate(toInput([req, o1, o2], { minCredits: 9 }));
  assert.equal(out.total, 1);
  assert.equal(out.results[0].m.credits, 9);
  out = generate(toInput([req, o1, o2], { minCredits: 6, maxCredits: 6 }));
  assert.equal(out.total, 2);
});

test('max classes per day', () => {
  const a = { key: 'A', sections: [sec('A', '1', 'MWF', 660, 710)] }; // 11:00-11:50
  const b = { key: 'B', sections: [sec('B', '1', 'MWF', 720, 770)] }; // 12:00-12:50
  const c = { key: 'C', sections: [sec('C', '1', 'MWF', 780, 830)] }; // 1:00-1:50
  let out = generate(toInput([a, b, c], { maxPerDay: 2 }));
  assert.equal(out.total, 0);
  out = generate(toInput([a, b, c], { maxPerDay: 3 }));
  assert.equal(out.total, 1);
});

test('diagnosis names the clashing pair', () => {
  const out = generate(
    toInput([
      { key: 'A 1', sections: [sec('A', '1', 'MWF', 540, 590)] },
      { key: 'B 1', sections: [sec('B', '1', 'MWF', 540, 590)] },
      { key: 'C 1', sections: [sec('C', '1', 'TR', 540, 590)] },
    ]),
  );
  assert.equal(out.total, 0);
  assert.deepEqual(out.diag.pairs, [['A 1', 'B 1']]);
});

test('combinatorics: counts every combination', () => {
  const mk = (subj, day) =>
    Array.from({ length: 6 }, (_, i) => sec(subj, '1', day, 480 + i * 75, 480 + i * 75 + 60));
  const out = generate(
    toInput([
      { key: 'A', sections: mk('A', 'M') },
      { key: 'B', sections: mk('B', 'T') },
      { key: 'C', sections: mk('C', 'W') },
      { key: 'D', sections: mk('D', 'R') },
    ]),
  );
  assert.equal(out.total, 6 ** 4);
});

test('sorting by fewest days and start later', () => {
  const a = { key: 'A', sections: [sec('A', '1', 'MWF', 480, 530), sec('A', '1', 'TR', 600, 675)] };
  const out = generate(toInput([a]));
  const byDays = [...out.results].sort(comparator('days'));
  assert.equal(byDays[0].m.days, 2);
  const byLate = [...out.results].sort(comparator('late'));
  assert.equal(byLate[0].m.start, 600);
});

test('gaps ignore passing time and count real downtime', () => {
  const m = measure(
    [
      { secs: [], m: meetingsOf(sec('A', '1', 'M', 540, 590)), cr: 3 },
      { secs: [], m: meetingsOf(sec('B', '1', 'M', 600, 650)), cr: 3 },
      { secs: [], m: meetingsOf(sec('C', '1', 'M', 780, 830)), cr: 3 },
    ],
    [],
  );
  assert.equal(m.gaps, 130); // 10-min passing gap ignored, 10:50 -> 1:00 counted
  assert.equal(m.days, 1);
  assert.equal(m.maxDay, 3);
});

test('Banner normalisation', () => {
  const raw = {
    courseReferenceNumber: 12345,
    subject: 'ITSC',
    courseNumber: '2214',
    sequenceNumber: '001',
    courseTitle: 'Data Structures &amp; Algorithms',
    scheduleTypeDescription: 'Lecture',
    creditHours: null,
    creditHourLow: 3,
    campusDescription: 'Main Campus',
    instructionalMethodDescription: 'Face-to-Face',
    maximumEnrollment: 40,
    enrollment: 38,
    seatsAvailable: 2,
    waitCapacity: 0,
    waitCount: 0,
    openSection: true,
    isSectionLinked: false,
    faculty: [
      { displayName: 'Doe, Jane', primaryIndicator: false },
      { displayName: 'Wilson, Dale-Marie', primaryIndicator: true },
    ],
    meetingsFaculty: [
      { meetingTime: { monday: true, wednesday: true, beginTime: '0830', endTime: '0945', buildingDescription: 'Woodward Hall', room: '106', startDate: '01/11/2027', endDate: '05/05/2027' } },
      { meetingTime: { monday: true, wednesday: true, beginTime: '0830', endTime: '0945', buildingDescription: 'Woodward Hall', room: '106', startDate: '01/11/2027', endDate: '05/05/2027' } },
    ],
  };
  const s = normalizeSection(raw);
  assert.equal(s.crn, '12345');
  assert.equal(s.title, 'Data Structures & Algorithms');
  assert.equal(s.cr, 3);
  assert.deepEqual(s.inst, ['Dale-Marie Wilson', 'Jane Doe']);
  assert.equal(s.mt.length, 1, 'duplicate meeting rows collapse');
  assert.deepEqual(s.mt[0], { d: 'MW', s: 510, e: 585, b: 'Woodward Hall', bc: null, r: '106', sd: '2027-01-11', ed: '2027-05-05', t: null });
  assert.equal(toFirstLast('Nadia Najjar'), 'Nadia Najjar');
});

test('description / prerequisite / linked-section parsing', () => {
  const desc = '<section aria-labelledby="courseDescription"><h3>Course Description:</h3> Covers lists, trees &amp; graphs.<br/></section>';
  assert.equal(parseDescriptionHtml(desc), 'Covers lists, trees & graphs.');
  const prereq = `<table><thead><tr><th>And/Or</th></tr></thead><tbody>
    <tr><td></td><td>(</td><td></td><td></td><td>Computer Science</td><td>1213</td><td>Undergraduate</td><td>C</td><td></td></tr>
    <tr><td>Or</td><td></td><td></td><td></td><td>Computer Science</td><td>1214</td><td>Undergraduate</td><td>C</td><td>)</td></tr>
    <tr><td>And</td><td></td><td></td><td></td><td>Mathematics</td><td>1241</td><td>Undergraduate</td><td>C</td><td></td></tr>
  </tbody></table>`;
  assert.deepEqual(parsePrereqHtml(prereq), [
    ['Computer Science 1213 (min grade C)', 'Computer Science 1214 (min grade C)'],
    ['Mathematics 1241 (min grade C)'],
  ]);
  assert.deepEqual(parseLinkedReply({ linkedData: [[{ courseReferenceNumber: '2' }], [{ courseReferenceNumber: 3 }, { courseReferenceNumber: '4' }]] }), [['2'], ['3', '4']]);
});

test('a realistic term generates schedules end to end', () => {
  // A small term shaped like the scraped data: a linked lecture + lab course, an online section with no
  // meeting time, and a few ordinary lectures
  const lecA = sec('ITSC', '1213', 'MW', 600, 675, { linked: true });
  const lecB = sec('ITSC', '1213', 'TR', 840, 915, { linked: true });
  const labs = [
    sec('ITSC', '1213', 'F', 540, 650, { linked: true, type: 'Laboratory', cr: 0 }),
    sec('ITSC', '1213', 'W', 780, 890, { linked: true, type: 'Laboratory', cr: 0 }),
    sec('ITSC', '1213', 'R', 600, 710, { linked: true, type: 'Laboratory', cr: 0 }),
  ];
  const links = { [lecA.crn]: [[labs[0].crn, labs[1].crn]], [lecB.crn]: [[labs[2].crn]] };
  const defs = [
    { key: 'ITSC 1213', sections: [lecA, lecB, ...labs], links },
    { key: 'MATH 1242', sections: [sec('MATH', '1242', 'MWF', 540, 590), sec('MATH', '1242', 'TR', 600, 675), sec('MATH', '1242', 'MW', 780, 855)] },
    { key: 'COMM 1101', sections: [sec('COMM', '1101', '', null, null, { method: 'Online' }), sec('COMM', '1101', 'TR', 780, 855)] },
    { key: 'PSYC 1101', sections: [sec('PSYC', '1101', 'MWF', 660, 710), sec('PSYC', '1101', 'TR', 840, 915)] },
  ];
  const allCrns = new Set(defs.flatMap((d) => d.sections.map((s) => s.crn)));
  const input = toInput(defs);
  const out = generate(input);
  assert.ok(out.total > 0, `expected schedules, got ${out.total}`);
  const labCrns = new Set(labs.map((s) => s.crn));
  for (const r of out.results) {
    assert.equal(r.pick.length, 4);
    assert.ok(r.pick.every((bi) => bi >= 0), 'every required course is in every schedule');
    // the linked course always contributes a lecture plus a lab
    assert.equal(input.courses[0].bundles[r.pick[0]].secs.length, 2);
  }
  // each bundle is one lecture with one of its own linked labs (lecture B only goes with the Thursday lab)
  for (const b of buildBundles([lecA, lecB, ...labs], allCrns, links)) {
    const crns = b.map((s) => s.crn);
    assert.equal(crns.filter((c) => labCrns.has(c)).length, 1);
    if (crns.includes(lecB.crn)) assert.deepEqual(crns.filter((c) => labCrns.has(c)), [labs[2].crn]);
  }
});

test('after the cap, each sort still finds its true best schedules', () => {
  const mk = (subj, n) =>
    Array.from({ length: n }, (_, i) => sec(subj, '1', ['M', 'T', 'W', 'R', 'F'][i % 5] + (i % 3 ? 'W' : ''), 480 + (i % 7) * 75, 480 + (i % 7) * 75 + 50, { seats: (i * 7) % 13, b: 'B' + (i % 4) }));
  const input = toInput([
    { key: 'A', sections: mk('A', 9) },
    { key: 'B', sections: mk('B', 8) },
    { key: 'C', sections: mk('C', 7) },
    { key: 'D', sections: mk('D', 6) },
  ]);
  const full = generate({ ...input, cap: 1e9 });
  const small = generate({ ...input, cap: 50, keepPerSort: 25 });
  assert.equal(small.total, full.total);
  assert.ok(small.trimmed);
  for (const s of ['balanced', 'days', 'gaps', 'late', 'early']) {
    const cmp = comparator(s);
    const best = [...full.results].sort(cmp).slice(0, 25);
    const got = [...small.results].sort(cmp).slice(0, 25);
    assert.deepEqual(got.map((r) => cmp(r, best[24]) <= 0), Array(25).fill(true), `sort ${s}`);
    assert.equal(cmp(got[0], best[0]), 0, `top pick for ${s}`);
  }
});

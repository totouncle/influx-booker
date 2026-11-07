import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LATE_CATCHUP_MS, addDays, calendarJobs, executeBooking, findSession, makeJob, notify, openingInstant, prepareBooking } from '../lib/booker.js';
import { isReady, reconcile, runTitle } from '../dispatch.js';

const schedule = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url)));
const job = makeJob(schedule, '2026-11-09', 2, 1);
const session = (booked = false) => ({ id: 123, name: 'Pilates ', start_date: '2026-11-17T09:30:00', instructors: [{ full_name: 'Grace' }], visit: booked ? { state: 'booked' } : null });
function rig(start = job.openAt - 30_000, responder = () => ({ body: { visit: { state: 'booked' } } })) {
  let clock = start;
  const requests = [], events = [];
  return {
    requests, events, now: () => clock, sleep: async ms => { clock += ms; }, log: e => events.push(e),
    fetch: async (url, opts) => {
      const record = { url, method: opts.method, at: clock }; requests.push(record);
      const response = await responder(record, requests.length);
      if (response.error) throw response.error;
      return { ok: (response.status || 200) < 400, status: response.status || 200, text: async () => JSON.stringify(response.body), json: async () => response.body, headers: new Headers(response.headers || {}) };
    },
  };
}
const prepared = (extra = {}) => ({ job, success: true, ready: true, session: { id: 123, booked: false }, ...extra });

test('Auckland summer and winter openings use the correct offsets', () => {
  assert.equal(new Date(openingInstant('2026-11-07', '08:00')).toISOString(), '2026-11-06T19:00:00.000Z');
  assert.equal(new Date(openingInstant('2026-07-04', '08:00')).toISOString(), '2026-07-03T20:00:00.000Z');
  assert.equal(new Date(openingInstant('2026-09-27', '08:00')).toISOString(), '2026-09-26T19:00:00.000Z');
  assert.throws(() => openingInstant('2026-09-27', '02:30'));
  assert.throws(() => openingInstant('2026-02-30', '08:00'));
});
test('calendar date addition preserves the eight-day contract across DST', () => {
  assert.equal(addDays('2026-09-20', 8), '2026-09-28');
  assert.equal(addDays('2026-04-01', 8), '2026-04-09');
});
test('all ten weekly entries dispatch thirty minutes before opening in both seasons', () => {
  for (const first of ['2026-11-08', '2026-07-05']) {
    for (let day = 0; day < 7; day++) {
      const date = addDays(first, day);
      schedule.forEach((target, index) => {
        if (target.dayOfWeek === day) for (const account of target.accountIndices) {
          const j = makeJob(schedule, date, index, account);
          assert.equal(j.openAt - j.dispatchAt, 30 * 60_000);
          assert.equal(j.targetDate, addDays(date, 8));
        }
      });
    }
  }
});
test('account and weekday mismatches fail closed', () => {
  assert.throws(() => makeJob(schedule, '2026-11-09', 2, 0));
  assert.throws(() => makeJob(schedule, '2026-11-10', 2, 1));
  assert.throws(() => makeJob(schedule, '2026-11-09', '-1', 1));
});
test('late jobs retain their original opening day and class date after midnight', () => {
  const yesterday = calendarJobs(schedule, Date.parse('2026-11-09T11:30:00Z')).find(j => j.id === '2026-11-09-3-0');
  assert.ok(yesterday);
  assert.equal(yesterday.targetDate, '2026-11-17');
});
test('trailing spaces and the existing instructor fallback are preserved', () => {
  assert.equal(findSession([session()], job.target).id, 123);
  assert.equal(findSession([{ ...session(), instructors: [] }], job.target).id, 123);
  assert.throws(() => findSession({}, job.target));
});
test('preparation and check paths only perform GET and never persist tokens', async () => {
  const r = rig(job.openAt - 60_000, () => ({ body: [session()] }));
  const result = await prepareBooking(job, 'DO-NOT-PERSIST', r);
  assert.equal(result.ready, true);
  assert.deepEqual(r.requests.map(x => x.method), ['GET']);
  assert.ok(!JSON.stringify([result, r.events]).includes('DO-NOT-PERSIST'));
});
test('missing session can be resolved when the service publishes it at opening', async () => {
  const r = rig(job.openAt - 1000, request => ({ body: request.method === 'GET' ? [session()] : { visit: { state: 'booked' } } }));
  const result = await executeBooking(prepared({ ready: false, session: null }), 'token', r);
  assert.equal(result.success, true);
  assert.equal(r.requests.find(x => x.method === 'POST').at, job.openAt);
});
test('prefetch happens before opening and first POST has no fixed five-second delay', async () => {
  const r = rig(job.openAt - 60_000, request => ({ body: request.method === 'GET' ? [session()] : { visit: { state: 'booked' } } }));
  const result = await executeBooking(prepared(), 'token', r);
  assert.equal(result.success, true);
  assert.equal(r.requests[0].at, job.openAt - 10_000);
  assert.equal(r.requests.find(x => x.method === 'POST').at, job.openAt);
  assert.equal(result.requestDelayMs, 0);
});
test('known booked visits never produce another POST', async () => {
  const r = rig();
  const result = await executeBooking(prepared({ session: { id: 123, booked: true } }), 'token', r);
  assert.equal(result.alreadyBooked, true);
  assert.equal(result.firstRequestAt, null);
  assert.equal(r.requests.length, 0);
});
test('manual booking during the waiting period is respected', async () => {
  const r = rig(job.openAt - 60_000, () => ({ body: [session(true)] }));
  const result = await executeBooking(prepared(), 'token', r);
  assert.equal(result.alreadyBooked, true);
  assert.ok(r.requests.every(x => x.method === 'GET'));
});
test('a delayed runner fails visibly after the allowed opening window', async () => {
  const r = rig(job.openAt + LATE_CATCHUP_MS + 1);
  const result = await executeBooking(prepared(), 'token', r);
  assert.equal(result.success, false);
  assert.equal(result.reason, 'missed_opening');
  assert.equal(r.requests.length, 0);
});
test('late recovery is retained but cannot be mistaken for an on-time reservation', async () => {
  const r = rig(job.openAt + 120_000);
  const result = await executeBooking(prepared(), 'token', r);
  assert.equal(result.success, true);
  assert.equal(result.late, true);
  assert.equal(result.requestDelayMs, 120_000);
  assert.ok(r.events.some(e => e.event === 'late_start'));
});
test('an uncertain write with an unbooked readback is not blindly resubmitted', async () => {
  const r = rig(job.openAt, request => request.method === 'POST' ? { error: Error('offline') } : { body: [session()] });
  const result = await executeBooking(prepared(), 'token', r);
  assert.equal(result.reason, 'write_unconfirmed');
  assert.deepEqual(r.requests.map(x => x.method), ['POST', 'GET']);
});
test('explicit not-open responses retry, while an unrelated 403 stops', async () => {
  let posts = 0;
  const r = rig(job.openAt, request => {
    if (request.method === 'GET') return { body: [session()] };
    return ++posts === 1 ? { status: 403, body: { message: 'Bookings not yet open' } } : { body: { visit: { state: 'booked' } } };
  });
  assert.equal((await executeBooking(prepared(), 'token', r)).success, true);
  assert.equal(posts, 2);
  const forbidden = rig(job.openAt, () => ({ status: 403, body: { message: 'Membership suspended' } }));
  assert.equal((await executeBooking(prepared(), 'token', forbidden)).reason, '403');
  assert.equal(forbidden.requests.length, 1);
});
test('ambiguous POST is verified before another write; verification failure stops retries', async () => {
  const confirmed = rig(job.openAt, request => request.method === 'POST' ? { error: Error('lost response') } : { body: [session(true)] });
  assert.equal((await executeBooking(prepared(), 'token', confirmed)).success, true);
  assert.deepEqual(confirmed.requests.map(x => x.method), ['POST', 'GET']);
  const unknown = rig(job.openAt, () => ({ error: Error('offline') }));
  assert.equal((await executeBooking(prepared(), 'token', unknown)).reason, 'verification_failed');
  assert.deepEqual(unknown.requests.map(x => x.method), ['POST', 'GET']);
});
test('rate-limit Retry-After is respected', async () => {
  let posts = 0;
  const r = rig(job.openAt, request => request.method === 'GET' ? { body: [session()] } : ++posts === 1 ? { status: 429, headers: { 'retry-after': '2' }, body: {} } : { body: { visit: { state: 'booked' } } });
  assert.equal((await executeBooking(prepared(), 'token', r)).success, true);
  const postTimes = r.requests.filter(x => x.method === 'POST').map(x => x.at);
  assert.ok(postTimes[1] - postTimes[0] >= 2000);
});
test('persistent refusal is bounded and never loops indefinitely', async () => {
  const r = rig(job.openAt, request => request.method === 'GET' ? { body: [session()] } : { status: 409, body: { message: 'Bookings not open' } });
  assert.equal((await executeBooking(prepared(), 'token', r)).success, false);
  assert.equal(r.requests.filter(x => x.method === 'POST').length, 8);
});
test('an invalid account does not prevent another account from preparing', async () => {
  const valid = rig(job.openAt, () => ({ body: [session()] }));
  const invalid = rig(job.openAt, () => ({ status: 401, body: {} }));
  const results = await Promise.all([prepareBooking(job, 'bad', invalid), prepareBooking(job, 'good', valid)]);
  assert.equal(results[0].success, false);
  assert.equal(results[1].success, true);
});
test('dispatcher persists future jobs and retains overdue jobs after restart', () => {
  const state = {};
  reconcile(state, [job], job.dispatchAt - 1000);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(reconcile(restored, [], job.openAt + 3_600_000)[0].job.id, job.id);
  assert.equal(reconcile({}, [job], job.openAt + 3_600_000).length, 0);
});
test('dispatcher readiness requires the actual successful ready step', () => {
  assert.equal(isReady([{ steps: [{ name: 'Prepare booking', conclusion: 'success' }] }]), false);
  assert.equal(isReady([{ steps: [{ name: 'Ready to book', conclusion: 'skipped' }] }]), false);
  assert.equal(isReady([{ steps: [{ name: 'Ready to book', conclusion: 'success' }] }]), true);
  assert.equal(runTitle(job.id), `Influx ${job.id}`);
});
test('notification errors do not expose credential-bearing URLs', async () => {
  const r = rig(job.openAt, () => ({ error: Error('https://api.telegram.org/botSECRET') }));
  await notify({ job, success: false, reason: '401' }, { TELEGRAM_BOT_TOKEN: 'SECRET', TELEGRAM_CHAT_ID: 'test' }, r);
  assert.ok(!JSON.stringify(r.events).includes('SECRET'));
});

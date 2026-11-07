export const TIME_ZONE = 'Pacific/Auckland';
export const ACCOUNT_NAMES = ['Kibum', 'Haejin'];
export const PREPARE_LEAD_MS = 30 * 60_000;
export const BOOKING_GRACE_MS = 60_000;
// Preserve the existing late-recovery allowance, but record lateness explicitly.
export const LATE_CATCHUP_MS = 6 * 60 * 60_000;
const BASE_URL = 'https://influxapp.com';
const nzFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function nzParts(ms) {
  return Object.fromEntries(nzFormatter.formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}
export function nzDate(ms) {
  const p = nzParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
export function addDays(date, count) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + count * 86_400_000).toISOString().slice(0, 10);
}
export function openingInstant(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) throw new Error('Invalid opening date/time');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const p = nzParts(guess);
    const correction = wall - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += correction;
    if (!correction) break;
  }
  const p = nzParts(guess);
  if (p.year !== year || p.month !== month || p.day !== day || p.hour !== hour || p.minute !== minute) throw new Error('Opening time does not exist in Auckland');
  return guess;
}
export function makeJob(schedule, date, targetIndex, accountIndex) {
  if (!/^\d+$/.test(String(targetIndex)) || !/^[01]$/.test(String(accountIndex))) throw new Error('Invalid target/account index');
  const target = schedule[Number(targetIndex)];
  const openAt = openingInstant(date, target?.time);
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (target.dayOfWeek !== day || !target.accountIndices.includes(Number(accountIndex))) throw new Error('Date/account does not match schedule');
  return {
    id: `${date}-${targetIndex}-${accountIndex}`, openingDate: date,
    targetIndex: Number(targetIndex), accountIndex: Number(accountIndex),
    account: ACCOUNT_NAMES[Number(accountIndex)], target: { ...target },
    targetDate: addDays(date, 8), openAt, dispatchAt: openAt - PREPARE_LEAD_MS,
  };
}
export function calendarJobs(schedule, now) {
  const today = nzDate(now);
  return [-1, 0, 1].flatMap(offset => {
    const date = addDays(today, offset);
    const day = new Date(`${date}T12:00:00Z`).getUTCDay();
    return schedule.flatMap((t, i) => t.dayOfWeek === day ? t.accountIndices.map(a => makeJob(schedule, date, i, a)) : []);
  }).sort((a, b) => a.openAt - b.openAt);
}
export function findSession(sessions, target) {
  if (!Array.isArray(sessions)) throw Object.assign(new Error('Invalid sessions response'), { code: 'invalid_response' });
  const matches = sessions.filter(s => typeof s.name === 'string' && s.name.trim() === target.className && s.start_date?.slice(11, 16) === target.time);
  return matches.find(s => s.instructors?.some(i => i.full_name?.startsWith(target.instructor))) || matches[0] || null;
}
function dependencies(overrides = {}) {
  return { now: Date.now, sleep: ms => new Promise(r => setTimeout(r, ms)), fetch: globalThis.fetch, log: () => {}, ...overrides };
}
function event(d, job, name, fields = {}) {
  d.log({ event: name, jobId: job.id, account: job.account, at: new Date(d.now()).toISOString(), scheduledOpenAt: new Date(job.openAt).toISOString(), ...fields });
}
async function waitUntil(time, d) {
  while (d.now() < time) await d.sleep(Math.min(time - d.now(), time - d.now() < 1_000 ? 20 : 1_000));
}
function headers(token, facility) {
  return { 'Content-Type': 'application/json', Accept: 'application/json', 'x-app-uid': 'influx.app', 'club-id': facility, 'facility-id': facility, Cookie: `_aatk=${token}` };
}
export async function request(job, token, path, method, d) {
  let response;
  try {
    response = await d.fetch(`${BASE_URL}${path}`, { method, headers: headers(token, job.target.facilityGuid), signal: AbortSignal.timeout(4_000) });
  } catch { throw Object.assign(new Error('Request failed'), { code: 'network_error' }); }
  let text;
  try { text = await response.text(); }
  catch { throw Object.assign(new Error('Response interrupted'), { code: 'network_error' }); }
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : '';
    const notOpen = [400, 403, 409, 422].includes(response.status) && /not\s+(?:yet\s+)?open|too early|booking(?:s)? (?:will )?open|booking.*not.*started|cannot book (?:this session )?(?:before|until)|bookable from/i.test(message);
    const full = [400, 403, 409, 422].includes(response.status) && /\bfull\b|capacity reached/i.test(message);
    const retryHeader = response.headers?.get('retry-after');
    let retryAfterMs = Number(retryHeader) * 1000;
    if (retryHeader && !Number.isFinite(retryAfterMs)) retryAfterMs = Math.max(0, Date.parse(retryHeader) - d.now());
    throw Object.assign(new Error(`HTTP ${response.status}`), {
      code: notOpen ? 'not_open' : full ? 'full' : String(response.status), status: response.status,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    });
  }
  return body;
}
const sessionPath = job => `/api/v1/sessions?from=${job.targetDate}T00:00:00&to=${job.targetDate}T23:59:59`;
async function getSession(job, token, d) { return findSession(await request(job, token, sessionPath(job), 'GET', d), job.target); }
function snapshot(session) { return session ? { id: session.id, booked: session.visit?.state === 'booked', full: session.full === true } : null; }

export async function prepareBooking(job, token, overrides = {}) {
  const d = dependencies(overrides);
  if (!token) {
    event(d, job, 'preparation_failed', { reason: 'no_token' });
    return { job, success: false, ready: false, reason: 'no_token' };
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const session = await getSession(job, token, d);
      const result = { job, success: true, ready: Boolean(session?.id), session: snapshot(session), preparedAt: d.now() };
      event(d, job, result.ready ? 'prepared' : 'session_not_listed', { sessionId: session?.id ?? null, alreadyBooked: result.session?.booked || false });
      return result;
    } catch (err) {
      if (err.code === 'not_open') return { job, success: true, ready: false, session: null, preparedAt: d.now() };
      if (attempt < 3 && (err.code === 'network_error' || err.status >= 500 || err.status === 429)) { await d.sleep(Math.max(1_000, err.retryAfterMs || 0)); continue; }
      event(d, job, 'preparation_failed', { reason: err.code || 'invalid_response' });
      return { job, success: false, ready: false, reason: err.code || 'invalid_response' };
    }
  }
}

export async function executeBooking(prepared, token, overrides = {}) {
  const d = dependencies(overrides);
  const { job } = prepared;
  let session = prepared.session;
  let firstRequestAt = null;
  const deadline = Math.min(Math.max(job.openAt, d.now()) + BOOKING_GRACE_MS, job.openAt + LATE_CATCHUP_MS);
  const finish = (success, reason, alreadyBooked = false) => {
    const result = { job, success, reason, alreadyBooked, firstRequestAt,
      requestDelayMs: firstRequestAt === null ? null : firstRequestAt - job.openAt,
      late: firstRequestAt !== null && firstRequestAt - job.openAt > 1_000,
      confirmedAt: success ? d.now() : null, finishedAt: d.now() };
    event(d, job, success ? 'confirmed' : 'booking_failed', { reason, alreadyBooked, firstRequestAt: firstRequestAt === null ? null : new Date(firstRequestAt).toISOString(), requestDelayMs: result.requestDelayMs });
    return result;
  };
  if (!token || !prepared.success) return finish(false, prepared.reason || 'no_token');
  if (session?.booked) return finish(true, 'already_booked', true);
  if (d.now() > job.openAt + LATE_CATCHUP_MS) return finish(false, 'missed_opening');
  if (d.now() > job.openAt + 1_000) event(d, job, 'late_start', { delayMs: d.now() - job.openAt });
  if (d.now() < job.openAt - 10_000) {
    await waitUntil(job.openAt - 10_000, d);
    try { session = snapshot(await getSession(job, token, d)) || session; }
    catch (err) {
      event(d, job, 'refresh_failed', { reason: err.code || 'invalid_response' });
      if (err.status === 401 || (err.status === 403 && err.code !== 'not_open')) return finish(false, err.code);
    }
    if (session?.booked) return finish(true, 'already_booked', true);
  }
  await waitUntil(job.openAt, d);
  let reason = 'unconfirmed';
  for (let attempt = 1; attempt <= 8 && d.now() <= deadline; attempt++) {
    let ambiguousWrite = false;
    let alreadyDelayed = false;
    try {
      if (!session?.id) {
        session = snapshot(await getSession(job, token, d));
        if (session?.booked) return finish(true, 'already_booked', true);
        if (!session?.id) { reason = 'not_found'; await d.sleep(750); continue; }
      }
      if (firstRequestAt === null) firstRequestAt = d.now();
      event(d, job, 'booking_request', { attempt, sessionId: session.id, delayMs: d.now() - job.openAt });
      const body = await request(job, token, `/api/v1/sessions/${encodeURIComponent(session.id)}/book`, 'POST', d);
      if (body?.visit?.state === 'booked') return finish(true, 'booked');
      reason = 'unconfirmed';
      ambiguousWrite = true;
    } catch (err) {
      reason = err.code || 'invalid_response';
      event(d, job, 'request_failed', { attempt, reason });
      if (!['not_open', 'network_error'].includes(reason) && err.status !== 429 && !(err.status >= 500)) return finish(false, reason);
      ambiguousWrite = reason === 'network_error' || err.status >= 500;
      const delay = Math.max(reason === 'not_open' ? 500 : 1_000, err.retryAfterMs || 0);
      if (d.now() + delay > deadline) break;
      await d.sleep(delay);
      alreadyDelayed = true;
    }
    // Read back any ambiguous POST before considering another write.
    try {
      const current = snapshot(await getSession(job, token, d));
      if (current?.booked) return finish(true, 'booked');
      if (current?.full) return finish(false, 'full');
      if (current) session = current;
    } catch (err) { return finish(false, err.status === 401 ? '401' : 'verification_failed'); }
    if (ambiguousWrite) return finish(false, 'write_unconfirmed');
    if (attempt < 8 && !alreadyDelayed) await d.sleep(750);
  }
  return finish(false, reason);
}

export async function notify(result, env, overrides = {}) {
  const d = dependencies(overrides);
  const { job } = result;
  const localTime = ms => ms == null ? '없음' : new Intl.DateTimeFormat('ko-KR', { timeZone: TIME_ZONE, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms);
  const text = `${result.success ? result.late ? '⚠️ 지연 예약 완료' : '✅' : '❌'} Influx ${job.account}: ${job.targetDate} ${job.target.className} ${job.target.time}\n상태: ${result.reason}\n뉴질랜드 오픈: ${localTime(job.openAt)}\n최초 요청: ${localTime(result.firstRequestAt)} / 예약 확인: ${localTime(result.confirmedAt)}\n요청 지연: ${result.requestDelayMs == null ? '요청 없음' : result.requestDelayMs + 'ms'}`;
  const destinations = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) destinations.push(['telegram', `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {}, { chat_id: env.TELEGRAM_CHAT_ID, text }]);
  if (env.SLACK_BOT_TOKEN) destinations.push(['slack', 'https://slack.com/api/chat.postMessage', { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }, { channel: 'C0AND38JT2M', text }]);
  for (const [name, url, extraHeaders, body] of destinations) {
    try {
      const response = await d.fetch(url, { method: 'POST', signal: AbortSignal.timeout(5_000), headers: { 'Content-Type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });
      const payload = await response.json();
      event(d, job, response.ok && payload.ok ? 'notification_sent' : 'notification_failed', { destination: name });
    } catch { event(d, job, 'notification_failed', { destination: name }); }
  }
  if (!destinations.length) event(d, job, 'notification_unconfigured');
}

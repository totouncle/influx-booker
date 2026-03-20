import { readFileSync } from 'fs';

// ── 설정 ─────────────────────────────────────────────────────────────────────

const ACCOUNTS = [
  { label: '계정1', token: process.env.INFLUX_TOKEN_1 },
  { label: '계정2', token: process.env.INFLUX_TOKEN_2 },
];

const BASE_URL = 'https://influxapp.com';
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
const OPEN_WINDOW_MS = 15 * 60 * 1000; // 15분
const OPEN_OFFSET_MS = 5 * 1000;        // 오픈 후 5초
const POLL_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeHeaders(token, facilityGuid) {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/plain, */*',
    'x-app-uid': 'influx.app',
    'club-id': facilityGuid,
    'facility-id': facilityGuid,
    'Cookie': `_aatk=${token}`,
  };
}

/** YYYY-MM-DD 형식으로 NZT 기준 날짜 반환 (TZ=Pacific/Auckland 가정) */
function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** NZT 기준 현재 요일 (0=일, 1=월, ..., 6=토) */
function getNZTDayOfWeek() {
  return new Date().getDay();
}

/** NZT 기준 오늘부터 N일 후의 Date 객체 */
function addDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 타겟 날짜(NZT)의 특정 시각(HH:MM)에 대응하는 UTC 타임스탬프(ms) 반환.
 * TZ=Pacific/Auckland 환경에서 new Date('YYYY-MM-DDTHH:MM:00')는 로컬(NZT) 기준으로 파싱됨.
 */
function buildOpenTime(targetDate, timeStr) {
  const dateStr = toDateStr(targetDate);
  return new Date(`${dateStr}T${timeStr}:00`).getTime();
}

// ── API 호출 ──────────────────────────────────────────────────────────────────

async function fetchSessions(token, facilityGuid, date) {
  const dateStr = toDateStr(date);
  const url = `${BASE_URL}/api/v1/sessions?from=${dateStr}T00:00:00&to=${dateStr}T23:59:59`;
  const res = await fetch(url, { headers: makeHeaders(token, facilityGuid) });
  if (!res.ok) {
    const err = new Error(`fetchSessions HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function bookSession(token, facilityGuid, sessionId) {
  const url = `${BASE_URL}/api/v1/sessions/${sessionId}/book`;
  const res = await fetch(url, {
    method: 'POST',
    headers: makeHeaders(token, facilityGuid),
  });
  if (!res.ok) {
    const err = new Error(`bookSession HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // 응답 바디가 없을 수도 있음
  const text = await res.text();
  try { return JSON.parse(text); } catch { return null; }
}

// ── 세션 매칭 ─────────────────────────────────────────────────────────────────

function sessionTime(session) {
  // "2026-03-28T19:30:00" → "19:30"
  return session.start_date.slice(11, 16);
}

function findSession(sessions, target) {
  // 완전 매칭: className + time + instructor
  const full = sessions.find(s =>
    s.name === target.className &&
    sessionTime(s) === target.time &&
    s.instructors?.some(i => i.full_name.startsWith(target.instructor))
  );
  if (full) return full;

  // fallback: className + time
  return sessions.find(s =>
    s.name === target.className &&
    sessionTime(s) === target.time
  ) ?? null;
}

// ── 계정별 예약 ───────────────────────────────────────────────────────────────

async function bookForAccount(account, target, targetDate) {
  const { label, token } = account;
  const { facilityGuid, className, time } = target;
  const tag = `[${label}] ${className} ${time}`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let sessions;
    try {
      sessions = await fetchSessions(token, facilityGuid, targetDate);
    } catch (err) {
      if (err.status === 401) {
        console.error(`${tag} → ❌ 401 Unauthorized - 토큰 만료`);
        return { success: false, reason: '401' };
      }
      console.error(`${tag} fetchSessions 실패 (시도 ${attempt}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      continue;
    }

    const session = findSession(sessions, target);
    if (!session) {
      console.error(`${tag} → ❌ 세션을 찾을 수 없음`);
      return { success: false, reason: 'not_found' };
    }

    // 이미 예약됨
    if (session.visit?.state === 'booked') {
      console.log(`${tag} → ✅ 이미 예약됨 (session: ${session.id})`);
      return { success: true, sessionId: session.id };
    }

    // 정원 초과 처리
    if (session.full) {
      if (attempt === 1) {
        console.log(`${tag} → 정원 초과. 5초 후 재확인...`);
        await sleep(5000);
        attempt--; // 카운트 소진 없이 재확인
        continue;
      }
      console.error(`${tag} → ❌ FULL after ${attempt} attempts`);
      return { success: false, reason: 'full' };
    }

    // 예약 시도
    let bookResult;
    try {
      bookResult = await bookSession(token, facilityGuid, session.id);
    } catch (err) {
      if (err.status === 401) {
        console.error(`${tag} → ❌ 401 Unauthorized - 토큰 만료`);
        return { success: false, reason: '401' };
      }
      if (err.status === 404) {
        console.error(`${tag} → ❌ 404 세션 없음`);
        return { success: false, reason: 'not_found' };
      }
      const delay = err.status === 429 ? 2000 : RETRY_DELAY_MS;
      console.error(`${tag} book 실패 (시도 ${attempt}): ${err.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(delay);
      continue;
    }

    // 상태 확인: 응답에서 바로 확인
    if (bookResult?.visit?.state === 'booked') {
      console.log(`${tag} → ✅ booked (session: ${session.id})`);
      return { success: true, sessionId: session.id };
    }

    // 응답에서 확인 불가 → 세션 재조회
    try {
      const refreshed = await fetchSessions(token, facilityGuid, targetDate);
      const s = findSession(refreshed, target);
      if (s?.visit?.state === 'booked') {
        console.log(`${tag} → ✅ booked (session: ${s.id})`);
        return { success: true, sessionId: s.id };
      }
    } catch { /* 무시, 재시도 */ }

    console.log(`${tag} book 후 상태 미확인, 재시도 (${attempt}/${MAX_ATTEMPTS})`);
    if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }

  console.error(`${tag} → ❌ ${MAX_ATTEMPTS}회 시도 후 실패`);
  return { success: false, reason: 'max_attempts' };
}

// ── Phase 0: 사전 검증 ────────────────────────────────────────────────────────

async function validateTokens() {
  const today = new Date();
  // 임시 facilityGuid (검증용이므로 아무 것이나 사용)
  const dummyGuid = '7928ecb5-f001-4660-adc7-9eb3e36198ee';

  for (const account of ACCOUNTS) {
    if (!account.token) {
      console.error(`${account.label} 토큰이 환경변수에 없음`);
      process.exit(1);
    }
    try {
      await fetchSessions(account.token, dummyGuid, today);
      console.log(`${account.label} 토큰 유효`);
    } catch (err) {
      console.error(`${account.label} 토큰 검증 실패: ${err.message}`);
      process.exit(1);
    }
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main() {
  // Phase 0: 사전 검증
  console.log('=== Phase 0: 토큰 검증 ===');
  await validateTokens();

  // Phase 1: 타겟 확인
  console.log('=== Phase 1: 타겟 확인 ===');
  const schedule = JSON.parse(readFileSync(new URL('./schedule.json', import.meta.url)));
  const todayDow = getNZTDayOfWeek();
  const todayTargets = schedule.filter(t => t.dayOfWeek === todayDow);

  if (!todayTargets.length) {
    console.log(`오늘(요일 ${todayDow})에 해당하는 타겟 없음. 종료.`);
    process.exit(0);
  }

  const now = Date.now();
  const target = todayTargets.find(t => {
    const openTime = buildOpenTime(new Date(), t.time) + OPEN_OFFSET_MS;
    return (openTime - now) <= OPEN_WINDOW_MS;
  });

  if (!target) {
    const times = todayTargets.map(t => t.time).join(', ');
    console.log(`오늘 타겟(${times}) 중 오픈 15분 이내인 항목 없음. cron 오발동으로 판단, 종료.`);
    process.exit(0);
  }

  console.log(`타겟: ${target.className} (${target.instructor}) ${target.time}`);

  // 예약 오픈 날짜 = 오늘 + 8일
  const targetDate = addDays(8);
  const openTimeMs = buildOpenTime(new Date(), target.time) + OPEN_OFFSET_MS;
  const diffMs = openTimeMs - now;

  if (diffMs <= 0) {
    console.log('오픈 시각이 이미 지남. 즉시 실행 모드.');
  } else {
    console.log(`오픈 시각까지 ${Math.round(diffMs / 1000)}초 대기...`);
  }

  // Phase 2: 대기
  if (diffMs > 0) {
    console.log('=== Phase 2: 대기 ===');
    let lastHeartbeat = Date.now();
    while (Date.now() < openTimeMs) {
      if (Date.now() - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
        const remaining = Math.round((openTimeMs - Date.now()) / 1000);
        console.log(`heartbeat: 오픈까지 ${remaining}초`);
        lastHeartbeat = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
    }
    console.log('오픈 시각 도달.');
  }

  // Phase 3 & 4: 예약 실행 (두 계정 병렬)
  console.log('=== Phase 3: 예약 실행 ===');
  const results = await Promise.all(
    ACCOUNTS.map(account => bookForAccount(account, target, targetDate))
  );

  // Phase 5: 결과 리포트
  console.log('=== Phase 5: 결과 ===');
  const anyFailed = results.some(r => !r.success);
  if (anyFailed) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('예기치 않은 오류:', err);
  process.exit(1);
});

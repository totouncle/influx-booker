import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOOKING_GRACE_MS, LATE_CATCHUP_MS, calendarJobs, TIME_ZONE } from './lib/booker.js';

const REPO = 'totouncle/influx-booker';
export function reconcile(state, jobs, now) {
  state.startedAt ??= now;
  state.records ??= {};
  for (const job of jobs) {
    // First installation must not replay historic reservations or send historic alerts.
    if (!state.records[job.id] && job.openAt >= state.startedAt - BOOKING_GRACE_MS) state.records[job.id] = { job, status: 'waiting', attempts: 0 };
  }
  return Object.values(state.records).filter(r => !['complete', 'missed'].includes(r.status));
}
export function isReady(runJobs) {
  return runJobs.some(j => j.steps?.some(s => s.name === 'Ready to book' && s.conclusion === 'success'));
}
export function runTitle(jobId) { return `Influx ${jobId}`; }

function gh(args, input) {
  return execFileSync(process.env.INFLUX_GH_PATH || 'gh', args, { input, encoding: 'utf8', timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] });
}
function nativeAlert(message) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'on run argv\n display notification (item 1 of argv) with title "Influx Booker"\nend run', message], { timeout: 5_000, stdio: 'ignore' });
  } catch { /* The JSON log remains the durable alert record. */ }
}
function log(event, fields = {}) { console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields })); }

async function main() {
  const mode = process.argv[2] || 'plan';
  if (!['plan', 'once', 'daemon'].includes(mode)) throw new Error('Use plan, once, or daemon');
  const schedule = JSON.parse(readFileSync(new URL('./schedule.json', import.meta.url)));
  if (mode === 'plan') {
    const now = Date.now();
    console.log(JSON.stringify({ timeZone: TIME_ZONE, jobs: calendarJobs(schedule, now).filter(j => j.openAt >= now).map(j => ({ id: j.id, account: j.account, class: j.target.className, targetDate: j.targetDate, openAt: new Date(j.openAt).toISOString(), dispatchAt: new Date(j.dispatchAt).toISOString() })) }, null, 2));
    return;
  }
  const stateDir = process.env.INFLUX_STATE_DIR || join(homedir(), 'Library', 'Application Support', 'InfluxBooker');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(stateDir, 'dispatcher-state.json');
  const lockPath = join(stateDir, 'dispatcher.pid');
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error('Dispatcher already running'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
    }
  }
  writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const save = () => {
    writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    renameSync(statePath + '.tmp', statePath);
  };
  const alert = (record, reason) => {
    if (record.alerted === reason) return;
    record.alerted = reason;
    log('dispatcher_alert', { jobId: record.job.id, reason });
    nativeAlert(`${record.job.account} ${record.job.target.className} ${record.job.target.time}: ${reason}`);
    save();
  };
  let lastMonitor = 0;
  let authenticated = false;
  log('dispatcher_started', { pid: process.pid, repository: REPO, stateDir });
  do {
    try {
      if (!authenticated) {
        gh(['api', 'user', '--jq', '.login']);
        authenticated = true;
        log('dispatcher_auth_ok');
      }
      const now = Date.now();
      const active = reconcile(state, calendarJobs(schedule, now), now);
      save();
      // Discover an uncertain dispatch before retrying it. Concurrency is also enforced remotely.
      if (now - lastMonitor >= 15_000 && active.some(r => r.status !== 'waiting')) {
        const runs = JSON.parse(gh(['run', 'list', '--repo', REPO, '--workflow', 'book.yml', '--event', 'workflow_dispatch', '--limit', '50', '--json', 'databaseId,displayTitle,status,conclusion']));
        for (const r of active.filter(r => r.status !== 'waiting')) {
          const run = runs.find(candidate => candidate.displayTitle === runTitle(r.job.id));
          if (run) {
            r.runId = run.databaseId;
            if (run.status === 'completed') {
              r.status = 'complete'; r.conclusion = run.conclusion;
              log('workflow_complete', { jobId: r.job.id, runId: r.runId, conclusion: run.conclusion });
              if (run.conclusion !== 'success') alert(r, `예약 작업 ${run.conclusion}`);
            } else {
              const jobs = JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${r.runId}/jobs`])).jobs;
              if (isReady(jobs) && !r.readyAt) { r.readyAt = now; log('workflow_ready', { jobId: r.job.id, runId: r.runId }); }
            }
          } else if (r.status === 'uncertain' && now - r.submittedAt >= 120_000 && r.attempts < 2 && now < r.job.openAt - 60_000) {
            r.status = 'waiting';
          }
        }
        lastMonitor = now;
        save();
      }
      for (const r of active.filter(r => r.status !== 'complete')) {
        if (r.status === 'waiting' && now >= r.job.dispatchAt) {
          if (now > r.job.openAt + LATE_CATCHUP_MS) {
            r.status = 'missed'; alert(r, '오픈 시각을 놓쳤습니다. 예약 요청은 보내지 않았습니다.'); continue;
          }
          r.status = 'uncertain'; r.submittedAt = now; r.attempts++;
          if (now > r.job.openAt + 1_000) alert(r, '실행이 늦었습니다. 예약 상태 확인 후 복구를 시도합니다.');
          save(); // Persist intent before contacting GitHub.
          try {
            gh(['workflow', 'run', 'book.yml', '--repo', REPO, '--ref', 'master', '--json'], JSON.stringify({ mode: 'book', opening_date: r.job.openingDate, target_index: String(r.job.targetIndex), account_index: String(r.job.accountIndex), dispatch_key: r.job.id }));
            r.status = 'submitted';
            log('workflow_dispatched', { jobId: r.job.id, scheduledOpenAt: new Date(r.job.openAt).toISOString() });
          } catch { log('dispatch_uncertain', { jobId: r.job.id }); }
          save();
        }
        if (now >= r.job.openAt - 60_000 && !r.readyAt && r.status !== 'missed') alert(r, '오픈 전 준비 완료를 확인하지 못했습니다.');
        if (now > r.job.openAt + BOOKING_GRACE_MS && !r.readyAt && r.status !== 'missed') {
          r.status = 'missed'; alert(r, '오픈 시각이 지났고 실행 준비가 확인되지 않았습니다.');
        }
      }
      state.lastScanAt = now;
      if (!state.lastHeartbeat || now - state.lastHeartbeat >= 60_000) {
        state.lastHeartbeat = now;
        log('dispatcher_heartbeat', { pending: Object.values(state.records).filter(r => !['complete', 'missed'].includes(r.status)).length });
      }
      save();
    } catch {
      log('dispatcher_check_failed');
      if (!state.lastErrorAlert || Date.now() - state.lastErrorAlert >= 300_000) {
        nativeAlert('GitHub 실행 상태를 확인하지 못했습니다. Influx Booker 로그를 확인해 주세요.');
        state.lastErrorAlert = Date.now(); save();
      }
      if (mode === 'once') process.exitCode = 1;
    }
    if (mode === 'daemon') await new Promise(r => setTimeout(r, 5_000));
  } while (mode === 'daemon');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch(() => { log('dispatcher_fatal'); process.exitCode = 1; });

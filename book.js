import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { prepareBooking, executeBooking, makeJob, notify } from './lib/booker.js';

const args = process.argv.slice(2);
const value = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const mode = args[0];
const output = value('--output');
try {
  if (!['prepare', 'book', 'check', 'alert'].includes(mode)) throw new Error('Use prepare, book, check, or alert with --opening-date, --target-index, and --account-index.');
  const schedule = JSON.parse(readFileSync(new URL('./schedule.json', import.meta.url)));
  const job = makeJob(schedule, value('--opening-date'), value('--target-index'), value('--account-index'));
  const token = process.env[`INFLUX_TOKEN_${job.accountIndex + 1}`];
  const log = (event) => console.log(JSON.stringify(event));
  let result;
  if (mode === 'alert') {
    const resultPath = value('--result');
    const hasResult = resultPath && existsSync(resultPath);
    const path = hasResult ? resultPath : value('--prepared');
    result = path && existsSync(path) ? JSON.parse(readFileSync(path)) : { job };
    if (!hasResult) result = { ...result, success: false, reason: result.reason || 'booking_did_not_complete' };
    if (result.job.id !== job.id) throw new Error('Result does not match requested job');
    if (!result.alreadyBooked) await notify({ ...result, reason: result.reason || 'preparation_failed' }, process.env, { log });
    process.exitCode = 0;
  } else if (mode === 'book') {
    if (!value('--prepared')) throw new Error('--prepared is required for book');
    const prepared = JSON.parse(readFileSync(value('--prepared')));
    if (prepared.job.id !== job.id) throw new Error('Prepared job does not match requested job');
    result = await executeBooking(prepared, token, { log });
  } else {
    result = await prepareBooking(job, token, { log });
    if (mode === 'prepare' && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `booking_ready=${result.ready}\n`);
  }
  if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  if (mode !== 'alert') process.exitCode = result.success ? 0 : 1;
} catch (err) {
  // Never print headers, tokens, or response bodies.
  console.error(JSON.stringify({ event: 'runner_error', reason: err.code || 'invalid_run', message: err.code ? undefined : err.message }));
  process.exitCode = 1;
}

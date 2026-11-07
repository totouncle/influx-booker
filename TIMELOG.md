# Influx Booker development log

## 2026-11-07

- Investigated the initial fixed five-second offset and historical delay workarounds. The six-hour window was a late-recovery allowance, not an intentional six-hour sleep.
- Replaced paired UTC scheduled events with Auckland calendar jobs dispatched thirty minutes early from a persistent macOS LaunchAgent. The booking runtime and existing Secrets remain in GitHub Actions.
- Added preparation/readiness checks, exact opening waits, independent account runs, bounded retries, readback after ambiguous writes, per-booking concurrency, and timestamped results.
- Preserved late recovery while explicitly flagging lateness. Preserved the eight-day class-date contract and known-booked safeguards.
- Added mock-clock/API tests covering DST, all weekly entries, midnight, account failures, early opening responses, duplicate protection, and dispatcher recovery.
- Local validation: 22 mock-clock/API tests passed; JavaScript syntax, workflow YAML parsing, and whitespace checks passed. Mock tests do not establish production booking punctuality.
- Deployed booking/dispatcher changes in `64f9d15`. GitHub CI passed all 22 tests on Node.js 22.
- Existing repository Secrets were reused successfully in two live GET-only checks: [account 1](https://github.com/totouncle/influx-booker/actions/runs/42352344276), [account 2](https://github.com/totouncle/influx-booker/actions/runs/42352346497). Both observed already-booked sessions; booking and notification steps were skipped.
- The macOS LaunchAgent is running; GitHub authentication, persistent upcoming-job state, minute heartbeats, and the idle-sleep assertion were verified. No Influx/notification credentials were copied to the Mac.
- Actual punctual booking remains to be verified by the next production run. The Mac must stay powered on, connected, and logged in.
- Follow-up user instruction: preserve the original five-second buffer. Restored the first POST to opening + five seconds; preparation stays thirty minutes early. Logs distinguish the intentional offset from actual lateness. All 23 local mock tests passed, including early starts and starts inside the buffer.

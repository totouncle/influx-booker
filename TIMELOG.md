# Influx Booker development log

## 2026-11-07

- Investigated the initial fixed five-second offset and historical delay workarounds. The six-hour window was a late-recovery allowance, not an intentional six-hour sleep.
- Replaced paired UTC scheduled events with Auckland calendar jobs dispatched thirty minutes early from a persistent macOS LaunchAgent. The booking runtime and existing Secrets remain in GitHub Actions.
- Added preparation/readiness checks, exact opening waits, independent account runs, bounded retries, readback after ambiguous writes, per-booking concurrency, and timestamped results.
- Preserved late recovery while explicitly flagging lateness. Preserved the eight-day class-date contract and known-booked safeguards.
- Added mock-clock/API tests covering DST, all weekly entries, midnight, account failures, early opening responses, duplicate protection, and dispatcher recovery.
- Local validation: 22 mock-clock/API tests passed; JavaScript syntax, workflow YAML parsing, and whitespace checks passed. Mock tests do not establish production booking punctuality.
- Deployment and live read-only credential/session checks are pending at this commit.

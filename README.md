# Influx Booker

Bookings still run in GitHub Actions using the existing repository Secrets. A macOS dispatcher starts each account's workflow **30 minutes before its Auckland opening time**, then checks the workflow's `Ready to book` step. GitHub's scheduled-event queue is no longer used.

The Mac must remain powered on, connected to the internet, and logged in. The LaunchAgent uses `caffeinate -i` to prevent idle sleep; it cannot override shutdown, logout, or closing a laptop lid. GitHub runner availability is also monitored, not guaranteed.

## Booking behavior

- `schedule.json` retains its existing contract: `dayOfWeek` is the Auckland **opening day**; the class date is opening date plus eight calendar days.
- Both summer and winter are calculated using `Pacific/Auckland`. No paired UTC cron entries are needed.
- Preparation resolves the session before opening. A final read occurs ten seconds before opening, and the first booking POST starts **five seconds after opening**, preserving the requested safety buffer.
- A session not yet published can be resolved at opening. Explicit not-open responses get short bounded retries. Membership/authentication failures stop that account only.
- Known booked visits are never resubmitted. Ambiguous writes are read back before further action; failed verification or an uncertain unbooked write stops automatic writes.
- Existing six-hour late recovery is retained after an outage. Late requests are explicitly flagged and are not evidence of punctual execution. Each booking sequence is bounded to eight attempts and a one-minute request window.
- Logs/artifacts contain the scheduled opening, planned request (opening + five seconds), first POST timestamp, confirmation time, and final status. They distinguish elapsed time since opening from lateness against the planned request, so the intentional five-second buffer is not flagged as an execution delay. Credentials and raw API response bodies are not logged or saved.
- Booking results and failures use the existing Telegram/Slack Secrets. A missing `Ready to book` confirmation one minute before opening also raises a local macOS notification and a durable dispatcher log entry.

## Local dispatcher

Requirements: Node.js 22+, GitHub CLI authenticated with workflow write access, macOS.

```sh
npm test
node dispatch.js plan
node install-dispatcher.js
```

`plan` is read-only. Installation writes a user LaunchAgent and starts the dispatcher; it does not copy Influx or notification credentials onto the Mac. Runtime state/logs are under `~/Library/Application Support/InfluxBooker/`.

```sh
launchctl print gui/$(id -u)/com.onset.influx-booker.dispatcher
tail -n 20 "$HOME/Library/Application Support/InfluxBooker/dispatcher.log"
```

The GitHub `check` mode performs GET requests only and sends no notifications. Use an opening date and the exact zero-based target/account indices:

```sh
gh workflow run book.yml --repo totouncle/influx-booker \
  -f mode=check -f opening_date=YYYY-MM-DD -f target_index=N \
  -f account_index=N -f dispatch_key=unique-check-label
```

The default manual workflow mode is `check`. `book` is a real booking operation. One concurrency group per account/target/opening prevents overlapping duplicate booking runs. Do not restore the old cron while the dispatcher is active.

## Stop / restart

```sh
launchctl bootout gui/$(id -u)/com.onset.influx-booker.dispatcher
node install-dispatcher.js
```

Do not delete dispatcher state to retry a reservation. Inspect the recorded run and actual booking state first. A first installation does not replay historic reservations.

## Validation boundaries

`npm test` uses a fake clock and mock HTTP only. Read-only GitHub checks verify the stored credentials and observed session state. Actual on-time booking is only proven by the next production run's first-request and confirmation timestamps.

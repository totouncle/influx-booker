import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('This installer requires macOS');
const root = dirname(fileURLToPath(import.meta.url));
const gh = execFileSync('/usr/bin/which', ['gh'], { encoding: 'utf8' }).trim();
const node = execFileSync('/usr/bin/which', ['node'], { encoding: 'utf8' }).trim();
execFileSync(gh, ['api', 'repos/totouncle/influx-booker', '--jq', '.permissions.push'], { stdio: 'pipe', timeout: 20_000 });
const stateDir = join(homedir(), 'Library', 'Application Support', 'InfluxBooker');
const agentDir = join(homedir(), 'Library', 'LaunchAgents');
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
mkdirSync(agentDir, { recursive: true });
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const label = 'com.onset.influx-booker.dispatcher';
const path = join(agentDir, `${label}.plist`);
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${xml(node)}</string><string>${xml(join(root, 'dispatch.js'))}</string><string>daemon</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>INFLUX_GH_PATH</key><string>${xml(gh)}</string><key>INFLUX_STATE_DIR</key><string>${xml(stateDir)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(stateDir, 'dispatcher.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(stateDir, 'dispatcher-error.log'))}</string>
</dict></plist>
`;
writeFileSync(path, plist, { mode: 0o600 });
execFileSync('/usr/bin/plutil', ['-lint', path], { stdio: 'inherit' });
if (!process.argv.includes('--write-only')) {
  try { execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); } catch { /* First installation. */ }
  execFileSync('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, path], { stdio: 'inherit' });
  execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'inherit' });
}
console.log(`Installed ${path}. GitHub continues to hold the Influx/notification credentials.`);

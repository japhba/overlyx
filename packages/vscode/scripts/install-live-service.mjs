import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const cache = path.join(process.env.FAST_CACHE_DIR, 'overlyx-live/vite');
fs.mkdirSync(cache, { recursive: true });
const units = path.join(os.homedir(), '.config/systemd/user');
fs.mkdirSync(units, { recursive: true });
const file = path.join(units, 'overlyx-live.service');
fs.writeFileSync(file, `[Unit]
Description=OverLyX live extension development
ConditionHost=${os.hostname()}

[Service]
Type=simple
WorkingDirectory=${repo}
ExecStart=${process.execPath} ${repo}/packages/vscode/scripts/live.mjs
Environment=OVERLYX_VITE_CACHE=${cache}
StandardOutput=append:${path.join(cache, '../service.log')}
StandardError=inherit
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
`);
fs.writeFileSync(path.join(units, 'overlyx-live-update.service'), `[Unit]
Description=Fetch, validate and integrate OverLyX Live upstream changes
ConditionHost=${os.hostname()}

[Service]
Type=oneshot
WorkingDirectory=${repo}
ExecStart=${process.execPath} ${repo}/packages/vscode/scripts/live-sync.mjs --service
Environment=OVERLYX_LIVE_CACHE=${path.dirname(cache)}
Environment=LYX_LIB_DIR=${repo}/lyx/lib
Environment=PATH=${path.dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin
StandardOutput=append:${path.join(cache, '../updates.log')}
StandardError=inherit
TimeoutStartSec=15min
UMask=0077
`);
fs.writeFileSync(path.join(units, 'overlyx-live-update.timer'), `[Unit]
Description=Check OverLyX Live upstream every five minutes
ConditionHost=${os.hostname()}

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min

[Install]
WantedBy=timers.target
`);
execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'overlyx-live.service'], { stdio: 'inherit' });
execFileSync('systemctl', ['--user', 'enable', '--now', 'overlyx-live-update.timer'], { stdio: 'inherit' });
console.log(file);

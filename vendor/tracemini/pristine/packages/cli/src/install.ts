import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

export function restartStartup(platform = process.platform, execute: typeof execFileSync = execFileSync) {
  if (platform !== 'linux') throw new Error('automatic startup currently supports Linux only; Windows is deferred');
  execute('systemctl', ['--user', 'restart', 'tracemini.service'], {stdio: 'ignore'});
}

export function stopStartup(platform = process.platform, execute: typeof execFileSync = execFileSync) {
  if (platform !== 'linux') throw new Error('automatic startup currently supports Linux only; Windows is deferred');
  try {
    execute('systemctl', ['--user', 'stop', 'tracemini.service'], {stdio: 'ignore'});
  } catch {
    try {
      execute('systemctl', ['--user', 'is-active', '--quiet', 'tracemini.service'], {stdio: 'ignore'});
    } catch {
      return; // A first installation or an already-inactive service has nothing to stop.
    }
    throw new Error('TraceMini could not stop the existing device service; syncing was cancelled safely.');
  }
}

export async function withStartupRestart<T>(
  operation: () => Promise<T>,
  stop: () => void = () => stopStartup(),
  restart: () => void = () => restartStartup(),
) {
  stop();
  try {
    return await operation();
  } finally {
    // A failed or interrupted sync must not leave Git collection and the local
    // document endpoint stopped. systemd restart also starts an inactive unit.
    restart();
  }
}

export function installStartup(platform = process.platform, executable = process.argv[1]) {
  if (platform !== 'linux') throw new Error('automatic startup currently supports Linux only; Windows is deferred');
  const directory = path.join(os.homedir(), '.config', 'systemd', 'user');
  const service = path.join(directory, 'tracemini.service');
  const escape = (value: string) => value.replace(/([\\"])/g, '\\$1');
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.writeFileSync(service, `[Unit]\nDescription=TraceMini local Git device\nAfter=network-online.target\n\n[Service]\nType=simple\nEnvironment=PATH=%h/.local/bin:%h/bin:/usr/local/bin:/usr/bin:/bin\nExecStart="${escape(process.execPath)}" "${escape(executable)}" start\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`, {mode: 0o600});
  execFileSync('systemctl', ['--user', 'daemon-reload'], {stdio: 'ignore'});
  execFileSync('systemctl', ['--user', 'enable', 'tracemini.service'], {stdio: 'ignore'});
  execFileSync('systemctl', ['--user', 'restart', 'tracemini.service'], {stdio: 'ignore'});
  return service;
}

import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type PackageEntry = readonly [name: string, data: Buffer];

function crc32(input: Buffer) {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipPackage(entries: readonly PackageEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuffer = Buffer.from(name.replaceAll('\\', '/'));
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

const RUNTIME_ASSETS = ['files_agent.py', 'README.md', 'manifest.json'] as const;
const APPROVED_AGENT_NAMES = ['hermes', 'codex', 'claude'] as const;

export function resolveFilesAgentDirectory(): string | null {
  const configured = process.env.FILES_AGENT_SOURCE_DIR?.trim();
  // The override supports isolated tests/development without asking NFT to trace an arbitrary path.
  if (configured) {
    const override = resolve(/*turbopackIgnore: true*/ configured);
    return existsSync(/*turbopackIgnore: true*/ override)
      && statSync(/*turbopackIgnore: true*/ override).isDirectory() ? override : null;
  }
  const bundled = join(/*turbopackIgnore: true*/ process.cwd(), 'files-agent');
  return existsSync(/*turbopackIgnore: true*/ bundled)
    && statSync(/*turbopackIgnore: true*/ bundled).isDirectory() ? bundled : null;
}

function sourceEntries(root: string): PackageEntry[] {
  return RUNTIME_ASSETS.map((name): PackageEntry => {
    const absolute = join(/*turbopackIgnore: true*/ root, name);
    if (!existsSync(/*turbopackIgnore: true*/ absolute)
      || lstatSync(/*turbopackIgnore: true*/ absolute).isSymbolicLink()
      || !statSync(/*turbopackIgnore: true*/ absolute).isFile()) {
      throw new Error(`files-agent required runtime asset is missing or invalid: ${name}`);
    }
    const data = readFileSync(/*turbopackIgnore: true*/ absolute);
    if (data.length > 10 * 1024 * 1024) throw new Error(`files-agent package file is too large: ${name}`);
    return [`files-agent/${name}`, data];
  });
}

export function buildFilesAgentPackage(root: string, origin: string, token: string, expiresAt: string): Buffer {
  const config = {
    enrollment_url: `${origin}/api/files-agent/exchange`,
    ingest_url: `${origin}/api/files-agent/ingest`,
    tracemini_endpoint: `${origin}/api/files-agent/tracemini`,
    bind_url: `${origin}/api/files-agent/tracemini/bind`,
    heartbeat_url: `${origin}/api/files-agent/tracemini/heartbeat`,
    enrollment_token: token,
    expires_at: expiresAt,
    authorization: 'Send credentials as Authorization: Bearer',
  };
  const payload = readFileSync(/*turbopackIgnore: true*/ join(root, 'files_agent.py'));
  const requestedAgents = new Set((process.env.FILES_AGENT_APPROVED_AGENTS || APPROVED_AGENT_NAMES.join(','))
    .split(',').map((agent) => agent.trim()).filter(Boolean));
  const approvedAgents = APPROVED_AGENT_NAMES.filter((agent) => requestedAgents.has(agent));
  const encode = (value: string | Buffer) => Buffer.from(value).toString('base64');
  const installer = `#!/bin/sh
# Per-user, files-only installer. No root access or background service is installed.
set -eu
command -v python3 >/dev/null 2>&1 || { echo 'python3 is required' >&2; exit 1; }
command -v strace >/dev/null 2>&1 || { echo 'strace is required' >&2; exit 1; }
python3 <<'PY'
import base64, json, os, pathlib, platform, shutil, socket, urllib.request
exchange_url = base64.b64decode('${encode(config.enrollment_url)}').decode()
ingest_url = base64.b64decode('${encode(config.ingest_url)}').decode()
tracemini_endpoint = base64.b64decode('${encode(config.tracemini_endpoint)}').decode()
bind_url = base64.b64decode('${encode(config.bind_url)}').decode()
heartbeat_url = base64.b64decode('${encode(config.heartbeat_url)}').decode()
enrollment_token = base64.b64decode('${encode(token)}').decode()
approved_agents = json.loads(base64.b64decode('${encode(JSON.stringify(approvedAgents))}').decode())
agent_commands = {}
for name in approved_agents:
    discovered = shutil.which(name)
    if not discovered:
        continue
    try:
        canonical = pathlib.Path(discovered).resolve(strict=True)
    except (OSError, RuntimeError):
        continue
    if canonical.is_file() and os.access(canonical, os.X_OK):
        agent_commands[name] = [str(canonical)]
if not agent_commands:
    raise SystemExit('one of hermes, codex, or claude must be installed and executable')
body = json.dumps({
    'device_label': socket.gethostname(),
    'hostname': socket.gethostname(),
    'platform': platform.platform(),
    'agent_version': '1.0.0',
}).encode()
request = urllib.request.Request(exchange_url, data=body, method='POST', headers={
    'Authorization': 'Bearer ' + enrollment_token,
    'Content-Type': 'application/json',
})
with urllib.request.urlopen(request, timeout=20) as response:
    result = json.load(response)
credential = result['device_credential']
home = pathlib.Path.home()
lib = home / '.local/lib/files-agent'
bin_dir = home / '.local/bin'
config_dir = home / '.config/files-agent'
state = home / '.local/state/files-agent'
os.umask(0o077)
for directory in (lib, bin_dir, config_dir, state):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
program = lib / 'files_agent.py'
program.write_bytes(base64.b64decode('${encode(payload)}'))
program.chmod(0o700)
link = bin_dir / 'files-agent'
try:
    link.unlink()
except FileNotFoundError:
    pass
link.symlink_to(program)
config = {
    'endpoint': ingest_url,
    'tracemini_endpoint': tracemini_endpoint,
    'bind_url': bind_url,
    'heartbeat_url': heartbeat_url,
    'bindings': [],
    'device_token': credential,
    'auth': 'bearer',
    'agents': list(agent_commands),
    'agent_commands': agent_commands,
}
config_path = config_dir / 'config.json'
config_path.write_text(json.dumps(config, indent=2) + '\\n', encoding='utf-8')
config_path.chmod(0o600)
print('Installed files-agent in', bin_dir)
print('Usage: files-agent exec --agent NAME -- REALCMD...')
PY
`;
  const readme = `Neodym AI files tracker\n\nThis package reports file-change metadata only: path, action, time, and device. It does not collect file contents, screenshots, keyboard input, browser activity, clipboard data, or audio.\n\nRun: sh files-agent/install.sh\n\nThe one-time enrollment token in this generated package expires at ${expiresAt}. The installer exchanges it for a random per-device credential, stores that credential in a mode-0600 config file, and never installs the old activity tracker or a background service.\n`;
  return zipPackage([
    ...sourceEntries(root),
    ['files-agent/install.sh', Buffer.from(installer)],
    ['files-agent/enrollment.json', Buffer.from(`${JSON.stringify(config, null, 2)}\n`)],
    ['files-agent/ENROLLMENT-README.txt', Buffer.from(readme)],
  ]);
}

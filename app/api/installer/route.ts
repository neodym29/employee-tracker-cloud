import { NextRequest, NextResponse } from 'next/server';
import { health, userByEnrollmentToken } from '@/lib/db';

function shq(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || '';
  if (!token) return new NextResponse('missing token\n', { status: 400 });
  if (!health().configured) return new NextResponse('DATABASE_URL or POSTGRES_URL is not configured\n', { status: 503 });
  const user = await userByEnrollmentToken(token);
  if (!user) return new NextResponse('invalid or unapproved enrollment token\n', { status: 403 });

  const base = process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin;
  const repo = process.env.NEXT_PUBLIC_GITHUB_REPO || 'https://github.com/neodym29/employee-tracker-cloud';
  const archive = `${repo.replace(/\.git$/, '')}/archive/refs/heads/main.tar.gz`;
  const platformParam = req.nextUrl.searchParams.get('platform') || 'linux';
  const platform = platformParam === 'windows' || platformParam === 'macos' || platformParam === 'linux' ? platformParam : 'linux';
  const installerUrl = `${base}/api/installer?token=${encodeURIComponent(token)}&platform=${platform}`;
  const script = `#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/.local/share/neodym-employee-tracker"
SRC_DIR="$APP_DIR/source"
VENV_DIR="$APP_DIR/.venv"
ENV_DIR="$HOME/.config/employee-tracker"
ENV_FILE="$ENV_DIR/cloud.env"
SERVICE_DIR="$HOME/.config/systemd/user"
SERVICE_FILE="$SERVICE_DIR/employee-tracker.service"

echo "Installing Neodym employee tracker for ${user.email}"
if command -v apt-get >/dev/null 2>&1; then
  if [ "$(id -u)" = "0" ]; then
    apt-get update
    apt-get install -y python3 python3-venv python3-pip curl ca-certificates openssl x11-utils x11-xserver-utils xinput xprintidle usbutils pulseaudio-utils playerctl ffmpeg gnome-screenshot
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo apt-get update
    sudo apt-get install -y python3 python3-venv python3-pip curl ca-certificates openssl x11-utils x11-xserver-utils xinput xprintidle usbutils pulseaudio-utils playerctl ffmpeg gnome-screenshot
  else
    echo "Skipping apt dependency install because passwordless sudo is unavailable. Continuing with existing system packages."
  fi
fi

mkdir -p "$APP_DIR" "$ENV_DIR" "$SERVICE_DIR"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
curl -fsSL ${shq(archive)} | tar -xz --strip-components=1 -C "$SRC_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install "$SRC_DIR/agent"
python3 <<'PY'
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

home = Path.home()
app_dir = home / '.local/share/neodym-employee-tracker'
ext_root = app_dir / 'browser-extension'
ext_dir = ext_root / 'extension'
key_path = ext_root / 'neodym-tracker-extension.pem'
crx_path = ext_root / 'extension.crx'
update_xml = ext_root / 'updates.xml'
version = '1.0.0'
ext_dir.mkdir(parents=True, exist_ok=True)

manifest = {
    'manifest_version': 3,
    'name': 'Neodym Activity Tracker Bridge',
    'version': version,
    'description': 'Reports active browser tabs, page URLs, clicks, and audio state to the local Neodym tracker agent.',
    'permissions': ['tabs', 'webNavigation', 'scripting', 'activeTab'],
    'host_permissions': ['<all_urls>'],
    'background': {'service_worker': 'background.js'},
    'content_scripts': [{
        'matches': ['<all_urls>'],
        'js': ['content.js'],
        'run_at': 'document_idle',
        'all_frames': False,
    }],
}
(ext_dir / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')

(ext_dir / 'background.js').write_text(r'''
const BRIDGE = 'http://127.0.0.1:8766';

function browserName() {
  const ua = navigator.userAgent || '';
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('OPR/') || ua.includes('Opera')) return 'Opera';
  if (navigator.brave) return 'Brave';
  if (ua.includes('Chromium') && !ua.includes('Chrome/')) return 'Chromium';
  if (ua.includes('Chrome/')) return 'Google Chrome';
  return 'Chromium';
}

async function post(path, payload) {
  try {
    await fetch(BRIDGE + path, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
    });
  } catch (error) {}
}

async function collectTabs() {
  const tabs = await chrome.tabs.query({});
  const windowCache = new Map();
  const enriched = [];
  for (const tab of tabs) {
    let win = windowCache.get(tab.windowId);
    if (!win) {
      try { win = await chrome.windows.get(tab.windowId); } catch (error) { win = {}; }
      windowCache.set(tab.windowId, win);
    }
    enriched.push({...tab, windowFocused: Boolean(win.focused)});
  }
  await post('/browser-state', {browser: browserName(), tabs: enriched, capturedAt: new Date().toISOString()});
}

chrome.tabs.onActivated.addListener(collectTabs);
chrome.tabs.onUpdated.addListener(collectTabs);
chrome.windows.onFocusChanged.addListener(collectTabs);
chrome.tabs.onRemoved.addListener(collectTabs);
chrome.runtime.onStartup.addListener(collectTabs);
chrome.runtime.onInstalled.addListener(collectTabs);
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'neodym-click') return;
  const tab = sender.tab || {};
  post('/browser-click', {
    browser: browserName(),
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo && tab.mutedInfo.muted),
    targetText: message.targetText,
    tagName: message.tagName,
    role: message.role,
    ariaLabel: message.ariaLabel,
    elementId: message.elementId,
    className: message.className,
    href: message.href,
    x: message.x,
    y: message.y,
    capturedAt: new Date().toISOString(),
  });
});
setInterval(collectTabs, 2000);
collectTabs();
'''.strip() + chr(10), encoding='utf-8')

(ext_dir / 'content.js').write_text(r'''
document.addEventListener('click', (event) => {
  const el = event.target && event.target.closest ? event.target.closest('a,button,input,textarea,select,[role],label,[onclick]') : event.target;
  if (!el) return;
  const text = (el.innerText || el.value || el.textContent || '').trim().slice(0, 300);
  chrome.runtime.sendMessage({
    type: 'neodym-click',
    targetText: text,
    tagName: el.tagName,
    role: el.getAttribute && el.getAttribute('role'),
    ariaLabel: el.getAttribute && el.getAttribute('aria-label'),
    elementId: el.id || null,
    className: typeof el.className === 'string' ? el.className.slice(0, 300) : null,
    href: el.href || null,
    x: event.clientX,
    y: event.clientY,
  });
}, true);
'''.strip() + chr(10), encoding='utf-8')

if not key_path.exists():
    subprocess.run(['openssl', 'genrsa', '-out', str(key_path), '2048'], check=True)

pub_der = subprocess.check_output(['openssl', 'rsa', '-in', str(key_path), '-pubout', '-outform', 'DER'], stderr=subprocess.DEVNULL)
hex_id = hashlib.sha256(pub_der).hexdigest()[:32]
ext_id = ''.join(chr(ord('a') + int(ch, 16)) for ch in hex_id)

packer = None
for candidate in ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'opera']:
    if shutil.which(candidate):
        packer = candidate
        break

if packer:
    generated = ext_dir.with_suffix('.crx')
    if generated.exists():
        generated.unlink()
    subprocess.run([packer, '--pack-extension=' + str(ext_dir), '--pack-extension-key=' + str(key_path)], check=False)
    if generated.exists():
        generated.replace(crx_path)

if not crx_path.exists():
    print('WARNING: could not pack browser extension; install Chrome/Chromium/Brave/Edge/Opera and rerun installer.')
else:
    crx_uri = crx_path.resolve().as_uri()
    update_xml.write_text('<?xml version="1.0" encoding="UTF-8"?><gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="' + ext_id + '"><updatecheck codebase="' + crx_uri + '" version="' + version + '" /></app></gupdate>', encoding='utf-8')
    update_uri = update_xml.resolve().as_uri()
    policy = {
        'ExtensionInstallForcelist': [ext_id + ';' + update_uri],
        'ExtensionSettings': {
            ext_id: {
                'installation_mode': 'force_installed',
                'update_url': update_uri,
                'toolbar_pin': 'force_pinned',
            }
        },
    }
    external = {'external_crx': str(crx_path), 'external_version': version}
    targets = [
        ('Google Chrome', ['google-chrome', 'google-chrome-stable'], ['/etc/opt/chrome/policies/managed'], ['/usr/share/google-chrome/extensions']),
        ('Chromium', ['chromium', 'chromium-browser'], ['/etc/chromium/policies/managed'], ['/usr/share/chromium/extensions']),
        ('Brave', ['brave-browser'], ['/etc/brave/policies/managed'], ['/usr/share/brave/extensions', '/usr/share/brave-browser/extensions']),
        ('Microsoft Edge', ['microsoft-edge', 'microsoft-edge-stable'], ['/etc/opt/edge/policies/managed'], ['/usr/share/microsoft-edge/extensions']),
        ('Opera', ['opera', 'opera-stable'], ['/etc/opt/opera/policies/managed'], ['/usr/share/opera/extensions']),
    ]
    if os.geteuid() == 0:
        privileged: list[str] | None = []
    elif shutil.which('sudo') and subprocess.run(['sudo', '-n', 'true'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False).returncode == 0:
        privileged = ['sudo', '-n']
    else:
        privileged = None

    installed = []
    if privileged is None:
        print('Browser extension id:', ext_id)
        print('Browser extension packaged, but managed browser policy install was skipped because passwordless sudo is unavailable.')
        print('Tracker service will still upload app/window/audio activity. Run installer in a terminal with sudo access to force-install the browser extension.')
    else:
        for name, commands, policy_dirs, extension_dirs in targets:
            if not any(shutil.which(cmd) for cmd in commands):
                continue
            configured = False
            for directory in policy_dirs:
                subprocess.run(privileged + ['mkdir', '-p', directory], check=True)
                tmp = ext_root / ('policy-' + name.lower().replace(' ', '-') + '.json')
                tmp.write_text(json.dumps(policy, indent=2), encoding='utf-8')
                subprocess.run(privileged + ['cp', str(tmp), str(Path(directory) / 'neodym-tracker-extension.json')], check=True)
                configured = True
            for directory in extension_dirs:
                subprocess.run(privileged + ['mkdir', '-p', directory], check=True)
                tmp = ext_root / ('external-' + name.lower().replace(' ', '-') + '.json')
                tmp.write_text(json.dumps(external, indent=2), encoding='utf-8')
                subprocess.run(privileged + ['cp', str(tmp), str(Path(directory) / (ext_id + '.json'))], check=True)
                configured = True
            if configured:
                installed.append(name)
        print('Browser extension id:', ext_id)
        print('Browsers configured:', ', '.join(installed) if installed else 'none detected')
        print('Restart open browsers once so the managed extension is loaded.')
PY
cat > "$ENV_FILE" <<'ENV'
EMPLOYEE_TRACKER_COMPANY_DOMAIN=${user.domain}
EMPLOYEE_TRACKER_EMPLOYEE_EMAIL=${user.email}
EMPLOYEE_TRACKER_USERNAME=${user.employee_username || user.email.split('@')[0]}
EMPLOYEE_TRACKER_CLOUD_API=${base}/api/ingest
EMPLOYEE_TRACKER_ENROLLMENT_TOKEN=${token}
EMPLOYEE_TRACKER_WORKSPACE=%h
EMPLOYEE_TRACKER_DIR=%h/.local/share/neodym-employee-tracker/data
EMPLOYEE_TRACKER_DB=%h/.local/share/neodym-employee-tracker/data/activity.sqlite3
EMPLOYEE_TRACKER_SCREENSHOT_DIR=%h/.local/share/neodym-employee-tracker/data/screenshots
EMPLOYEE_TRACKER_FILE_ROOTS=%h/Downloads:%h/Documents:%h/Desktop:%h/Pictures:%h/Music:%h/Videos
EMPLOYEE_TRACKER_FILE_SCAN_SECONDS=30
EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS=30
EMPLOYEE_TRACKER_POLL_SECONDS=1
EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=1
EMPLOYEE_TRACKER_ENABLE_SCREENSHOTS=1
ENV
# systemd EnvironmentFile does not expand %h inside values, so write HOME-expanded copies too.
sed -i "s|%h|$HOME|g" "$ENV_FILE"
cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=Neodym employee activity tracker
After=graphical-session.target network-online.target
Wants=graphical-session.target network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0
ExecStart=$VENV_DIR/bin/employee-tracker run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

systemctl --user daemon-reload
systemctl --user enable employee-tracker.service
systemctl --user restart employee-tracker.service
systemctl --user status employee-tracker.service --no-pager --lines=12 || true

echo "Done. This PC is enrolled as ${user.email} and will upload activity to ${base}/api/ingest"
`;
  const macosScript = `#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$HOME/Library/Application Support/NeodymEmployeeTracker"
SRC_DIR="$APP_DIR/source"
VENV_DIR="$APP_DIR/.venv"
ENV_DIR="$HOME/Library/Application Support/NeodymEmployeeTracker"
ENV_FILE="$ENV_DIR/cloud.env"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_FILE="$PLIST_DIR/com.neodym.employee-tracker.plist"
RUNNER="$APP_DIR/run-tracker.sh"
echo "Installing Neodym employee tracker for ${user.email} on macOS"
mkdir -p "$APP_DIR" "$ENV_DIR" "$PLIST_DIR"
rm -rf "$SRC_DIR"
mkdir -p "$SRC_DIR"
curl -fsSL ${shq(archive)} | tar -xz --strip-components=1 -C "$SRC_DIR"
python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install "$SRC_DIR/agent"
cat > "$ENV_FILE" <<'ENV'
EMPLOYEE_TRACKER_COMPANY_DOMAIN=${user.domain}
EMPLOYEE_TRACKER_EMPLOYEE_EMAIL=${user.email}
EMPLOYEE_TRACKER_USERNAME=${user.employee_username || user.email.split('@')[0]}
EMPLOYEE_TRACKER_CLOUD_API=${base}/api/ingest
EMPLOYEE_TRACKER_ENROLLMENT_TOKEN=${token}
EMPLOYEE_TRACKER_WORKSPACE=$HOME
EMPLOYEE_TRACKER_DIR=$HOME/Library/Application Support/NeodymEmployeeTracker/data
EMPLOYEE_TRACKER_DB=$HOME/Library/Application Support/NeodymEmployeeTracker/data/activity.sqlite3
EMPLOYEE_TRACKER_SCREENSHOT_DIR=$HOME/Library/Application Support/NeodymEmployeeTracker/data/screenshots
EMPLOYEE_TRACKER_FILE_ROOTS=$HOME/Downloads:$HOME/Documents:$HOME/Desktop:$HOME/Pictures:$HOME/Music:$HOME/Movies
EMPLOYEE_TRACKER_FILE_SCAN_SECONDS=30
EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS=30
EMPLOYEE_TRACKER_POLL_SECONDS=1
EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=1
EMPLOYEE_TRACKER_ENABLE_SCREENSHOTS=1
ENV
cat > "$RUNNER" <<RUNNER
#!/usr/bin/env bash
set -a
source "$ENV_FILE"
set +a
exec "$VENV_DIR/bin/employee-tracker" run
RUNNER
chmod +x "$RUNNER"
cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.neodym.employee-tracker</string>
  <key>ProgramArguments</key><array><string>$RUNNER</string></array>
  <key>EnvironmentVariables</key><dict><key>EMPLOYEE_TRACKER_ENV_FILE</key><string>$ENV_FILE</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/tracker.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/tracker.err.log</string>
</dict></plist>
PLIST
launchctl unload "$PLIST_FILE" >/dev/null 2>&1 || true
launchctl load "$PLIST_FILE"
echo "Done. This Mac is enrolled as ${user.email} and will upload activity to ${base}/api/ingest"
`;
  const windowsScript = `$ErrorActionPreference = 'Stop'
$AppDir = Join-Path $env:LOCALAPPDATA 'NeodymEmployeeTracker'
$SrcDir = Join-Path $AppDir 'source'
$VenvDir = Join-Path $AppDir '.venv'
$EnvDir = Join-Path $env:APPDATA 'NeodymEmployeeTracker'
$EnvFile = Join-Path $EnvDir 'cloud.env'
$Runner = Join-Path $AppDir 'run-tracker.ps1'
Write-Host 'Installing Neodym employee tracker for ${user.email} on Windows'
New-Item -ItemType Directory -Force -Path $AppDir, $EnvDir | Out-Null
Remove-Item -Recurse -Force $SrcDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $SrcDir | Out-Null
$Archive = Join-Path $env:TEMP 'neodym-tracker.tar.gz'
Invoke-WebRequest -Uri '${archive}' -OutFile $Archive
& tar.exe -xzf $Archive --strip-components=1 -C $SrcDir
function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = $machinePath + ';' + $userPath
}
function Test-PythonLauncher {
  try {
    $cmd = Get-Command py -ErrorAction SilentlyContinue
    if (!$cmd) { return $false }
    & $cmd.Source -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}
function Test-PythonExe {
  try {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (!$cmd) { return $false }
    if ($cmd.Source -like '*\\WindowsApps\\python.exe' -or $cmd.Source -like '*\\WindowsApps\\python3.exe') { return $false }
    & $cmd.Source -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}
function Ensure-Python {
  if (Test-PythonLauncher) { return 'py' }
  if (Test-PythonExe) { return 'python' }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host 'Python was not found. Installing Python 3 with winget...'
    & winget install --exact --id Python.Python.3.12 --scope user --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
      & winget install --exact --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
    }
    Refresh-Path
    if ((Get-Command py -ErrorAction SilentlyContinue) -and (Test-PythonLauncher)) { return 'py' }
    if ((Get-Command python -ErrorAction SilentlyContinue) -and (Test-PythonExe)) { return 'python' }
  }
  throw 'Python 3.10+ is required and could not be installed automatically. Install Python 3 from https://www.python.org/downloads/windows/ and tick "Add python.exe to PATH", then run this installer again.'
}
$PythonMode = Ensure-Python
if ($PythonMode -eq 'py') {
  & py -3 -m venv $VenvDir
} else {
  & python -m venv $VenvDir
}
if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python virtual environment.' }
$VenvPython = Join-Path $VenvDir 'Scripts\\python.exe'
if (!(Test-Path $VenvPython)) { throw "Python virtual environment was not created at $VenvPython" }
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }
& $VenvPython -m pip install (Join-Path $SrcDir 'agent')
if ($LASTEXITCODE -ne 0) { throw 'Failed to install the Neodym tracker agent Python package.' }
@'
EMPLOYEE_TRACKER_COMPANY_DOMAIN=${user.domain}
EMPLOYEE_TRACKER_EMPLOYEE_EMAIL=${user.email}
EMPLOYEE_TRACKER_USERNAME=${user.employee_username || user.email.split('@')[0]}
EMPLOYEE_TRACKER_CLOUD_API=${base}/api/ingest
EMPLOYEE_TRACKER_ENROLLMENT_TOKEN=${token}
EMPLOYEE_TRACKER_WORKSPACE=%USERPROFILE%
EMPLOYEE_TRACKER_DIR=%LOCALAPPDATA%\\NeodymEmployeeTracker\\data
EMPLOYEE_TRACKER_DB=%LOCALAPPDATA%\\NeodymEmployeeTracker\\data\\activity.sqlite3
EMPLOYEE_TRACKER_SCREENSHOT_DIR=%LOCALAPPDATA%\\NeodymEmployeeTracker\\data\\screenshots
EMPLOYEE_TRACKER_FILE_ROOTS=%USERPROFILE%\\Downloads;%USERPROFILE%\\Documents;%USERPROFILE%\\Desktop;%USERPROFILE%\\Pictures;%USERPROFILE%\\Music;%USERPROFILE%\\Videos
EMPLOYEE_TRACKER_FILE_SCAN_SECONDS=30
EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS=30
EMPLOYEE_TRACKER_POLL_SECONDS=1
EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=1
EMPLOYEE_TRACKER_ENABLE_SCREENSHOTS=1
'@ | Set-Content -Encoding UTF8 $EnvFile
$Exe = Join-Path $VenvDir 'Scripts\\employee-tracker.exe'
@"
Get-Content '$EnvFile' | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($Matches[1], [Environment]::ExpandEnvironmentVariables($Matches[2]), 'Process')
  }
}
& '$Exe' run
"@ | Set-Content -Encoding UTF8 $Runner
$TaskAction = 'powershell -ExecutionPolicy Bypass -File "' + $Runner + '"'
schtasks.exe /Create /TN 'Neodym Employee Tracker' /TR $TaskAction /SC ONLOGON /RL LIMITED /F | Out-Null
schtasks.exe /Run /TN 'Neodym Employee Tracker' | Out-Null
Write-Host 'Done. This Windows PC is enrolled as ${user.email} and will upload activity to ${base}/api/ingest'
`;
  const windowsCmd = `@echo off
setlocal
echo Installing Neodym employee tracker for ${user.email} on Windows
set "INSTALLER_PS1=%TEMP%\\neodym-tracker-installer-%RANDOM%.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${installerUrl}&format=ps1' -OutFile '%INSTALLER_PS1%'"
if errorlevel 1 (
  echo Failed to download the installer.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER_PS1%"
set "EXITCODE=%ERRORLEVEL%"
del "%INSTALLER_PS1%" >nul 2>nul
if not "%EXITCODE%"=="0" (
  echo Installer failed with exit code %EXITCODE%.
  pause
  exit /b %EXITCODE%
)
echo Done. This Windows PC is enrolled as ${user.email}.
pause
`;
  const selectedScript = platform === 'windows' ? (req.nextUrl.searchParams.get('format') === 'ps1' ? windowsScript : windowsCmd) : platform === 'macos' ? macosScript : platform === 'linux' ? script : script;
  const extension = platform === 'windows' ? (req.nextUrl.searchParams.get('format') === 'ps1' ? 'ps1' : 'cmd') : 'sh';
  const contentType = platform === 'windows' && req.nextUrl.searchParams.get('format') !== 'ps1' ? 'application/x-msdownload; charset=utf-8' : platform === 'windows' ? 'application/x-powershell; charset=utf-8' : 'text/x-shellscript; charset=utf-8';
  return new NextResponse(selectedScript, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="install-neodym-tracker-${user.email.split('@')[0]}.${extension}"`,
    },
  });
}

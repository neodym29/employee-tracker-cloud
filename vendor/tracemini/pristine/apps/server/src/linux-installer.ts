import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export function linuxInstallCommand(origin: string, installToken: string) {
  const url = `${origin.replace(/\/$/, '')}/api/installers/linux/${encodeURIComponent(installToken)}`;
  return `mkdir -p "$HOME/.cache/tracemini" && curl --fail --show-error --location ${shellQuote(url)} --output "$HOME/.cache/tracemini/install.sh" && sh "$HOME/.cache/tracemini/install.sh"`;
}

export function linuxSyncCommand(origin: string, installToken: string) {
  return linuxInstallCommand(origin, installToken);
}

export function linuxInstaller(cliDir: string, serverUrl: string, installToken: string) {
  const files = fs.readdirSync(cliDir).filter(name => name.endsWith('.js')).sort();
  if (!files.includes('index.js')) throw new Error(`built TraceMini CLI not found in ${cliDir}`);
  const payload = files.map(name => {
    const encoded = gzipSync(fs.readFileSync(path.join(cliDir, name)), {level: 9}).toString('base64');
    return `printf '%s' ${shellQuote(encoded)} | base64 -d | gzip -d > "$STAGE_DIR/cli/${name}"`;
  }).join('\n');
  return `#!/bin/sh
set -eu

if [ "$(uname -s)" != Linux ]; then
  echo 'TraceMini installation currently supports Linux only; Windows is deferred.' >&2
  exit 1
fi
echo 'Installing OCR dependencies'
sudo apt-get install -y poppler-utils tesseract-ocr
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo 'Node.js 22 or newer is required.' >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo 'systemctl is required for the TraceMini systemd user service.' >&2
  exit 1
fi
if ! command -v base64 >/dev/null 2>&1 || ! command -v gzip >/dev/null 2>&1; then
  echo 'base64 and gzip are required to install TraceMini.' >&2
  exit 1
fi

INSTALL_ROOT="$HOME/.local/share/tracemini"
CLI_DIR="$INSTALL_ROOT/cli"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="\${TRACEMINI_HOME:-$HOME/.tracemini}"
SERVICE="$HOME/.config/systemd/user/tracemini.service"
CACHE_DIR="$HOME/.cache/tracemini"
mkdir -p "$CACHE_DIR" "$BIN_DIR" "$INSTALL_ROOT"
chmod 700 "$CACHE_DIR" "$INSTALL_ROOT"
STAGE_DIR=$(mktemp -d "$CACHE_DIR/install.XXXXXX")
BACKUP_DIR="$STAGE_DIR/backup"
mkdir -p "$STAGE_DIR/cli" "$BACKUP_DIR"

HAD_INSTALL=0
if [ -e "$CLI_DIR" ] || [ -e "$BIN_DIR/tracemini" ] || [ -e "$STATE_DIR/config.json" ] || [ -e "$SERVICE" ]; then HAD_INSTALL=1; fi

rollback() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -eq 0 ]; then
    rm -rf "$STAGE_DIR"
    return
  fi
  echo '✗ Installation failed; rolling back local changes.' >&2
  systemctl --user stop tracemini.service >/dev/null 2>&1 || true
  if [ -e "$BACKUP_DIR/cli" ]; then rm -rf "$CLI_DIR"; cp -a "$BACKUP_DIR/cli" "$CLI_DIR"; else rm -rf "$CLI_DIR"; fi
  if [ -e "$BACKUP_DIR/tracemini" ]; then cp -a "$BACKUP_DIR/tracemini" "$BIN_DIR/tracemini"; else rm -f "$BIN_DIR/tracemini"; fi
  if [ -e "$BACKUP_DIR/service" ]; then mkdir -p "$(dirname "$SERVICE")"; cp -a "$BACKUP_DIR/service" "$SERVICE"; else rm -f "$SERVICE"; fi
  if [ ! -e "$STAGE_DIR/credential-exchanged" ]; then
    if [ -e "$BACKUP_DIR/state" ]; then rm -rf "$STATE_DIR"; cp -a "$BACKUP_DIR/state" "$STATE_DIR"; elif [ "$HAD_INSTALL" -eq 0 ]; then rm -rf "$STATE_DIR"; fi
  elif [ "$HAD_INSTALL" -eq 0 ]; then
    rm -rf "$STATE_DIR"
  fi
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if [ -e "$BACKUP_DIR/service" ]; then systemctl --user restart tracemini.service >/dev/null 2>&1 || true; fi
  rm -rf "$STAGE_DIR"
  echo '✓ Previous installation restored.' >&2
  exit "$status"
}
trap rollback EXIT HUP INT TERM

echo 'TraceMini Setup'
echo '────────────────────────────────────────'
echo '[1/3] Staging TraceMini CLI'
${payload}
node "$STAGE_DIR/cli/index.js" --help >/dev/null
echo '✓ CLI bundle verified'

echo '[2/3] Saving the current installation'
systemctl --user stop tracemini.service >/dev/null 2>&1 || true
[ ! -e "$CLI_DIR" ] || cp -a "$CLI_DIR" "$BACKUP_DIR/cli"
[ ! -e "$BIN_DIR/tracemini" ] || cp -a "$BIN_DIR/tracemini" "$BACKUP_DIR/tracemini"
[ ! -e "$SERVICE" ] || cp -a "$SERVICE" "$BACKUP_DIR/service"
[ ! -e "$STATE_DIR" ] || cp -a "$STATE_DIR" "$BACKUP_DIR/state"
rm -rf "$CLI_DIR"
mv "$STAGE_DIR/cli" "$CLI_DIR"
chmod 700 "$CLI_DIR"
cat > "$BIN_DIR/tracemini" <<'TRACEMINI_WRAPPER'
#!/bin/sh
exec node "$HOME/.local/share/tracemini/cli/index.js" "$@"
TRACEMINI_WRAPPER
chmod 755 "$BIN_DIR/tracemini"

echo '[3/3] Running guided setup'
"$BIN_DIR/tracemini" setup --server ${shellQuote(serverUrl)} --install-token ${shellQuote(installToken)} --transaction-dir "$STAGE_DIR"

case ":$PATH:" in
  *:"$BIN_DIR":*) ;;
  *)
    if ! grep -F '.local/bin' "$HOME/.profile" >/dev/null 2>&1; then
      printf '\n%s\n' 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
    fi
    echo 'Open a new terminal before running tracemini commands.'
    ;;
esac
`;
}

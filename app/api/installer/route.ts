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
  sudo apt-get update
  sudo apt-get install -y python3 python3-venv python3-pip curl ca-certificates x11-utils x11-xserver-utils xinput xprintidle usbutils pulseaudio-utils ffmpeg gnome-screenshot
fi

mkdir -p "$APP_DIR" "$ENV_DIR" "$SERVICE_DIR"
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
EMPLOYEE_TRACKER_WORKSPACE=%h
EMPLOYEE_TRACKER_FILE_ROOTS=%h/Downloads:%h/Documents:%h/Desktop:%h/Pictures:%h/Music:%h/Videos
EMPLOYEE_TRACKER_FILE_SCAN_SECONDS=30
EMPLOYEE_TRACKER_CLOUD_UPLOAD_SECONDS=5
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
systemctl --user enable --now employee-tracker.service
systemctl --user status employee-tracker.service --no-pager --lines=12 || true

echo "Done. This PC is enrolled as ${user.email} and will upload activity to ${base}/api/ingest"
`;
  return new NextResponse(script, {
    status: 200,
    headers: {
      'content-type': 'text/x-shellscript; charset=utf-8',
      'content-disposition': `attachment; filename="install-neodym-tracker-${user.email.split('@')[0]}.sh"`,
    },
  });
}

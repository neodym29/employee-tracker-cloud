from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from shutil import which
import os
import subprocess


def capture_screenshot(destination_dir: Path, prefix: str, window_id: str | None = None) -> Path | None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')

    if os.name == 'nt':
        return _capture_windows(destination_dir, prefix, timestamp)

    if window_id and which('xwd') is not None:
        screenshot = _capture_xwindow(destination_dir, prefix, timestamp, window_id)
        if screenshot is not None:
            return screenshot

    # Only use screenshot tools that can capture without popping the GNOME/Snap screenshot UI.
    # On GNOME Wayland there is intentionally no fully silent screenshot API for normal apps;
    # in that case we skip the screenshot rather than making the employee see a capture flash.
    for capture in (_capture_grim, _capture_maim, _capture_scrot):
        screenshot = capture(destination_dir, prefix, timestamp)
        if screenshot is not None:
            return screenshot

    return None


def _run_silent(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=5,
    )


def _capture_windows(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    powershell = which('powershell') or which('pwsh')
    if powershell is None:
        return None
    # Use JPEG on Windows so multi-monitor captures stay under the ingest body limit.
    # SystemInformation.VirtualScreen captures the whole desktop, not just monitor #1.
    path = destination_dir / f'{prefix}_{timestamp}.jpg'
    escaped_path = str(path).replace("'", "''")
    script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {{ $_.MimeType -eq 'image/jpeg' }} | Select-Object -First 1
$encoder = [System.Drawing.Imaging.Encoder]::Quality
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($encoder, [int64]65)
$bitmap.Save('{escaped_path}', $jpegCodec, $params)
$graphics.Dispose()
$bitmap.Dispose()
""".strip()
    result = _run_silent([powershell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
    return path if result.returncode == 0 and path.exists() else None


def _capture_grim(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('grim') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['grim', str(path)])
    return path if result.returncode == 0 and path.exists() else None


def _capture_maim(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('maim') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['maim', str(path)])
    return path if result.returncode == 0 and path.exists() else None


def _capture_scrot(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('scrot') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['scrot', '--silent', str(path)])
    return path if result.returncode == 0 and path.exists() else None


def _capture_xwindow(destination_dir: Path, prefix: str, timestamp: str, window_id: str) -> Path | None:
    xwd_path = destination_dir / f'{prefix}_{window_id.replace("0x", "")}_{timestamp}.xwd'
    png_path = destination_dir / f'{prefix}_{window_id.replace("0x", "")}_{timestamp}.png'
    xwd_result = _run_silent(['xwd', '-id', window_id, '-silent', '-out', str(xwd_path)])
    if xwd_result.returncode != 0 or not xwd_path.exists():
        return None

    if which('ffmpeg') is not None:
        convert_result = subprocess.run(
            ['ffmpeg', '-y', '-i', str(xwd_path), '-frames:v', '1', '-update', '1', str(png_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        try:
            xwd_path.unlink(missing_ok=True)
        except OSError:
            pass
        if convert_result.returncode == 0 and png_path.exists():
            return png_path
        return None

    return xwd_path

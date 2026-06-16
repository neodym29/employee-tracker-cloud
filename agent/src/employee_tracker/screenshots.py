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

    # Prefer tools that capture silently. Some desktop-provided screenshot
    # helpers visibly flash or open capture UI, so they are intentionally not
    # used for unattended tracking. If no quiet backend works, skip the
    # screenshot rather than showing UI to the user.
    for capture in (_capture_grim, _capture_maim, _capture_scrot):
        screenshot = capture(destination_dir, prefix, timestamp)
        if screenshot is not None:
            return screenshot

    return None


def _validated_screenshot(path: Path) -> Path | None:
    if not path.exists() or path.stat().st_size <= 0:
        return None
    if _is_probably_black(path):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return path


def _is_probably_black(path: Path) -> bool:
    try:
        from PIL import Image
    except Exception:
        return False
    try:
        with Image.open(path) as image:
            sample = image.convert('RGB')
            sample.thumbnail((64, 64))
            pixels = list(sample.getdata())
    except Exception:
        return False
    if not pixels:
        return False
    dark_pixels = sum(1 for red, green, blue in pixels if red < 8 and green < 8 and blue < 8)
    return dark_pixels / len(pixels) >= 0.98


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
    return _validated_screenshot(path) if result.returncode == 0 else None


def _capture_grim(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('grim') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['grim', str(path)])
    return _validated_screenshot(path) if result.returncode == 0 else None


def _capture_maim(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('maim') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['maim', str(path)])
    return _validated_screenshot(path) if result.returncode == 0 else None


def _capture_scrot(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    if which('scrot') is None:
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    result = _run_silent(['scrot', '--silent', str(path)])
    return _validated_screenshot(path) if result.returncode == 0 else None

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
        if convert_result.returncode == 0:
            return _validated_screenshot(png_path)
        return None

    return _validated_screenshot(xwd_path)

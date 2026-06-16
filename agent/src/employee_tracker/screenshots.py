from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from shutil import which
import os
import re
import subprocess


@dataclass(frozen=True)
class ScreenshotCaptureResult:
    path: Path | None
    status: str
    backend: str | None = None
    reason: str | None = None
    attempts: tuple[str, ...] = ()


def capture_screenshot(destination_dir: Path, prefix: str, window_id: str | None = None) -> Path | None:
    return capture_screenshot_with_status(destination_dir, prefix, window_id).path


def capture_screenshot_with_status(destination_dir: Path, prefix: str, window_id: str | None = None) -> ScreenshotCaptureResult:
    destination_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    attempts: list[str] = []

    if os.name == 'nt':
        attempts.append('windows_copy_from_screen')
        screenshot = _capture_windows(destination_dir, prefix, timestamp)
        return ScreenshotCaptureResult(
            screenshot,
            'captured' if screenshot else 'failed',
            'windows_copy_from_screen',
            None if screenshot else 'windows_capture_failed',
            tuple(attempts),
        )

    x_window_id = _resolve_xwindow_id(window_id)
    if x_window_id and which('xwd') is not None:
        attempts.append('xwd_window')
        screenshot = _capture_xwindow(destination_dir, prefix, timestamp, x_window_id)
        if screenshot is not None:
            return ScreenshotCaptureResult(screenshot, 'captured', 'xwd_window', None, tuple(attempts))

    # Prefer tools that capture silently. Some desktop-provided screenshot
    # helpers visibly flash or open capture UI, so they are intentionally not
    # used for unattended tracking. If no quiet backend works, skip the
    # screenshot rather than showing UI to the user.
    for backend, capture in (
        ('mss', _capture_mss),
        ('grim', _capture_grim),
        ('maim', _capture_maim),
        ('scrot_silent', _capture_scrot),
    ):
        attempts.append(backend)
        screenshot = capture(destination_dir, prefix, timestamp)
        if screenshot is not None:
            return ScreenshotCaptureResult(screenshot, 'captured', backend, None, tuple(attempts))

    return ScreenshotCaptureResult(None, 'skipped', None, 'no_silent_backend_available_or_all_failed', tuple(attempts))


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


def _is_real_xwindow_id(window_id: str | None) -> bool:
    if not window_id:
        return False
    return bool(re.fullmatch(r'(0x[0-9a-fA-F]+|[0-9]+)', str(window_id).strip()))


def _resolve_xwindow_id(window_id: str | None) -> str | None:
    """Return a real X11 window id for xwd.

    Browser-extension events use synthetic ids such as
    ``browser:brave:window:...:tab:...``. Those are useful for dashboard
    correlation but invalid for xwd. In that case, fall back to the current X
    active window, which captures the visible browser/app window silently on
    XWayland/X11 sessions.
    """
    if _is_real_xwindow_id(window_id):
        return str(window_id).strip()
    if which('xdotool') is None:
        return None
    try:
        result = subprocess.run(
            ['xdotool', 'getactivewindow'],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return None
    candidate = result.stdout.strip()
    return candidate if result.returncode == 0 and _is_real_xwindow_id(candidate) else None


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


def _capture_mss(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    """Capture the full desktop with MSS, without desktop UI/sound helpers.

    MSS reads from the display APIs directly. On Linux/X11 this avoids GNOME's
    screenshot UI, portal dialogs, flash animations, and screenshot sounds. If
    MSS is unavailable or cannot access the current display/session, the caller
    falls back to other explicitly silent backends.
    """
    try:
        import mss
        import mss.tools
    except Exception:
        return None

    path = destination_dir / f'{prefix}_{timestamp}.png'
    try:
        with mss.mss() as sct:
            monitor = sct.monitors[0] if sct.monitors else None
            if monitor is None:
                return None
            image = sct.grab(monitor)
            mss.tools.to_png(image.rgb, image.size, output=str(path))
    except Exception:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    return _validated_screenshot(path)


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


def _capture_gnome_shell_dbus(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    """Capture through GNOME Shell's D-Bus API with flash disabled.

    This is different from the gnome-screenshot CLI. GNOME Shell's D-Bus method
    accepts a flash boolean; passing false avoids the visible screenshot flash/UI
    on GNOME Wayland sessions that expose org.gnome.Shell.Screenshot.
    """
    if which('gdbus') is None:
        return None
    if os.environ.get('XDG_SESSION_TYPE') != 'wayland' and not os.environ.get('WAYLAND_DISPLAY'):
        return None
    path = destination_dir / f'{prefix}_{timestamp}.png'
    try:
        result = subprocess.run(
            [
                'gdbus',
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell.Screenshot',
                '--object-path',
                '/org/gnome/Shell/Screenshot',
                '--method',
                'org.gnome.Shell.Screenshot.Screenshot',
                'false',
                'false',
                str(path),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
    except Exception:
        return None
    if result.returncode != 0 or b'true' not in result.stdout.lower():
        return None
    return _validated_screenshot(path)


def _capture_xwindow(destination_dir: Path, prefix: str, timestamp: str, window_id: str) -> Path | None:
    safe_window_id = re.sub(r'[^0-9A-Za-z]+', '_', window_id.replace('0x', ''))
    xwd_path = destination_dir / f'{prefix}_{safe_window_id}_{timestamp}.xwd'
    png_path = destination_dir / f'{prefix}_{safe_window_id}_{timestamp}.png'
    xwd_result = _run_silent(['xwd', '-id', window_id, '-silent', '-out', str(xwd_path)])
    if xwd_result.returncode != 0 or not xwd_path.exists():
        return None

    converted = False
    if which('convert') is not None:
        convert_result = _run_silent(['convert', str(xwd_path), str(png_path)])
        converted = convert_result.returncode == 0
    elif which('magick') is not None:
        convert_result = _run_silent(['magick', str(xwd_path), str(png_path)])
        converted = convert_result.returncode == 0

    if not converted and which('ffmpeg') is not None:
        convert_result = subprocess.run(
            ['ffmpeg', '-y', '-i', str(xwd_path), '-frames:v', '1', '-update', '1', str(png_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        converted = convert_result.returncode == 0

    try:
        xwd_path.unlink(missing_ok=True)
    except OSError:
        pass

    if converted:
        return _validated_screenshot(png_path)
    return None

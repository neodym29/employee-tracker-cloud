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


@dataclass(frozen=True)
class XWindowGeometry:
    window_id: str
    x: int
    y: int
    width: int
    height: int


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

    # Prefer silent whole-desktop backends first so scheduled evidence captures
    # include the complete virtual desktop across multiple monitors. The xwd
    # path below is intentionally only a window-only fallback because capturing
    # the active window will miss anything visible on a second monitor.
    whole_desktop_backends = (
        ('gnome_shell_screencast', _capture_gnome_shell_screencast),
        ('mss', _capture_mss),
        ('grim', _capture_grim),
        ('maim', _capture_maim),
        ('scrot_silent', _capture_scrot),
        ('xwd_root', _capture_xroot),
    )
    for backend, capture in whole_desktop_backends:
        attempts.append(backend)
        screenshot = capture(destination_dir, prefix, timestamp)
        if screenshot is not None:
            return ScreenshotCaptureResult(screenshot, 'captured', backend, None, tuple(attempts))

    multi_monitor = _has_multiple_monitors()

    if multi_monitor:
        attempts.append('x11_window_stitch')
        stitched = _capture_x11_window_stitch(destination_dir, prefix, timestamp)
        if stitched is not None:
            return ScreenshotCaptureResult(
                stitched,
                'captured',
                'x11_window_stitch',
                'stitched_x11_windows_after_full_desktop_unavailable',
                tuple(attempts),
            )

    # Last-resort silent X11 window-only fallback. On multi-monitor Wayland/X11
    # hybrid sessions this may capture only the active window/monitor, but that
    # is still better than losing screenshots entirely when full-desktop capture
    # is blocked. Mark the reason so the dashboard/logs can distinguish partial
    # evidence from a true whole-desktop capture.
    x_window_id = _resolve_xwindow_id(window_id)
    if x_window_id and which('xwd') is not None:
        attempts.append('xwd_window')
        screenshot = _capture_xwindow(destination_dir, prefix, timestamp, x_window_id)
        if screenshot is not None:
            reason = 'partial_window_fallback_after_full_desktop_unavailable' if multi_monitor else None
            return ScreenshotCaptureResult(screenshot, 'captured', 'xwd_window', reason, tuple(attempts))

    if multi_monitor:
        return ScreenshotCaptureResult(None, 'skipped', None, 'multi_monitor_full_desktop_unavailable', tuple(attempts))

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
        return _topmost_xwindow_id()
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
        return _topmost_xwindow_id()
    candidate = result.stdout.strip()
    if result.returncode == 0 and _is_real_xwindow_id(candidate):
        return candidate
    return _topmost_xwindow_id()


def _topmost_xwindow_id() -> str | None:
    """Return the topmost viewable X11/XWayland client window.

    GNOME Wayland often reports ``_NET_ACTIVE_WINDOW`` as ``0x0`` even while
    XWayland windows are visible. Falling back to the stacking list restores the
    partial screenshot behavior that existed before full-desktop capture was
    attempted, without pretending it is multi-monitor evidence.
    """
    if which('xprop') is None:
        return None
    try:
        result = subprocess.run(
            ['xprop', '-root', '_NET_CLIENT_LIST_STACKING'],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return None
    if result.returncode != 0 or '#' not in result.stdout:
        return None
    window_ids = re.findall(r'0x[0-9a-fA-F]+|\b\d+\b', result.stdout.split('#', 1)[1])
    for candidate in reversed(window_ids):
        if _is_viewable_xwindow(candidate):
            return candidate
    return None


def _is_viewable_xwindow(window_id: str) -> bool:
    if which('xwininfo') is None:
        return True
    try:
        result = subprocess.run(
            ['xwininfo', '-id', window_id],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return False
    return result.returncode == 0 and 'Map State: IsViewable' in result.stdout


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



def _capture_gnome_shell_screencast(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    """Capture a real GNOME Wayland compositor frame via Shell Screencast.

    GNOME Wayland often denies direct screenshot APIs and returns black frames
    from X11 wrappers, but the Shell Screencast service can record the actual
    compositor output. We record a very short WebM silently, extract one frame,
    validate it, and delete the temporary video.
    """
    if which('gdbus') is None or which('ffmpeg') is None:
        return None
    if os.environ.get('XDG_SESSION_TYPE') != 'wayland' and not os.environ.get('WAYLAND_DISPLAY'):
        return None

    webm_path = destination_dir / f'{prefix}_gnome_screencast_{timestamp}.webm'
    png_path = destination_dir / f'{prefix}_gnome_screencast_{timestamp}.png'
    try:
        start = subprocess.run(
            [
                'gdbus',
                'call',
                '--session',
                '--dest',
                'org.gnome.Shell.Screencast',
                '--object-path',
                '/org/gnome/Shell/Screencast',
                '--method',
                'org.gnome.Shell.Screencast.Screencast',
                str(webm_path),
                '{}',
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=3,
            text=True,
        )
        if start.returncode != 0 or 'true' not in start.stdout.lower():
            return None
        # Give the compositor enough time to write at least one full frame.
        try:
            import time
            time.sleep(0.75)
        finally:
            subprocess.run(
                [
                    'gdbus',
                    'call',
                    '--session',
                    '--dest',
                    'org.gnome.Shell.Screencast',
                    '--object-path',
                    '/org/gnome/Shell/Screencast',
                    '--method',
                    'org.gnome.Shell.Screencast.StopScreencast',
                ],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=3,
            )
        if not webm_path.exists() or webm_path.stat().st_size <= 0:
            return None
        extract = subprocess.run(
            ['ffmpeg', '-y', '-i', str(webm_path), '-frames:v', '1', '-update', '1', str(png_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=8,
        )
        return _validated_screenshot(png_path) if extract.returncode == 0 else None
    except Exception:
        return None
    finally:
        try:
            webm_path.unlink(missing_ok=True)
        except OSError:
            pass

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


def _has_multiple_monitors() -> bool:
    """Best-effort monitor count for deciding whether window-only fallback is misleading."""
    if which('xrandr') is not None:
        try:
            result = subprocess.run(
                ['xrandr', '--listmonitors'],
                check=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=1,
                text=True,
            )
        except Exception:
            result = None
        if result is not None and result.returncode == 0:
            match = re.search(r'^Monitors:\s*(\d+)', result.stdout, re.MULTILINE)
            if match:
                try:
                    return int(match.group(1)) > 1
                except ValueError:
                    pass

    try:
        import mss
        with mss.mss() as sct:
            # MSS index 0 is the virtual desktop; physical outputs start at 1.
            return max(0, len(sct.monitors) - 1) > 1
    except Exception:
        return False


def _capture_xroot(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    """Capture the full X11 root window for Xorg multi-monitor sessions."""
    if which('xwd') is None:
        return None
    xwd_path = destination_dir / f'{prefix}_root_{timestamp}.xwd'
    png_path = destination_dir / f'{prefix}_root_{timestamp}.png'
    xwd_result = _run_silent(['xwd', '-root', '-silent', '-out', str(xwd_path)])
    if xwd_result.returncode != 0 or not xwd_path.exists() or xwd_path.stat().st_size <= 0:
        try:
            xwd_path.unlink(missing_ok=True)
        except OSError:
            pass
        return None
    converted = _convert_xwd_to_png(xwd_path, png_path)
    try:
        xwd_path.unlink(missing_ok=True)
    except OSError:
        pass
    return _validated_screenshot(png_path) if converted else None



def _virtual_desktop_geometry() -> tuple[int, int, int, int] | None:
    """Return the virtual desktop bounds as (left, top, width, height)."""
    if which('xrandr') is None:
        return None
    try:
        result = subprocess.run(
            ['xrandr', '--current'],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return None
    if result.returncode != 0:
        return None

    rects: list[tuple[int, int, int, int]] = []
    for line in result.stdout.splitlines():
        if ' connected' not in line:
            continue
        match = re.search(r'\b(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\b', line)
        if not match:
            continue
        width, height, x, y = (int(value) for value in match.groups())
        rects.append((x, y, x + width, y + height))

    if not rects:
        return None
    left = min(rect[0] for rect in rects)
    top = min(rect[1] for rect in rects)
    right = max(rect[2] for rect in rects)
    bottom = max(rect[3] for rect in rects)
    width = right - left
    height = bottom - top
    if width <= 0 or height <= 0:
        return None
    return left, top, width, height


def _xwindow_geometry(window_id: str) -> XWindowGeometry | None:
    if which('xwininfo') is None:
        return None
    try:
        result = subprocess.run(
            ['xwininfo', '-id', window_id],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return None
    if result.returncode != 0 or 'Map State: IsViewable' not in result.stdout:
        return None

    def number(label: str) -> int | None:
        match = re.search(rf'{re.escape(label)}:\s*(-?\d+)', result.stdout)
        return int(match.group(1)) if match else None

    x = number('Absolute upper-left X')
    y = number('Absolute upper-left Y')
    width = number('Width')
    height = number('Height')
    if x is None or y is None or width is None or height is None:
        return None
    if width <= 1 or height <= 1:
        return None
    return XWindowGeometry(window_id=window_id, x=x, y=y, width=width, height=height)


def _stacked_xwindow_geometries() -> list[XWindowGeometry]:
    if which('xprop') is None:
        return []
    try:
        result = subprocess.run(
            ['xprop', '-root', '_NET_CLIENT_LIST_STACKING'],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=1,
            text=True,
        )
    except Exception:
        return []
    if result.returncode != 0 or '#' not in result.stdout:
        return []
    window_ids = re.findall(r'0x[0-9a-fA-F]+|\b\d+\b', result.stdout.split('#', 1)[1])
    geometries: list[XWindowGeometry] = []
    seen: set[str] = set()
    for window_id in window_ids:
        if window_id in seen:
            continue
        seen.add(window_id)
        geometry = _xwindow_geometry(window_id)
        if geometry is not None:
            geometries.append(geometry)
    return geometries


def _capture_x11_window_stitch(destination_dir: Path, prefix: str, timestamp: str) -> Path | None:
    """Stitch visible X11/XWayland windows into one multi-monitor canvas.

    GNOME Wayland can block real full-desktop capture while still allowing xwd
    capture of individual XWayland windows. On dual-monitor desks that is better
    than a single active-window screenshot: windows on either monitor are pasted
    into their root-coordinate position on the full virtual desktop.
    """
    if which('xwd') is None:
        return None
    bounds = _virtual_desktop_geometry()
    if bounds is None:
        return None
    desktop_left, desktop_top, desktop_width, desktop_height = bounds
    if desktop_width <= 0 or desktop_height <= 0:
        return None
    windows = _stacked_xwindow_geometries()
    if not windows:
        return None

    try:
        from PIL import Image
    except Exception:
        return None

    canvas = Image.new('RGB', (desktop_width, desktop_height), (0, 0, 0))
    pasted = 0
    temp_paths: list[Path] = []
    try:
        for index, geometry in enumerate(windows):
            safe_window_id = re.sub(r'[^0-9A-Za-z]+', '_', geometry.window_id.replace('0x', ''))
            xwd_path = destination_dir / f'{prefix}_stitch_{index}_{safe_window_id}_{timestamp}.xwd'
            png_path = destination_dir / f'{prefix}_stitch_{index}_{safe_window_id}_{timestamp}.png'
            temp_paths.extend([xwd_path, png_path])
            xwd_result = _run_silent(['xwd', '-id', geometry.window_id, '-silent', '-out', str(xwd_path)])
            if xwd_result.returncode != 0 or not xwd_path.exists() or xwd_path.stat().st_size <= 0:
                continue
            if not _convert_xwd_to_png(xwd_path, png_path):
                continue
            try:
                with Image.open(png_path) as window_image:
                    image = window_image.convert('RGB')
                    paste_x = geometry.x - desktop_left
                    paste_y = geometry.y - desktop_top
                    if paste_x >= desktop_width or paste_y >= desktop_height:
                        continue
                    if paste_x + image.width <= 0 or paste_y + image.height <= 0:
                        continue
                    canvas.paste(image, (paste_x, paste_y))
                    pasted += 1
            except Exception:
                continue
        if pasted == 0:
            return None
        stitched_path = destination_dir / f'{prefix}_x11_stitched_{timestamp}.png'
        canvas.save(stitched_path)
        return _validated_screenshot(stitched_path)
    finally:
        for temp_path in temp_paths:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass

def _convert_xwd_to_png(xwd_path: Path, png_path: Path) -> bool:
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
    return converted


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

    converted = _convert_xwd_to_png(xwd_path, png_path)

    try:
        xwd_path.unlink(missing_ok=True)
    except OSError:
        pass

    if converted:
        return _validated_screenshot(png_path)
    return None

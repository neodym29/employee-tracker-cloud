from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from shutil import which
import subprocess


def capture_screenshot(destination_dir: Path, prefix: str, window_id: str | None = None) -> Path | None:
    destination_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')

    if window_id and which('xwd') is not None:
        return _capture_xwindow(destination_dir, prefix, timestamp, window_id)

    if which('gnome-screenshot') is not None:
        path = destination_dir / f'{prefix}_{timestamp}.png'
        subprocess.run(['gnome-screenshot', '-f', str(path)], check=False)
        return path if path.exists() else None

    return None


def _capture_xwindow(destination_dir: Path, prefix: str, timestamp: str, window_id: str) -> Path | None:
    xwd_path = destination_dir / f'{prefix}_{window_id.replace("0x", "")}_{timestamp}.xwd'
    png_path = destination_dir / f'{prefix}_{window_id.replace("0x", "")}_{timestamp}.png'
    xwd_result = subprocess.run(
        ['xwd', '-id', window_id, '-silent', '-out', str(xwd_path)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if xwd_result.returncode != 0 or not xwd_path.exists():
        return None

    if which('ffmpeg') is not None:
        convert_result = subprocess.run(
            ['ffmpeg', '-y', '-i', str(xwd_path), '-frames:v', '1', '-update', '1', str(png_path)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            xwd_path.unlink(missing_ok=True)
        except OSError:
            pass
        if convert_result.returncode == 0 and png_path.exists():
            return png_path
        return None

    return xwd_path

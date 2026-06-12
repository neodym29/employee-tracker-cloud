from __future__ import annotations

import os
try:
    import pwd
except ImportError:  # Windows has no pwd module.
    pwd = None  # type: ignore[assignment]
import re
import select
import socket
import subprocess
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from shutil import which


@dataclass(frozen=True)
class WindowInfo:
    window_id: str | None
    title: str | None
    pid: int | None
    app_name: str | None
    wm_class: str | None


@dataclass(frozen=True)
class OpenWindowInfo:
    window_id: str
    title: str | None
    pid: int | None
    app_name: str | None
    wm_class: str | None
    is_active: bool
    x: int | None = None
    y: int | None = None
    width: int | None = None
    height: int | None = None


@dataclass(frozen=True)
class MonitorInfo:
    name: str
    width: int
    height: int
    x: int
    y: int
    is_primary: bool


@dataclass(frozen=True)
class DisplayContext:
    current_desktop_index: int | None
    current_desktop_name: str | None
    desktop_count: int | None
    active_window_desktop_index: int | None
    active_window_desktop_name: str | None
    monitor_count: int
    active_monitor_name: str | None
    monitor_names: tuple[str, ...]


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    ppid: int | None
    process_name: str | None
    exe_path: str | None
    cwd: str | None
    command_line: str | None
    state: str | None
    uid: int | None
    username: str | None
    start_time_ticks: int | None


@dataclass(frozen=True)
class WarpCommandInfo:
    warp_pid: int
    shell_pid: int | None
    observed_pid: int | None
    observed_process_name: str | None
    observed_command_line: str | None
    note: str | None


@dataclass(frozen=True)
class CurrentAppInfo:
    app_key: str
    app_name: str
    pid: int | None
    process_name: str | None
    window_count: int
    subwindow_count: int
    source: str


@dataclass(frozen=True)
class CurrentSubwindowInfo:
    app_key: str
    app_name: str
    subwindow_type: str
    title: str | None
    url: str | None
    window_id: str | None
    pid: int | None
    is_active: bool
    source: str


@dataclass(frozen=True)
class ClickInfo:
    button: int | None
    x: float | None
    y: float | None
    screen_x: float | None
    screen_y: float | None
    source: str


@dataclass(frozen=True)
class PeripheralInfo:
    device_type: str
    device_id: str | None
    name: str | None
    vendor: str | None
    model: str | None
    state: str | None
    source: str


@dataclass(frozen=True)
class AudioOutputInfo:
    sink_input_id: str | None
    application_name: str | None
    process_id: int | None
    process_binary: str | None
    media_name: str | None
    node_name: str | None
    corked: str | None
    mute: str | None
    volume: str | None
    state_hint: str | None
    source: str
    mpris_player: str | None = None
    mpris_title: str | None = None
    mpris_artist: str | None = None
    mpris_album: str | None = None
    mpris_status: str | None = None


class XInputClickReader:
    def __init__(self) -> None:
        self.process: subprocess.Popen[str] | None = None

    def start(self) -> None:
        if self.process is not None or which('xinput') is None or not os.environ.get('DISPLAY'):
            return
        try:
            self.process = subprocess.Popen(
                ['xinput', 'test-xi2', '--root'],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except Exception:
            self.process = None

    def read_clicks(self, limit: int = 50) -> list[ClickInfo]:
        self.start()
        process = self.process
        if process is None or process.stdout is None:
            return []
        if process.poll() is not None:
            self.process = None
            return []
        clicks: list[ClickInfo] = []
        current: dict[str, float | int | str | None] | None = None
        lines_read = 0
        while lines_read < 500 and len(clicks) < limit:
            readable, _, _ = select.select([process.stdout], [], [], 0)
            if not readable:
                break
            line = process.stdout.readline()
            if not line:
                break
            lines_read += 1
            stripped = line.strip()
            if stripped.startswith('EVENT type'):
                if current and _is_complete_click_event(current):
                    clicks.append(_click_from_xinput_event(current))
                current = {'event': 'ButtonPress' if 'ButtonPress' in stripped else None}
                continue
            if current is None:
                continue
            if stripped.startswith('detail:'):
                current['button'] = _safe_int(stripped.split(':', 1)[1].strip())
            elif stripped.startswith('root_x:'):
                current['screen_x'] = _safe_float(stripped.split(':', 1)[1].strip())
            elif stripped.startswith('root_y:'):
                current['screen_y'] = _safe_float(stripped.split(':', 1)[1].strip())
            elif stripped.startswith('event_x:'):
                current['x'] = _safe_float(stripped.split(':', 1)[1].strip())
            elif stripped.startswith('event_y:'):
                current['y'] = _safe_float(stripped.split(':', 1)[1].strip())
            elif stripped.startswith('root:'):
                coords = _parse_xinput_coords(stripped)
                if coords:
                    current['screen_x'], current['screen_y'] = coords
            elif stripped.startswith('event:'):
                coords = _parse_xinput_coords(stripped)
                if coords:
                    current['x'], current['y'] = coords
        if current and _is_complete_click_event(current) and len(clicks) < limit:
            clicks.append(_click_from_xinput_event(current))
        return clicks

    def close(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
        self.process = None


def _click_from_xinput_event(event: dict[str, float | int | str | None]) -> ClickInfo:
    return ClickInfo(
        button=event.get('button') if isinstance(event.get('button'), int) else None,
        x=float(event['x']) if isinstance(event.get('x'), (int, float)) else None,
        y=float(event['y']) if isinstance(event.get('y'), (int, float)) else None,
        screen_x=float(event['screen_x']) if isinstance(event.get('screen_x'), (int, float)) else None,
        screen_y=float(event['screen_y']) if isinstance(event.get('screen_y'), (int, float)) else None,
        source='xinput-test-xi2',
    )


def _is_complete_click_event(event: dict[str, float | int | str | None]) -> bool:
    return (
        event.get('event') == 'ButtonPress'
        and event.get('button') is not None
        and (event.get('screen_x') is not None or event.get('x') is not None)
    )


def _parse_xinput_coords(line: str) -> tuple[float, float] | None:
    match = re.search(r'[-+]?\d+(?:\.\d+)?/[-+]?\d+(?:\.\d+)?\s+\(([-+]?\d+(?:\.\d+)?),\s*([-+]?\d+(?:\.\d+)?)\)', line)
    if not match:
        return None
    return float(match.group(1)), float(match.group(2))


def _safe_float(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def host_name() -> str:
    return socket.gethostname()


def current_window_info() -> WindowInfo:
    if not os.environ.get('DISPLAY'):
        return WindowInfo(window_id=None, title=None, pid=None, app_name=None, wm_class=None)

    active_window_id = _active_window_id()
    if not active_window_id:
        return WindowInfo(window_id=None, title=None, pid=None, app_name=None, wm_class=None)

    title = _window_title(active_window_id)
    pid = _window_pid(active_window_id)
    wm_class = _window_class(active_window_id)
    return WindowInfo(
        window_id=active_window_id,
        title=title,
        pid=pid,
        app_name=_process_name(pid) or wm_class,
        wm_class=wm_class,
    )


def list_open_windows() -> list[OpenWindowInfo]:
    if not os.environ.get('DISPLAY') or which('xprop') is None:
        return []

    active_window_id = _active_window_id()
    window_ids = _client_window_ids()
    windows: list[OpenWindowInfo] = []
    for window_id in window_ids:
        pid = _window_pid(window_id)
        wm_class = _window_class(window_id)
        geometry = _window_geometry(window_id)
        windows.append(
            OpenWindowInfo(
                window_id=window_id,
                title=_window_title(window_id),
                pid=pid,
                app_name=_process_name(pid) or wm_class,
                wm_class=wm_class,
                is_active=(window_id == active_window_id),
                x=geometry[0] if geometry else None,
                y=geometry[1] if geometry else None,
                width=geometry[2] if geometry else None,
                height=geometry[3] if geometry else None,
            )
        )
    return windows


def current_display_context(window_id: str | None = None) -> DisplayContext:
    current_desktop_index = _root_cardinal_property('_NET_CURRENT_DESKTOP')
    desktop_count = _root_cardinal_property('_NET_NUMBER_OF_DESKTOPS')
    desktop_names = _root_utf8_list_property('_NET_DESKTOP_NAMES')
    active_window_desktop_index = _window_desktop(window_id) if window_id else None
    monitors = list_monitors()
    active_monitor_name = _window_monitor_name(window_id, monitors) if window_id else None

    return DisplayContext(
        current_desktop_index=current_desktop_index,
        current_desktop_name=_desktop_name(current_desktop_index, desktop_names),
        desktop_count=desktop_count,
        active_window_desktop_index=active_window_desktop_index,
        active_window_desktop_name=_desktop_name(active_window_desktop_index, desktop_names),
        monitor_count=len(monitors),
        active_monitor_name=active_monitor_name,
        monitor_names=tuple(monitor.name for monitor in monitors),
    )


def list_monitors() -> list[MonitorInfo]:
    if not os.environ.get('DISPLAY') or which('xrandr') is None:
        return []
    try:
        output = subprocess.check_output(['xrandr', '--query'], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return []

    monitors: list[MonitorInfo] = []
    pattern = re.compile(r'^(?P<name>\S+) connected (?P<primary>primary )?(?P<width>\d+)x(?P<height>\d+)\+(?P<x>-?\d+)\+(?P<y>-?\d+)')
    for line in output.splitlines():
        match = pattern.match(line.strip())
        if not match:
            continue
        monitors.append(
            MonitorInfo(
                name=match.group('name'),
                width=int(match.group('width')),
                height=int(match.group('height')),
                x=int(match.group('x')),
                y=int(match.group('y')),
                is_primary=bool(match.group('primary')),
            )
        )
    return monitors


def idle_seconds() -> int:
    if which('xprintidle') is None:
        return 0
    try:
        output = subprocess.check_output(['xprintidle'], text=True).strip()
        return max(0, int(int(output) / 1000))
    except Exception:
        return 0


def list_processes(proc_root: Path = Path('/proc')) -> list[ProcessInfo]:
    processes: list[ProcessInfo] = []
    if not proc_root.exists():
        return processes

    for entry in sorted(proc_root.iterdir(), key=lambda path: path.name):
        if not entry.is_dir() or not entry.name.isdigit():
            continue
        process = read_process_info(entry)
        if process is not None:
            processes.append(process)
    return processes


def read_process_info(pid_dir: Path) -> ProcessInfo | None:
    try:
        pid = int(pid_dir.name)
    except ValueError:
        return None

    stat_parts = _read_stat(pid_dir)
    if stat_parts is None:
        return None

    state = stat_parts[0] if len(stat_parts) >= 1 else None
    ppid = _safe_int(stat_parts[1]) if len(stat_parts) >= 2 else None
    start_time_ticks = _safe_int(stat_parts[19]) if len(stat_parts) >= 20 else None

    exe_path = _read_link(pid_dir / 'exe')
    cwd = _read_link(pid_dir / 'cwd')
    command_line = _read_cmdline(pid_dir / 'cmdline')
    process_name = Path(exe_path).name if exe_path else _read_comm(pid_dir / 'comm')
    uid, username = _read_identity(pid_dir / 'status')

    if not command_line and process_name:
        command_line = f'[{process_name}]'

    return ProcessInfo(
        pid=pid,
        ppid=ppid,
        process_name=process_name,
        exe_path=exe_path,
        cwd=cwd,
        command_line=command_line,
        state=state,
        uid=uid,
        username=username,
        start_time_ticks=start_time_ticks,
    )


def process_map_by_pid(processes: list[ProcessInfo]) -> dict[int, ProcessInfo]:
    return {process.pid: process for process in processes}


def diff_process_maps(
    previous: dict[int, ProcessInfo],
    current: dict[int, ProcessInfo],
) -> tuple[list[ProcessInfo], list[ProcessInfo]]:
    started: list[ProcessInfo] = []
    exited: list[ProcessInfo] = []

    for pid, process in current.items():
        previous_process = previous.get(pid)
        if previous_process is None:
            started.append(process)
            continue
        if previous_process.start_time_ticks != process.start_time_ticks:
            exited.append(previous_process)
            started.append(process)

    for pid, process in previous.items():
        if pid not in current:
            exited.append(process)

    started.sort(key=lambda process: process.pid)
    exited.sort(key=lambda process: process.pid)
    return started, exited


def summarize_current_open_state(
    processes: list[ProcessInfo],
    windows: list[OpenWindowInfo],
) -> tuple[list[CurrentAppInfo], list[CurrentSubwindowInfo]]:
    app_names: dict[str, str] = {}
    app_pids: dict[str, int | None] = {}
    app_process_names: dict[str, str | None] = {}
    app_sources: dict[str, set[str]] = defaultdict(set)
    subwindows: list[CurrentSubwindowInfo] = []

    def ensure_app(key: str, name: str, pid: int | None, process_name: str | None, source: str) -> None:
        app_names.setdefault(key, name)
        app_pids.setdefault(key, pid)
        app_process_names.setdefault(key, process_name)
        app_sources[key].add(source)

    for window in windows:
        key = _app_key_from_window(window)
        name = _friendly_app_name(window.app_name or window.wm_class or key)
        ensure_app(key, name, window.pid, _process_name(window.pid), 'window')
        subwindows.append(
            CurrentSubwindowInfo(
                app_key=key,
                app_name=name,
                subwindow_type='window',
                title=window.title,
                url=None,
                window_id=window.window_id,
                pid=window.pid,
                is_active=window.is_active,
                source='x11-window',
            )
        )

    for process in processes:
        process_name = (process.process_name or '').lower()
        command_line = process.command_line or ''
        if _is_visible_brave_process(process):
            ensure_app('brave', 'Brave', process.pid, process.process_name, 'process')
        elif _is_visible_chrome_process(process):
            ensure_app('chrome', 'Google Chrome', process.pid, process.process_name, 'process')
        elif _is_visible_chromium_process(process):
            ensure_app('chromium', 'Chromium', process.pid, process.process_name, 'process')
        elif _is_visible_opera_process(process):
            ensure_app('opera', 'Opera', process.pid, process.process_name, 'process')
        elif _is_visible_firefox_process(process):
            ensure_app('firefox', 'Firefox', process.pid, process.process_name, 'process')
        elif process_name == 'discord' or (process.exe_path or '').endswith('/Discord'):
            ensure_app('discord', 'Discord', process.pid, process.process_name, 'process')
        elif process_name in {'warp', 'warp-terminal'} or 'warp' in (process.exe_path or '').lower():
            if 'terminal-server' not in command_line and 'minidump-server' not in command_line:
                ensure_app('warp', 'Warp', process.pid, process.process_name, 'process')

    open_app_keys = set(app_names)
    for browser in _browser_session_specs():
        key = str(browser['key'])
        if key not in open_app_keys:
            continue
        for tab in list_browser_tabs(browser['profile_dir']):
            name = str(browser['name'])
            subwindows.append(
                CurrentSubwindowInfo(
                    app_key=key,
                    app_name=name,
                    subwindow_type='tab',
                    title=tab.get('title'),
                    url=tab.get('url'),
                    window_id=None,
                    pid=app_pids.get(key),
                    is_active=False,
                    source=f'{key}-session',
                )
            )

    subwindow_counts: dict[str, int] = defaultdict(int)
    window_counts: dict[str, int] = defaultdict(int)
    for subwindow in subwindows:
        subwindow_counts[subwindow.app_key] += 1
        if subwindow.subwindow_type == 'window':
            window_counts[subwindow.app_key] += 1

    apps = [
        CurrentAppInfo(
            app_key=key,
            app_name=app_names[key],
            pid=app_pids.get(key),
            process_name=app_process_names.get(key),
            window_count=window_counts.get(key, 0),
            subwindow_count=subwindow_counts.get(key, 0),
            source='+'.join(sorted(app_sources.get(key, set()))),
        )
        for key in sorted(app_names, key=lambda value: app_names[value].lower())
    ]
    subwindows.sort(key=lambda item: (item.app_name.lower(), item.subwindow_type, item.title or item.url or ''))
    return apps, subwindows


def list_browser_tabs(profile_dir: Path, limit: int = 80) -> list[dict[str, str | None]]:
    sessions_dir = profile_dir / 'Sessions'
    if not sessions_dir.exists():
        return []
    tab_files = sorted(sessions_dir.glob('Tabs_*'), key=lambda path: path.stat().st_mtime, reverse=True)
    if not tab_files:
        return []

    tabs: list[dict[str, str | None]] = []
    seen_urls: set[str] = set()
    data = tab_files[0].read_bytes()
    for url in _extract_urls_from_binary(data):
        normalized = _clean_extracted_url(url)
        if not normalized or normalized in seen_urls or _is_browser_noise_url(normalized):
            continue
        seen_urls.add(normalized)
        tabs.append({'title': _title_from_url(normalized), 'url': normalized})
        if len(tabs) >= limit:
            break
    return tabs


def summarize_warp_activity(processes: list[ProcessInfo], windows: list[OpenWindowInfo]) -> list[WarpCommandInfo]:
    warp_pids = {
        window.pid
        for window in windows
        if window.pid is not None and _looks_like_warp_window(window)
    }
    if not warp_pids:
        warp_pids = {
            process.pid
            for process in processes
            if (process.process_name or '').lower() in {'warp-terminal', 'warp'}
            and process.command_line
            and 'terminal-server' not in process.command_line
            and 'minidump-server' not in process.command_line
        }

    if not warp_pids:
        return []

    process_map = process_map_by_pid(processes)
    children = _children_by_parent(processes)
    summaries: list[WarpCommandInfo] = []
    for warp_pid in sorted(warp_pids):
        descendants = _descendants(warp_pid, children, process_map)
        shell = _choose_warp_shell(descendants)
        observed = _choose_warp_command(descendants)
        if shell is None and observed is None:
            continue
        note_parts: list[str] = []
        if shell is not None:
            note_parts.append(f'shell pid {shell.pid}')
        if observed is not None and shell is not None and observed.pid != shell.pid:
            note_parts.append(f'child command under shell pid {shell.pid}')
        summaries.append(
            WarpCommandInfo(
                warp_pid=warp_pid,
                shell_pid=shell.pid if shell else None,
                observed_pid=observed.pid if observed else None,
                observed_process_name=observed.process_name if observed else None,
                observed_command_line=observed.command_line if observed else shell.command_line if shell else None,
                note='; '.join(note_parts) if note_parts else None,
            )
        )
    return summaries



def list_brave_tabs(profile_dir: Path | None = None, limit: int = 80) -> list[dict[str, str | None]]:
    return list_browser_tabs(profile_dir or (Path.home() / '.config/BraveSoftware/Brave-Browser/Default'), limit)


def list_peripherals() -> list[PeripheralInfo]:
    """Return a best-effort inventory of attached input/USB/audio devices."""
    devices: list[PeripheralInfo] = []
    if Path('/proc/bus/input/devices').exists():
        try:
            raw = Path('/proc/bus/input/devices').read_text(encoding='utf-8', errors='replace')
        except OSError:
            raw = ''
        for block in raw.split('\n\n'):
            name_match = re.search(r'N: Name="([^"]+)"', block)
            handlers_match = re.search(r'H: Handlers=(.+)', block)
            phys_match = re.search(r'P: Phys=(.+)', block)
            handlers = handlers_match.group(1).strip() if handlers_match else ''
            name = name_match.group(1) if name_match else None
            if not name:
                continue
            lower = f'{name} {handlers}'.lower()
            if any(token in lower for token in ('mouse', 'pointer', 'touchpad')):
                device_type = 'mouse'
            elif any(token in lower for token in ('keyboard', 'kbd')):
                device_type = 'keyboard'
            elif 'event' in handlers:
                device_type = 'input'
            else:
                device_type = 'input'
            devices.append(PeripheralInfo(
                device_type=device_type,
                device_id=phys_match.group(1).strip() if phys_match else handlers or None,
                name=name,
                vendor=None,
                model=None,
                state='attached',
                source='proc-input-devices',
            ))
    if which('lsusb') is not None:
        try:
            output = subprocess.check_output(['lsusb'], text=True, stderr=subprocess.DEVNULL)
        except Exception:
            output = ''
        for line in output.splitlines():
            match = re.match(r'Bus (\S+) Device (\S+): ID ([0-9a-fA-F:]+)\s*(.*)', line.strip())
            if not match:
                continue
            vendor_model = match.group(4).strip() or None
            devices.append(PeripheralInfo(
                device_type='usb',
                device_id=f'bus:{match.group(1)} device:{match.group(2)} id:{match.group(3)}',
                name=vendor_model,
                vendor=match.group(3).split(':', 1)[0],
                model=match.group(3).split(':', 1)[1] if ':' in match.group(3) else None,
                state='attached',
                source='lsusb',
            ))
    if which('pactl') is not None:
        try:
            output = subprocess.check_output(['pactl', 'list', 'short', 'sinks'], text=True, stderr=subprocess.DEVNULL)
        except Exception:
            output = ''
        for line in output.splitlines():
            parts = line.split('\t')
            if len(parts) >= 2:
                devices.append(PeripheralInfo(
                    device_type='audio-output',
                    device_id=parts[0],
                    name=parts[1],
                    vendor=None,
                    model=parts[2] if len(parts) > 2 else None,
                    state='attached',
                    source='pactl-sinks',
                ))
    seen: set[tuple[str, str | None, str | None]] = set()
    unique: list[PeripheralInfo] = []
    for device in devices:
        key = (device.device_type, device.device_id, device.name)
        if key in seen:
            continue
        seen.add(key)
        unique.append(device)
    return unique


def _playerctl_metadata() -> dict[str, str]:
    if which('playerctl') is None:
        return {}
    try:
        output = subprocess.check_output(
            ['playerctl', 'metadata', '--format', '{{playerName}}\t{{artist}}\t{{title}}\t{{album}}\t{{status}}'],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=1,
        ).strip()
    except Exception:
        return {}
    if not output:
        return {}
    parts = output.split('\t')
    while len(parts) < 5:
        parts.append('')
    player, artist, title, album, status = parts[:5]
    return {
        'mpris_player': player,
        'mpris_artist': artist,
        'mpris_title': title,
        'mpris_album': album,
        'mpris_status': status,
    }


def list_audio_outputs() -> list[AudioOutputInfo]:
    if which('pactl') is None:
        return []
    mpris = _playerctl_metadata()
    system_status = _default_sink_audio_status()
    try:
        output = subprocess.check_output(['pactl', 'list', 'sink-inputs'], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return [system_status] if system_status else []
    blocks = re.split(r'\n(?=Sink Input #)', output.strip()) if output.strip() else []
    items: list[AudioOutputInfo] = []
    for block in blocks:
        header = re.search(r'Sink Input #(\S+)', block)
        props = _parse_pactl_properties(block)
        volume = None
        for line in block.splitlines():
            if line.strip().startswith('Volume:'):
                volume = line.strip().removeprefix('Volume:').strip()
                break
        app_name = props.get('application.name')
        process_id = _safe_int(props.get('application.process.id'))
        corked = _parse_pactl_field(block, 'Corked')
        mute = _parse_pactl_field(block, 'Mute')
        state_hint = 'audible' if corked == 'no' and mute == 'no' else 'silent-or-paused'
        items.append(AudioOutputInfo(
            sink_input_id=header.group(1) if header else None,
            application_name=app_name,
            process_id=process_id,
            process_binary=props.get('application.process.binary'),
            media_name=props.get('media.name'),
            node_name=props.get('node.name'),
            corked=corked,
            mute=mute,
            volume=volume,
            state_hint=state_hint,
            source='pactl-sink-inputs',
            mpris_player=mpris.get('mpris_player') or None,
            mpris_title=mpris.get('mpris_title') or None,
            mpris_artist=mpris.get('mpris_artist') or None,
            mpris_album=mpris.get('mpris_album') or None,
            mpris_status=mpris.get('mpris_status') or None,
        ))
    if system_status is not None:
        items.insert(0, system_status)
    return items


def _default_sink_audio_status() -> AudioOutputInfo | None:
    try:
        mute_output = subprocess.check_output(['pactl', 'get-sink-mute', '@DEFAULT_SINK@'], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return None
    mute_match = re.search(r'Mute:\s*(yes|no)', mute_output, re.IGNORECASE)
    mute = mute_match.group(1).lower() if mute_match else None
    try:
        volume = subprocess.check_output(['pactl', 'get-sink-volume', '@DEFAULT_SINK@'], text=True, stderr=subprocess.DEVNULL).strip().splitlines()[0]
    except Exception:
        volume = None
    try:
        default_sink = subprocess.check_output(['pactl', 'get-default-sink'], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        default_sink = '@DEFAULT_SINK@'
    state_hint = 'system-muted' if mute == 'yes' else 'system-unmuted' if mute == 'no' else 'system-mute-unknown'
    return AudioOutputInfo(
        sink_input_id='@DEFAULT_SINK@',
        application_name='System audio output',
        process_id=None,
        process_binary=None,
        media_name=f'Default sink: {default_sink}',
        node_name=default_sink,
        corked=None,
        mute=mute,
        volume=volume,
        state_hint=state_hint,
        source='pactl-default-sink',
    )


def _parse_pactl_field(block: str, name: str) -> str | None:
    match = re.search(rf'^\s*{re.escape(name)}:\s*(.+)$', block, re.MULTILINE)
    return match.group(1).strip() if match else None


def _parse_pactl_properties(block: str) -> dict[str, str]:
    props: dict[str, str] = {}
    for line in block.splitlines():
        stripped = line.strip()
        if ' = ' not in stripped:
            continue
        key, value = stripped.split(' = ', 1)
        props[key] = value.strip().strip('"')
    return props


def _browser_session_specs() -> list[dict[str, object]]:
    home = Path.home()
    return [
        {'key': 'brave', 'name': 'Brave', 'profile_dir': home / '.config/BraveSoftware/Brave-Browser/Default'},
        {'key': 'chrome', 'name': 'Google Chrome', 'profile_dir': home / '.config/google-chrome/Default'},
        {'key': 'chromium', 'name': 'Chromium', 'profile_dir': home / '.config/chromium/Default'},
        {'key': 'opera', 'name': 'Opera', 'profile_dir': home / '.config/opera'},
        {'key': 'vivaldi', 'name': 'Vivaldi', 'profile_dir': home / '.config/vivaldi/Default'},
        {'key': 'edge', 'name': 'Microsoft Edge', 'profile_dir': home / '.config/microsoft-edge/Default'},
    ]


def _is_visible_brave_process(process: ProcessInfo) -> bool:
    name = (process.process_name or '').lower()
    cmd = process.command_line or ''
    return (
        (name in {'brave', 'brave-browser', 'brave-browser-stable'} or process.exe_path == '/opt/brave.com/brave/brave')
        and '--type=' not in cmd
        and not _is_headless_or_automation_browser(process)
    )


def _is_visible_chrome_process(process: ProcessInfo) -> bool:
    name = (process.process_name or '').lower()
    exe = process.exe_path or ''
    cmd = process.command_line or ''
    return (
        (name in {'chrome', 'google-chrome', 'google-chrome-stable'} or 'google-chrome' in exe)
        and '--type=' not in cmd
        and not _is_headless_or_automation_browser(process)
    )


def _is_visible_chromium_process(process: ProcessInfo) -> bool:
    name = (process.process_name or '').lower()
    exe = process.exe_path or ''
    cmd = process.command_line or ''
    return (
        (name in {'chromium', 'chromium-browser'} or 'chromium' in exe)
        and '--type=' not in cmd
        and not _is_headless_or_automation_browser(process)
    )


def _is_visible_opera_process(process: ProcessInfo) -> bool:
    name = (process.process_name or '').lower()
    exe = (process.exe_path or '').lower()
    cmd = (process.command_line or '').lower()
    return (
        (name in {'opera', 'opera-stable'} or '/opera' in exe or '/opera' in cmd)
        and '--type=' not in cmd
        and not _is_headless_or_automation_browser(process)
    )


def _is_visible_firefox_process(process: ProcessInfo) -> bool:
    name = (process.process_name or '').lower()
    exe = (process.exe_path or '').lower()
    cmd = process.command_line or ''
    return (
        (name in {'firefox', 'firefox-esr', 'librewolf'} or 'firefox' in exe or 'librewolf' in exe)
        and '-contentproc' not in cmd
        and not _is_headless_or_automation_browser(process)
    )


def _is_headless_or_automation_browser(process: ProcessInfo) -> bool:
    cmd = process.command_line or ''
    return any(
        token in cmd
        for token in (
            '--headless',
            '--enable-automation',
            '--test-type=webdriver',
            '--ozone-platform=headless',
            '/tmp/org.chromium.Chromium.scoped_dir.',
        )
    )


def friendly_process_event(process_name: str | None, command_line: str | None) -> str | None:
    name = (process_name or '').lower()
    cmd = command_line or ''
    browser = None
    if name in {'brave', 'brave-browser', 'brave-browser-stable'} or '/brave' in cmd:
        browser = 'Brave'
    elif name in {'chrome', 'google-chrome', 'google-chrome-stable'} or 'google-chrome' in cmd:
        browser = 'Google Chrome'
    elif name in {'chromium', 'chromium-browser'} or 'chromium' in cmd:
        browser = 'Chromium'
    elif name in {'opera', 'opera-stable'} or '/opera' in cmd:
        browser = 'Opera'
    elif name in {'firefox', 'firefox-esr', 'librewolf'} or 'firefox' in cmd or 'librewolf' in cmd:
        browser = 'Firefox'
    if browser and '--type=renderer' in cmd:
        return f'{browser} tab renderer/helper process'
    if browser and '--type=' in cmd:
        m = re.search(r'--type=([^ ]+)', cmd)
        return f'{browser} {m.group(1)} helper process' if m else f'{browser} helper process'
    if browser:
        return browser
    return command_line

def _app_key_from_window(window: OpenWindowInfo) -> str:
    value = f'{window.app_name or ""} {window.wm_class or ""} {window.title or ""}'.lower()
    if 'discord' in value:
        return 'discord'
    if 'brave' in value:
        return 'brave'
    if 'chrome' in value or 'google-chrome' in value:
        return 'chrome'
    if 'chromium' in value:
        return 'chromium'
    if 'opera' in value:
        return 'opera'
    if 'firefox' in value or 'librewolf' in value:
        return 'firefox'
    if 'vivaldi' in value:
        return 'vivaldi'
    if 'edge' in value:
        return 'edge'
    if 'warp' in value:
        return 'warp'
    if window.pid is not None:
        return f'pid:{window.pid}'
    return window.window_id


def _friendly_app_name(value: str) -> str:
    lower = value.lower()
    if 'discord' in lower:
        return 'Discord'
    if 'brave' in lower:
        return 'Brave'
    if 'chrome' in lower or 'google-chrome' in lower:
        return 'Google Chrome'
    if 'chromium' in lower:
        return 'Chromium'
    if 'opera' in lower:
        return 'Opera'
    if 'firefox' in lower or 'librewolf' in lower:
        return 'Firefox'
    if 'vivaldi' in lower:
        return 'Vivaldi'
    if 'edge' in lower:
        return 'Microsoft Edge'
    if 'warp' in lower:
        return 'Warp'
    return value.split('/')[0] if '/' in value else value


def _extract_urls_from_binary(data: bytes) -> list[str]:
    urls: list[str] = []
    pattern = re.compile(r'https?://[^\s\x00<>"\']+')
    for encoding in ('utf-8', 'utf-16le'):
        text = data.decode(encoding, errors='ignore')
        urls.extend(pattern.findall(text))
    return urls


def _clean_extracted_url(url: str) -> str | None:
    url = url.strip().strip('\x00\x10\x14 $')
    url = re.sub(r'[\x00-\x1f]+.*$', '', url)
    url = url.rstrip('0123456789') if re.search(r'\D[\x00-\x1f]*\d$', url) else url
    if not url.startswith(('http://', 'https://')):
        return None
    return _scrub_sensitive_url(url)


def _scrub_sensitive_url(url: str) -> str:
    try:
        from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

        parts = urlsplit(url)
        sensitive_keys = {
            'code', 'state', 'token', 'access_token', 'id_token', 'authuser',
            'client_secret', 'login_hint', 'email', 'continue', 'redirect_uri',
            'scope', 'sacu', 'dsh', 'jsh', 'origin', 'hs', 'ilt', 'client_id',
        }
        query = []
        for key, value in parse_qsl(parts.query, keep_blank_values=True):
            query.append((key, '***' if key.lower() in sensitive_keys else value))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ''))
    except Exception:
        return url


def _is_browser_noise_url(url: str) -> bool:
    noise_parts = (
        'clients6.google.com/static/proxy.html',
        'accounts.google.com/RotateCookiesPage',
        'ogs.google.com/',
        'js.stripe.com/',
        'm.stripe.network/',
        'auth.openai.com/',
        'auth.openai.com/api/accounts/authorize',
        '/api/auth/callback/',
        'chrome://',
        'brave://',
        'opera://',
        'vivaldi://',
        'edge://',
        'about:',
    )
    return any(part in url for part in noise_parts)


def _title_from_url(url: str) -> str:
    try:
        from urllib.parse import urlparse, unquote

        parsed = urlparse(url)
        host = parsed.netloc.removeprefix('www.')
        path = unquote(parsed.path.strip('/'))
        if host == 'web.whatsapp.com':
            return 'WhatsApp Web'
        if 'mail.google.com' in host:
            return 'Gmail'
        if 'youtube.com' in host or 'youtu.be' in host:
            return 'YouTube'
        if 'chatgpt.com' in host or 'openai.com' in host:
            return 'ChatGPT'
        if path:
            return f'{host} — {path[:80]}'
        return host
    except Exception:
        return url[:120]


def _looks_like_warp_window(window: OpenWindowInfo) -> bool:
    value = f'{window.app_name or ""} {window.wm_class or ""}'.lower()
    return 'warp' in value


def _active_window_id() -> str | None:
    if which('xprop') is None:
        return None
    try:
        output = subprocess.check_output(['xprop', '-root', '_NET_ACTIVE_WINDOW'], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None

    match = re.search(r'window id # (0x[0-9a-fA-F]+)', output)
    if match:
        window_id = match.group(1)
        if window_id == '0x0':
            return None
        return window_id
    return None


def _client_window_ids() -> list[str]:
    try:
        output = subprocess.check_output(
            ['xprop', '-root', '_NET_CLIENT_LIST_STACKING', '_NET_CLIENT_LIST'],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return []

    for key in ('_NET_CLIENT_LIST_STACKING', '_NET_CLIENT_LIST'):
        match = re.search(rf'{key}\(WINDOW\): window id # (.+)', output)
        if not match:
            continue
        parts = [part.strip() for part in match.group(1).split(',') if part.strip()]
        if parts:
            return parts
    return []


def _window_title(window_id: str) -> str | None:
    if which('xprop') is None:
        return None
    try:
        output = subprocess.check_output(
            ['xprop', '-id', window_id, 'WM_NAME', '_NET_WM_NAME'],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None

    for line in output.splitlines():
        if '=' not in line:
            continue
        if 'WM_NAME' in line or '_NET_WM_NAME' in line:
            value = line.split('=', 1)[1].strip()
            if value.startswith('"') and value.endswith('"'):
                return value.strip('"')
            return value or None
    return None


def _window_pid(window_id: str) -> int | None:
    if which('xprop') is None:
        return None
    try:
        output = subprocess.check_output(
            ['xprop', '-id', window_id, '_NET_WM_PID'],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None

    match = re.search(r'_NET_WM_PID\(CARDINAL\) = (\d+)', output)
    if match:
        return int(match.group(1))
    return None


def _window_class(window_id: str) -> str | None:
    if which('xprop') is None:
        return None
    try:
        output = subprocess.check_output(
            ['xprop', '-id', window_id, 'WM_CLASS'],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return None

    match = re.search(r'WM_CLASS\(STRING\) = (.+)', output)
    if not match:
        return None
    raw = match.group(1)
    values = [value.strip().strip('"') for value in raw.split(',') if value.strip()]
    if not values:
        return None
    return '/'.join(values)


def _window_geometry(window_id: str) -> tuple[int, int, int, int] | None:
    if which('xwininfo') is None:
        return None
    try:
        output = subprocess.check_output(['xwininfo', '-id', window_id], text=True, stderr=subprocess.DEVNULL)
    except Exception:
        return None
    values: dict[str, int] = {}
    patterns = {
        'x': r'Absolute upper-left X:\s*(-?\d+)',
        'y': r'Absolute upper-left Y:\s*(-?\d+)',
        'width': r'Width:\s*(\d+)',
        'height': r'Height:\s*(\d+)',
    }
    for key, pattern in patterns.items():
        match = re.search(pattern, output)
        if not match:
            return None
        values[key] = int(match.group(1))
    return values['x'], values['y'], values['width'], values['height']


def _process_name(pid: int | None) -> str | None:
    if pid is None:
        return None
    try:
        return Path(os.readlink(f'/proc/{pid}/exe')).name
    except Exception:
        return None


def _read_stat(pid_dir: Path) -> list[str] | None:
    try:
        raw = (pid_dir / 'stat').read_text(encoding='utf-8')
    except OSError:
        return None

    close_paren = raw.rfind(')')
    if close_paren == -1:
        return None
    remainder = raw[close_paren + 2 :].strip()
    if not remainder:
        return None
    return remainder.split()


def _read_cmdline(path: Path) -> str | None:
    try:
        data = path.read_bytes()
    except OSError:
        return None
    if not data:
        return None
    parts = [part.decode('utf-8', errors='replace') for part in data.split(b'\x00') if part]
    if not parts:
        return None
    return ' '.join(parts)


def _read_comm(path: Path) -> str | None:
    try:
        value = path.read_text(encoding='utf-8').strip()
    except OSError:
        return None
    return value or None


def _read_link(path: Path) -> str | None:
    try:
        return os.readlink(path)
    except OSError:
        return None


def _read_identity(path: Path) -> tuple[int | None, str | None]:
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return None, None

    for line in lines:
        if not line.startswith('Uid:'):
            continue
        parts = line.split()
        if len(parts) < 2:
            return None, None
        uid = _safe_int(parts[1])
        if uid is None:
            return None, None
        if pwd is None:
            return uid, str(uid)
        try:
            return uid, pwd.getpwuid(uid).pw_name
        except KeyError:
            return uid, str(uid)
    return None, None


def _children_by_parent(processes: list[ProcessInfo]) -> dict[int, list[ProcessInfo]]:
    children: dict[int, list[ProcessInfo]] = defaultdict(list)
    for process in processes:
        if process.ppid is not None:
            children[process.ppid].append(process)
    for siblings in children.values():
        siblings.sort(key=lambda process: process.pid)
    return children


def _descendants(
    root_pid: int,
    children: dict[int, list[ProcessInfo]],
    process_map: dict[int, ProcessInfo],
) -> list[ProcessInfo]:
    descendants: list[ProcessInfo] = []
    queue = list(children.get(root_pid, []))
    seen: set[int] = set()
    while queue:
        process = queue.pop(0)
        if process.pid in seen:
            continue
        seen.add(process.pid)
        descendants.append(process)
        queue.extend(children.get(process.pid, []))
    descendants.sort(key=lambda process: process.pid)
    return descendants


def _choose_warp_shell(descendants: list[ProcessInfo]) -> ProcessInfo | None:
    shells = [
        process
        for process in descendants
        if (process.process_name or '').lower() in {'bash', 'zsh', 'fish', 'sh'}
    ]
    if not shells:
        return None
    shells.sort(key=lambda process: process.pid)
    return shells[0]


def _choose_warp_command(descendants: list[ProcessInfo]) -> ProcessInfo | None:
    candidates = [process for process in descendants if _is_interesting_warp_command(process)]
    if not candidates:
        return None
    candidates.sort(key=lambda process: (_process_depth_hint(process.command_line), process.pid), reverse=True)
    return candidates[0]


def _is_interesting_warp_command(process: ProcessInfo) -> bool:
    command_line = (process.command_line or '').strip()
    process_name = (process.process_name or '').lower()
    if not command_line:
        return False
    if process_name in {'warp', 'warp-terminal', 'xdg-open'}:
        return False
    if 'warp-terminal' in command_line or 'terminal-server' in command_line or 'minidump-server' in command_line:
        return False
    if process_name in {'bash', 'zsh', 'fish', 'sh'}:
        return False
    return True


def _process_depth_hint(command_line: str | None) -> int:
    if not command_line:
        return 0
    return len(command_line.split())


def _safe_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import grp
import json
import os
import pwd
import queue
import re
import shutil
import stat
import subprocess
import threading
import time
from typing import Any

try:  # Optional at import time so tests and non-Linux hosts still work.
    import evdev  # type: ignore[import-not-found]
    from evdev import InputDevice, categorize, ecodes  # type: ignore[import-not-found]
except Exception:  # pragma: no cover - exercised on hosts without evdev.
    evdev = None
    InputDevice = None
    categorize = None
    ecodes = None


KEY_MAP = {
    'KEY_A': 'a', 'KEY_B': 'b', 'KEY_C': 'c', 'KEY_D': 'd', 'KEY_E': 'e',
    'KEY_F': 'f', 'KEY_G': 'g', 'KEY_H': 'h', 'KEY_I': 'i', 'KEY_J': 'j',
    'KEY_K': 'k', 'KEY_L': 'l', 'KEY_M': 'm', 'KEY_N': 'n', 'KEY_O': 'o',
    'KEY_P': 'p', 'KEY_Q': 'q', 'KEY_R': 'r', 'KEY_S': 's', 'KEY_T': 't',
    'KEY_U': 'u', 'KEY_V': 'v', 'KEY_W': 'w', 'KEY_X': 'x', 'KEY_Y': 'y',
    'KEY_Z': 'z',
    'KEY_1': '1', 'KEY_2': '2', 'KEY_3': '3', 'KEY_4': '4', 'KEY_5': '5',
    'KEY_6': '6', 'KEY_7': '7', 'KEY_8': '8', 'KEY_9': '9', 'KEY_0': '0',
    'KEY_SPACE': ' ', 'KEY_DOT': '.', 'KEY_COMMA': ',', 'KEY_SLASH': '/',
    'KEY_BACKSLASH': '\\', 'KEY_SEMICOLON': ';', 'KEY_APOSTROPHE': "'",
    'KEY_MINUS': '-', 'KEY_EQUAL': '=', 'KEY_LEFTBRACE': '[',
    'KEY_RIGHTBRACE': ']', 'KEY_GRAVE': '`',
}

SHIFT_MAP = {
    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^',
    '7': '&', '8': '*', '9': '(', '0': ')', '.': '>', ',': '<',
    '/': '?', '\\': '|', ';': ':', "'": '"', '-': '_', '=': '+',
    '[': '{', ']': '}', '`': '~',
}

MODIFIER_KEYS = {
    'KEY_LEFTSHIFT', 'KEY_RIGHTSHIFT', 'KEY_LEFTCTRL', 'KEY_RIGHTCTRL',
    'KEY_LEFTALT', 'KEY_RIGHTALT', 'KEY_LEFTMETA', 'KEY_RIGHTMETA',
}

SHORTCUT_MODIFIERS = {
    'KEY_LEFTCTRL', 'KEY_RIGHTCTRL', 'KEY_LEFTALT', 'KEY_RIGHTALT',
    'KEY_LEFTMETA', 'KEY_RIGHTMETA',
}

X11_KEY_ALIASES = {
    'Shift_L': 'KEY_LEFTSHIFT', 'Shift_R': 'KEY_RIGHTSHIFT',
    'Control_L': 'KEY_LEFTCTRL', 'Control_R': 'KEY_RIGHTCTRL',
    'Alt_L': 'KEY_LEFTALT', 'Alt_R': 'KEY_RIGHTALT',
    'Super_L': 'KEY_LEFTMETA', 'Super_R': 'KEY_RIGHTMETA',
    'Return': 'KEY_ENTER', 'BackSpace': 'KEY_BACKSPACE', 'Tab': 'KEY_TAB',
    'space': 'KEY_SPACE', 'period': 'KEY_DOT', 'comma': 'KEY_COMMA',
    'slash': 'KEY_SLASH', 'backslash': 'KEY_BACKSLASH',
    'semicolon': 'KEY_SEMICOLON', 'apostrophe': 'KEY_APOSTROPHE',
    'minus': 'KEY_MINUS', 'equal': 'KEY_EQUAL',
    'bracketleft': 'KEY_LEFTBRACE', 'bracketright': 'KEY_RIGHTBRACE',
    'grave': 'KEY_GRAVE',
}

X11_SHIFT_KEYSYMS = {
    'exclam': 'KEY_1', 'at': 'KEY_2', 'numbersign': 'KEY_3', 'dollar': 'KEY_4',
    'percent': 'KEY_5', 'asciicircum': 'KEY_6', 'ampersand': 'KEY_7', 'asterisk': 'KEY_8',
    'parenleft': 'KEY_9', 'parenright': 'KEY_0', 'greater': 'KEY_DOT', 'less': 'KEY_COMMA',
    'question': 'KEY_SLASH', 'bar': 'KEY_BACKSLASH', 'colon': 'KEY_SEMICOLON',
    'quotedbl': 'KEY_APOSTROPHE', 'underscore': 'KEY_MINUS', 'plus': 'KEY_EQUAL',
    'braceleft': 'KEY_LEFTBRACE', 'braceright': 'KEY_RIGHTBRACE', 'asciitilde': 'KEY_GRAVE',
}


@dataclass(frozen=True)
class KeyboardChunkSettings:
    enabled: bool = False
    idle_seconds: float = 2.5
    max_chunk_seconds: float = 30.0


class KeyboardChunkRecorder:
    """Jerry's keyboard chunk recorder integrated as an agent component.

    It keeps the exact behavior of the supplied script: character mapping, shift
    mapping, backspace mutation, enter/idle/max-time flushing, and shortcut
    events. Runtime device listening is optional and Linux/evdev-only.
    """

    def __init__(self, data_dir: Path | str, idle_seconds: float = 2.5, max_chunk_seconds: float = 30.0, debug: bool = False):
        self.data_dir = Path(data_dir).expanduser()
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.idle_seconds = idle_seconds
        self.max_chunk_seconds = max_chunk_seconds
        self.debug = debug
        self.running = False
        self.event_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self.current_text = ''
        self.current_keys: list[str] = []
        self.current_start_ts: str | None = None
        self.current_last_ts: str | None = None
        self.pressed: set[str] = set()
        self._threads: list[threading.Thread] = []
        self.status: dict[str, Any] = {
            'enabled': True,
            'running': False,
            'device_count': 0,
            'status': 'not_started',
            'reason': 'recorder has not started yet',
        }

    def now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def key_to_char(self, key_name: str) -> str | None:
        if key_name not in KEY_MAP:
            return None
        ch = KEY_MAP[key_name]
        shift = 'KEY_LEFTSHIFT' in self.pressed or 'KEY_RIGHTSHIFT' in self.pressed
        if shift:
            if ch.isalpha():
                return ch.upper()
            return SHIFT_MAP.get(ch, ch)
        return ch

    def flush_chunk(self, reason: str = 'idle') -> None:
        if not self.current_text and not self.current_keys:
            return
        start_ts = self.current_start_ts or self.now_iso()
        end_ts = self.current_last_ts or self.now_iso()
        try:
            duration = max(0.0, (datetime.fromisoformat(end_ts) - datetime.fromisoformat(start_ts)).total_seconds())
        except Exception:
            duration = None
        row: dict[str, Any] = {
            'type': 'typed_chunk',
            'reason': reason,
            'start_ts': start_ts,
            'end_ts': end_ts,
            'duration_seconds': duration,
            'text': self.current_text,
            'key_count': len(self.current_keys),
            'keys': list(self.current_keys),
        }
        self.event_queue.put(row)
        if self.debug:
            print(f"[chunk:{reason}] {self.current_text!r}")
        self.current_text = ''
        self.current_keys = []
        self.current_start_ts = None
        self.current_last_ts = None

    def add_key_to_chunk(self, key_name: str, char: str | None) -> None:
        ts = self.now_iso()
        if self.current_start_ts is None:
            self.current_start_ts = ts
        self.current_last_ts = ts
        self.current_keys.append(key_name)
        if char is not None:
            self.current_text += char
        try:
            if (datetime.fromisoformat(ts) - datetime.fromisoformat(self.current_start_ts)).total_seconds() >= self.max_chunk_seconds:
                self.flush_chunk(reason='max_time')
        except Exception:
            pass

    def save_shortcut(self, key_name: str) -> None:
        keys = sorted(self.pressed | {key_name})
        shortcut = '+'.join(keys)
        row: dict[str, Any] = {
            'type': 'shortcut',
            'ts': self.now_iso(),
            'shortcut': shortcut,
            'keys': keys,
        }
        self.event_queue.put(row)
        if self.debug:
            print(f'[shortcut] {shortcut}')

    def handle_key_down(self, key_name: str) -> None:
        if key_name in MODIFIER_KEYS:
            self.pressed.add(key_name)
            return
        if any(key in self.pressed for key in SHORTCUT_MODIFIERS):
            self.flush_chunk(reason='shortcut')
            self.save_shortcut(key_name)
            return
        if key_name == 'KEY_ENTER':
            self.add_key_to_chunk(key_name, '\n')
            self.flush_chunk(reason='enter')
            return
        if key_name == 'KEY_BACKSPACE':
            ts = self.now_iso()
            if self.current_start_ts is None:
                self.current_start_ts = ts
            self.current_last_ts = ts
            self.current_keys.append(key_name)
            self.current_text = self.current_text[:-1]
            return
        if key_name == 'KEY_TAB':
            self.add_key_to_chunk(key_name, '\t')
            return
        char = self.key_to_char(key_name)
        if char is not None:
            self.add_key_to_chunk(key_name, char)
        elif key_name.startswith('KEY_'):
            self.add_key_to_chunk(key_name, None)

    def handle_key_up(self, key_name: str) -> None:
        self.pressed.discard(key_name)

    def drain_events(self, limit: int = 120) -> list[dict[str, Any]]:
        self.flush_idle_if_needed()
        rows = []
        while len(rows) < limit:
            try:
                rows.append(self.event_queue.get_nowait())
            except queue.Empty:
                break
        return rows

    def flush_idle_if_needed(self) -> None:
        if not self.current_last_ts:
            return
        try:
            last_dt = datetime.fromisoformat(self.current_last_ts)
            if (datetime.now(timezone.utc) - last_dt).total_seconds() >= self.idle_seconds:
                self.flush_chunk(reason='idle')
        except Exception:
            pass

    def input_permission_diagnostics(self, paths: list[str] | None = None) -> dict[str, Any]:
        paths = paths or sorted(str(path) for path in Path('/dev/input').glob('event*'))[:20]
        groups: list[str] = []
        try:
            groups = [grp.getgrgid(gid).gr_name for gid in os.getgroups()]
        except Exception:
            groups = []
        devices: list[dict[str, Any]] = []
        for path in paths[:20]:
            info: dict[str, Any] = {'path': path, 'readable': os.access(path, os.R_OK)}
            try:
                st = os.stat(path)
                info.update({
                    'mode': stat.filemode(st.st_mode),
                    'uid': st.st_uid,
                    'gid': st.st_gid,
                    'owner': pwd.getpwuid(st.st_uid).pw_name,
                    'group': grp.getgrgid(st.st_gid).gr_name,
                })
            except Exception as exc:
                info['error'] = str(exc)
            devices.append(info)
        return {
            'uid': os.getuid() if hasattr(os, 'getuid') else None,
            'user': pwd.getpwuid(os.getuid()).pw_name if hasattr(os, 'getuid') else None,
            'groups': groups,
            'devices': devices,
        }

    def _x11_keymap(self) -> dict[int, str]:
        xmodmap = shutil.which('xmodmap')
        if not xmodmap:
            return {}
        try:
            out = subprocess.check_output([xmodmap, '-pke'], stderr=subprocess.DEVNULL, text=True, timeout=2)
        except Exception:
            return {}
        mapping: dict[int, str] = {}
        for line in out.splitlines():
            match = re.match(r'keycode\s+(\d+)\s+=\s+(.+)$', line.strip())
            if not match:
                continue
            symbols = [part for part in match.group(2).split() if part and part != 'NoSymbol']
            if symbols:
                mapping[int(match.group(1))] = symbols[0]
        return mapping

    def _key_name_from_x11_keysym(self, keysym: str) -> str | None:
        if keysym in X11_KEY_ALIASES:
            return X11_KEY_ALIASES[keysym]
        if keysym in X11_SHIFT_KEYSYMS:
            return X11_SHIFT_KEYSYMS[keysym]
        if len(keysym) == 1:
            if keysym.isalpha():
                return f'KEY_{keysym.upper()}'
            if keysym.isdigit():
                return f'KEY_{keysym}'
        return None

    def _handle_xinput_keycode(self, keycode: int, event_type: str, keymap: dict[int, str]) -> None:
        keysym = keymap.get(keycode)
        key_name = self._key_name_from_x11_keysym(keysym or '')
        if not key_name:
            return
        if event_type == 'down':
            self.handle_key_down(key_name)
        elif event_type == 'up':
            self.handle_key_up(key_name)

    def _handle_xinput_line(self, line: str, state: dict[str, Any], keymap: dict[int, str]) -> None:
        # xinput test <device-id> emits single-line records like "key press   38".
        legacy = re.search(r'key\s+(press|release)\s+(\d+)', line, re.IGNORECASE)
        if legacy:
            event_type = 'down' if legacy.group(1).lower() == 'press' else 'up'
            self._handle_xinput_keycode(int(legacy.group(2)), event_type, keymap)
            return

        # xinput test-xi2 --root emits an event header then a detail line.
        if 'RawKeyPress' in line or 'KeyPress' in line:
            state['event'] = 'down'
            return
        if 'RawKeyRelease' in line or 'KeyRelease' in line:
            state['event'] = 'up'
            return
        match = re.search(r'detail:\s*(\d+)', line)
        if not match or state.get('event') not in {'down', 'up'}:
            return
        event_type = state.pop('event', None)
        self._handle_xinput_keycode(int(match.group(1)), str(event_type), keymap)

    def _xinput_keyboard_ids(self, xinput_path: str) -> list[str]:
        try:
            out = subprocess.check_output([xinput_path, 'list', '--short'], stderr=subprocess.DEVNULL, text=True, timeout=2)
        except Exception:
            return []
        ids: list[str] = []
        for line in out.splitlines():
            lower = line.lower()
            if not re.search(r'\bslave\s+keyboard\b', lower):
                continue
            if 'xtest' in lower or 'virtual core' in lower:
                continue
            match = re.search(r'id=(\d+)', line)
            if match:
                ids.append(match.group(1))
        return ids

    def _open_xinput_processes(self, xinput_path: str) -> list[tuple[subprocess.Popen[str], str]]:
        processes: list[tuple[subprocess.Popen[str], str]] = []
        for device_id in self._xinput_keyboard_ids(xinput_path)[:8]:
            try:
                processes.append((subprocess.Popen(
                    [xinput_path, 'test', device_id],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    bufsize=1,
                ), f'xinput-test-{device_id}'))
            except Exception:
                continue
        # Keep the XI2 root stream too; some setups expose only master/root events.
        try:
            processes.append((subprocess.Popen(
                [xinput_path, 'test-xi2', '--root'],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            ), 'xinput-test-xi2-root'))
        except Exception:
            pass
        return processes

    def _start_xinput_listener(self) -> bool:
        if not os.environ.get('DISPLAY'):
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'no_readable_keyboard_devices',
                'reason': 'no readable evdev keyboard devices and DISPLAY is not set for X11 fallback',
                'permission_diagnostics': self.input_permission_diagnostics(),
            }
            return False
        xinput = shutil.which('xinput')
        if not xinput:
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'xinput_unavailable',
                'reason': 'no readable evdev keyboard devices and xinput is unavailable for X11 fallback',
                'permission_diagnostics': self.input_permission_diagnostics(),
            }
            return False
        keymap = self._x11_keymap()
        if not keymap:
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'x11_keymap_unavailable',
                'reason': 'no readable evdev keyboard devices and xmodmap did not return an X11 keymap',
                'permission_diagnostics': self.input_permission_diagnostics(),
            }
            return False
        processes = self._open_xinput_processes(xinput)
        if not processes:
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'xinput_start_failed',
                'reason': 'xinput was available but no keyboard event streams could be opened',
                'permission_diagnostics': self.input_permission_diagnostics(),
            }
            return False
        self.running = True
        self.status = {
            'enabled': True,
            'running': True,
            'device_count': len(processes),
            'status': 'listening_xinput_fallback',
            'reason': f'evdev keyboard devices were not readable; listening through {len(processes)} X11 xinput fallback stream(s)',
            'xinput_streams': [name for _process, name in processes],
            'permission_diagnostics': self.input_permission_diagnostics(),
        }
        idle_thread = threading.Thread(target=self._idle_watcher, daemon=True)
        idle_thread.start()
        self._threads.append(idle_thread)
        for process, name in processes:
            thread = threading.Thread(target=self._xinput_thread, args=(process, keymap, name), daemon=True)
            thread.start()
            self._threads.append(thread)
        return True

    def _xinput_thread(self, process: subprocess.Popen[str], keymap: dict[int, str], stream_name: str = 'xinput') -> None:
        state: dict[str, Any] = {}
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if not self.running:
                    break
                self._handle_xinput_line(line, state, keymap)
        except Exception as exc:
            if self.debug:
                print(f'[xinput keyboard fallback error] {stream_name}: {exc}')
        finally:
            if process.poll() is None:
                try:
                    process.terminate()
                except Exception:
                    pass
            # Individual xinput streams can exit when devices disappear/reappear; keep
            # the fallback marked listening because sibling streams may still be active.

    def list_keyboard_devices(self) -> list[Any]:
        if evdev is None or InputDevice is None or ecodes is None:
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'evdev_unavailable',
                'reason': 'python evdev package is unavailable; rerun the tracker installer so dependencies are installed',
            }
            return []
        import glob

        devices = []
        errors: list[str] = []
        paths = list(evdev.list_devices()) or sorted(glob.glob('/dev/input/event*'))
        for path in paths:
            try:
                dev = InputDevice(path)
                caps = dev.capabilities()
                if ecodes.EV_KEY not in caps:
                    continue
                key_codes = caps.get(ecodes.EV_KEY, [])
                key_names = set()
                for code in key_codes:
                    name = ecodes.KEY.get(code)
                    if isinstance(name, list):
                        key_names.update(name)
                    elif isinstance(name, str):
                        key_names.add(name)
                if any(key in key_names for key in ('KEY_A', 'KEY_E', 'KEY_SPACE', 'KEY_ENTER')):
                    devices.append(dev)
                else:
                    dev.close()
            except Exception as exc:
                errors.append(f'{path}: {exc}')
        if not devices:
            self.status = {
                'enabled': True,
                'running': False,
                'device_count': 0,
                'status': 'no_readable_keyboard_devices',
                'reason': 'no readable keyboard-like /dev/input/event* devices; grant input-device permissions or rerun the installer with sudo',
                'checked_paths': paths[:20],
                'failed_paths': errors[:20],
                'permission_diagnostics': self.input_permission_diagnostics(paths),
            }
        return devices

    def start(self) -> None:
        if self.running:
            return
        devices = self.list_keyboard_devices()
        if not devices:
            if self._start_xinput_listener():
                return
            if self.debug:
                print('No keyboard devices found or evdev unavailable; keyboard chunks disabled until permissions/dependency are fixed.')
            return
        self.running = True
        self.status = {
            'enabled': True,
            'running': True,
            'device_count': len(devices),
            'status': 'listening',
            'reason': f'listening to {len(devices)} keyboard device(s)',
            'devices': [getattr(dev, 'path', None) or getattr(dev, 'fn', None) or getattr(dev, 'name', 'unknown') for dev in devices[:20]],
        }
        idle_thread = threading.Thread(target=self._idle_watcher, daemon=True)
        idle_thread.start()
        self._threads.append(idle_thread)
        for dev in devices:
            thread = threading.Thread(target=self._device_thread, args=(dev,), daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        self.running = False
        self.flush_chunk(reason='stop')

    def _idle_watcher(self) -> None:
        while self.running:
            time.sleep(0.25)
            self.flush_idle_if_needed()

    def _device_thread(self, dev: Any) -> None:
        if categorize is None or ecodes is None:
            return
        try:
            for event in dev.read_loop():
                if not self.running:
                    break
                if event.type != ecodes.EV_KEY:
                    continue
                key_event = categorize(event)
                key_name = key_event.keycode
                if isinstance(key_name, list):
                    key_name = key_name[0]
                if key_event.keystate == key_event.key_down:
                    self.handle_key_down(key_name)
                elif key_event.keystate == key_event.key_up:
                    self.handle_key_up(key_name)
        except Exception as exc:
            if self.debug:
                print(f'[keyboard device error] {getattr(dev, "name", "unknown")}: {exc}')


def serialize_keys(keys: object) -> str:
    if isinstance(keys, str):
        return keys
    if isinstance(keys, (list, tuple, set)):
        return json.dumps(list(keys), ensure_ascii=False)
    return '[]'

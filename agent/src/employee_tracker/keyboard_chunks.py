from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
import json
import queue
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

    def list_keyboard_devices(self) -> list[Any]:
        if evdev is None or InputDevice is None or ecodes is None:
            return []
        devices = []
        for path in evdev.list_devices():
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
            except Exception:
                pass
        return devices

    def start(self) -> None:
        if self.running:
            return
        devices = self.list_keyboard_devices()
        if not devices:
            if self.debug:
                print('No keyboard devices found or evdev unavailable; keyboard chunks disabled until permissions/dependency are fixed.')
            return
        self.running = True
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

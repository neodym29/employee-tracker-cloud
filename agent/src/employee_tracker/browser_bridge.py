from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass(frozen=True)
class BrowserTabInfo:
    browser: str
    app_key: str
    tab_id: int | None
    window_id: int | None
    window_focused: bool
    active: bool
    audible: bool
    muted: bool
    title: str | None
    url: str | None
    fav_icon_url: str | None
    source: str = 'browser-extension'




@dataclass(frozen=True)
class BrowserFocusEventInfo:
    browser: str
    app_key: str
    from_window_id: str | None
    from_title: str | None
    from_app_name: str | None
    to_window_id: str
    to_title: str | None
    to_app_name: str
    to_window_class: str
    reason: str
    source: str = 'browser-extension'


@dataclass(frozen=True)
class GnomeWindowInfo:
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
    source: str = 'gnome-shell-extension'


@dataclass(frozen=True)
class BrowserClickInfo:
    browser: str
    app_key: str
    tab_id: int | None
    window_id: int | None
    title: str | None
    url: str | None
    audible: bool
    muted: bool
    active: bool
    button: int | None
    x: float | None
    y: float | None
    screen_x: float | None
    screen_y: float | None
    target_text: str | None
    tag_name: str | None
    element_id: str | None
    class_name: str | None
    href: str | None
    source: str = 'browser-extension'


@dataclass(frozen=True)
class BrowserTypingInfo:
    browser: str
    app_key: str
    tab_id: int | None
    window_id: int | None
    title: str | None
    url: str | None
    tag_name: str | None
    input_type: str | None
    field_hint: str | None
    key_count: int
    text_length: int
    word_count: int
    typed_sample_redacted: str | None
    sensitive: bool
    source: str = 'browser-extension'


@dataclass(frozen=True)
class BrowserScreenshotInfo:
    browser: str
    app_key: str
    tab_id: int | None
    window_id: int | None
    title: str | None
    url: str | None
    data_url: str
    captured_at: str | None
    received_at: float
    source: str = 'browser-extension-captureVisibleTab'


class BrowserBridge:
    def __init__(self, host: str = '127.0.0.1', port: int = 8766) -> None:
        self.host = host
        self.port = port
        self._lock = threading.Lock()
        self._tabs: list[BrowserTabInfo] = []
        self._clicks: list[BrowserClickInfo] = []
        self._typing_events: list[BrowserTypingInfo] = []
        self._screenshots: list[BrowserScreenshotInfo] = []
        self._focus_events: list[BrowserFocusEventInfo] = []
        self._last_active_tab_by_app: dict[str, BrowserTabInfo] = {}
        self._gnome_windows: list[GnomeWindowInfo] = []
        self._gnome_last_seen: float = 0.0
        self._last_seen: float = 0.0
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._server is not None:
            return
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_OPTIONS(self) -> None:  # noqa: N802
                self._send_json({'ok': True})

            def do_POST(self) -> None:  # noqa: N802
                try:
                    length = min(int(self.headers.get('Content-Length', '0')), 4_000_000)
                    payload = json.loads(self.rfile.read(length).decode('utf-8')) if length else {}
                    if self.path == '/browser-state':
                        bridge.update_state(payload)
                        self._send_json({'ok': True})
                        return
                    if self.path == '/browser-click':
                        bridge.add_click(payload)
                        self._send_json({'ok': True})
                        return
                    if self.path == '/browser-typing':
                        bridge.add_typing_event(payload)
                        self._send_json({'ok': True})
                        return
                    if self.path == '/browser-screenshot':
                        bridge.add_screenshot(payload)
                        self._send_json({'ok': True})
                        return
                    if self.path == '/browser-focus':
                        bridge.add_focus_event(payload)
                        self._send_json({'ok': True})
                        return
                    if self.path == '/gnome-state':
                        bridge.update_gnome_state(payload)
                        self._send_json({'ok': True})
                        return
                    self._send_json({'ok': False, 'error': 'not found'}, status=404)
                except Exception as exc:  # pragma: no cover
                    self._send_json({'ok': False, 'error': str(exc)}, status=500)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
                return

            def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
                body = json.dumps(payload).encode('utf-8')
                self.send_response(status)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Access-Control-Allow-Headers', 'content-type')
                self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        try:
            self._server = ThreadingHTTPServer((self.host, self.port), Handler)
        except OSError:
            self._server = None
            return
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def update_state(self, payload: dict[str, Any]) -> None:
        browser = _browser_name(payload.get('browser'))
        app_key = _app_key(browser)
        tabs: list[BrowserTabInfo] = []
        for raw in payload.get('tabs') or []:
            if not isinstance(raw, dict):
                continue
            tabs.append(
                BrowserTabInfo(
                    browser=browser,
                    app_key=app_key,
                    tab_id=_safe_int(raw.get('id')),
                    window_id=_safe_int(raw.get('windowId')),
                    window_focused=bool(raw.get('windowFocused')),
                    active=bool(raw.get('active')),
                    audible=bool(raw.get('audible')),
                    muted=bool((raw.get('mutedInfo') or {}).get('muted')),
                    title=_clean_text(raw.get('title'), 300),
                    url=_clean_text(raw.get('url'), 1000),
                    fav_icon_url=_clean_text(raw.get('favIconUrl'), 1000),
                )
            )
        active_tab = _active_browser_tab(tabs)
        with self._lock:
            if active_tab is not None:
                self._queue_focus_event_locked(active_tab, reason='browser-tab-state-active')
            # Extension state is authoritative for its browser; preserve other browsers.
            self._tabs = [tab for tab in self._tabs if tab.app_key != app_key] + tabs
            self._last_seen = time.time()

    def add_click(self, payload: dict[str, Any]) -> None:
        browser = _browser_name(payload.get('browser'))
        app_key = _app_key(browser)
        click = BrowserClickInfo(
            browser=browser,
            app_key=app_key,
            tab_id=_safe_int(payload.get('tabId')),
            window_id=_safe_int(payload.get('windowId')),
            title=_clean_text(payload.get('title'), 300),
            url=_clean_text(payload.get('url'), 1000),
            audible=bool(payload.get('audible')),
            muted=bool(payload.get('muted')),
            active=bool(payload.get('active')),
            button=_safe_int(payload.get('button')),
            x=_safe_float(payload.get('x')),
            y=_safe_float(payload.get('y')),
            screen_x=_safe_float(payload.get('screenX')),
            screen_y=_safe_float(payload.get('screenY')),
            target_text=_clean_text(payload.get('targetText'), 300),
            tag_name=_clean_text(payload.get('tagName'), 80),
            element_id=_clean_text(payload.get('elementId'), 120),
            class_name=_clean_text(payload.get('className'), 180),
            href=_clean_text(payload.get('href'), 1000),
        )
        with self._lock:
            self._clicks.append(click)
            self._clicks = self._clicks[-500:]
            self._last_seen = time.time()

    def add_typing_event(self, payload: dict[str, Any]) -> None:
        browser = _browser_name(payload.get('browser'))
        app_key = _app_key(browser)
        event = BrowserTypingInfo(
            browser=browser,
            app_key=app_key,
            tab_id=_safe_int(payload.get('tabId')),
            window_id=_safe_int(payload.get('windowId')),
            title=_clean_text(payload.get('title'), 300),
            url=_clean_text(payload.get('url'), 1000),
            tag_name=_clean_text(payload.get('tagName'), 80),
            input_type=_clean_text(payload.get('inputType'), 80),
            field_hint=_clean_text(payload.get('fieldHint'), 180),
            key_count=max(0, _safe_int(payload.get('keyCount')) or 0),
            text_length=max(0, _safe_int(payload.get('textLength')) or 0),
            word_count=max(0, _safe_int(payload.get('wordCount')) or 0),
            typed_sample_redacted=_clean_text(payload.get('typed_sample_redacted'), 500),
            sensitive=bool(payload.get('sensitive')),
        )
        with self._lock:
            self._typing_events.append(event)
            self._typing_events = self._typing_events[-500:]
            self._last_seen = time.time()

    def add_screenshot(self, payload: dict[str, Any]) -> None:
        browser = _browser_name(payload.get('browser'))
        app_key = _app_key(browser)
        data_url = _clean_text(payload.get('dataUrl'), 4_000_000)
        if not data_url or not data_url.startswith('data:image/'):
            return
        screenshot = BrowserScreenshotInfo(
            browser=browser,
            app_key=app_key,
            tab_id=_safe_int(payload.get('tabId')),
            window_id=_safe_int(payload.get('windowId')),
            title=_clean_text(payload.get('title'), 300),
            url=_clean_text(payload.get('url'), 1000),
            data_url=data_url,
            captured_at=_clean_text(payload.get('capturedAt'), 80),
            received_at=time.time(),
        )
        with self._lock:
            self._screenshots.append(screenshot)
            self._screenshots = self._screenshots[-20:]
            self._last_seen = time.time()

    def latest_screenshot(self, tab: BrowserTabInfo | None = None, max_age_seconds: int = 45) -> BrowserScreenshotInfo | None:
        with self._lock:
            screenshots = list(self._screenshots)
        if not screenshots:
            return None
        now = time.time()
        for screenshot in reversed(screenshots):
            if tab is not None:
                if tab.tab_id is not None and screenshot.tab_id != tab.tab_id:
                    continue
                if tab.window_id is not None and screenshot.window_id != tab.window_id:
                    continue
            # Browser extension screenshots are pushed periodically; keep the
            # freshness check conservative without trusting client clocks.
            if now - screenshot.received_at <= max_age_seconds:
                return screenshot
        return None

    def add_focus_event(self, payload: dict[str, Any]) -> None:
        browser = _browser_name(payload.get('browser'))
        app_key = _app_key(browser)
        tab = BrowserTabInfo(
            browser=browser,
            app_key=app_key,
            tab_id=_safe_int(payload.get('tabId')),
            window_id=_safe_int(payload.get('windowId')),
            window_focused=True,
            active=True,
            audible=bool(payload.get('audible')),
            muted=bool(payload.get('muted')),
            title=_clean_text(payload.get('title'), 300),
            url=_clean_text(payload.get('url'), 1000),
            fav_icon_url=None,
        )
        with self._lock:
            self._queue_focus_event_locked(tab, reason=_clean_text(payload.get('reason'), 120) or 'browser-tab-activated')
            self._last_seen = time.time()

    def _queue_focus_event_locked(self, tab: BrowserTabInfo, reason: str) -> None:
        if tab.tab_id is None or tab.window_id is None:
            return
        previous = self._last_active_tab_by_app.get(tab.app_key)
        to_window_id = _browser_window_id(tab)
        if previous is not None and _browser_window_id(previous) == to_window_id and previous.title == tab.title and previous.url == tab.url:
            return
        title = _tab_focus_title(tab)
        previous_title = _tab_focus_title(previous) if previous is not None else None
        self._focus_events.append(
            BrowserFocusEventInfo(
                browser=tab.browser,
                app_key=tab.app_key,
                from_window_id=_browser_window_id(previous) if previous is not None else None,
                from_title=previous_title,
                from_app_name=previous.browser if previous is not None else None,
                to_window_id=to_window_id,
                to_title=title,
                to_app_name=tab.browser,
                to_window_class=tab.app_key,
                reason=reason,
            )
        )
        self._focus_events = self._focus_events[-500:]
        self._last_active_tab_by_app[tab.app_key] = tab

    def read_focus_events(self) -> list[BrowserFocusEventInfo]:
        with self._lock:
            events = list(self._focus_events)
            self._focus_events.clear()
            return events

    def current_tabs(self, max_age_seconds: int = 15) -> list[BrowserTabInfo]:
        with self._lock:
            if time.time() - self._last_seen > max_age_seconds:
                return []
            return list(self._tabs)

    def active_tab(self) -> BrowserTabInfo | None:
        return _active_browser_tab(self.current_tabs())

    def read_clicks(self) -> list[BrowserClickInfo]:
        with self._lock:
            clicks = list(self._clicks)
            self._clicks.clear()
            return clicks

    def read_typing_events(self) -> list[BrowserTypingInfo]:
        with self._lock:
            events = list(self._typing_events)
            self._typing_events.clear()
            return events

    def update_gnome_state(self, payload: dict[str, Any]) -> None:
        windows: list[GnomeWindowInfo] = []
        for raw in payload.get('windows') or []:
            if not isinstance(raw, dict):
                continue
            window_id = _clean_text(raw.get('windowId'), 300)
            if not window_id:
                continue
            windows.append(
                GnomeWindowInfo(
                    window_id=window_id,
                    title=_clean_text(raw.get('title'), 500),
                    pid=_safe_int(raw.get('pid')),
                    app_name=_clean_text(raw.get('appName') or raw.get('wmClass'), 120),
                    wm_class=_clean_text(raw.get('wmClass'), 120),
                    is_active=bool(raw.get('isActive')),
                    x=_safe_int(raw.get('x')),
                    y=_safe_int(raw.get('y')),
                    width=_safe_int(raw.get('width')),
                    height=_safe_int(raw.get('height')),
                )
            )
        with self._lock:
            self._gnome_windows = windows
            self._gnome_last_seen = time.time()

    def ingest_gnome_state_file(self, path: Path | None = None, max_age_seconds: int = 10) -> None:
        path = path or (Path.home() / '.cache/employee-tracker/gnome-state.json')
        try:
            if time.time() - path.stat().st_mtime > max_age_seconds:
                return
            payload = json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            return
        if isinstance(payload, dict):
            self.update_gnome_state(payload)

    def current_gnome_windows(self, max_age_seconds: int = 10) -> list[GnomeWindowInfo]:
        with self._lock:
            if time.time() - self._gnome_last_seen > max_age_seconds:
                return []
            return list(self._gnome_windows)

    def active_gnome_window(self) -> GnomeWindowInfo | None:
        windows = self.current_gnome_windows()
        active = [window for window in windows if window.is_active]
        return active[0] if active else None


def _active_browser_tab(tabs: list[BrowserTabInfo]) -> BrowserTabInfo | None:
    focused_active = [tab for tab in tabs if tab.active and tab.window_focused]
    if focused_active:
        return focused_active[0]
    active = [tab for tab in tabs if tab.active]
    return active[0] if active else None


def _browser_window_id(tab: BrowserTabInfo | None) -> str | None:
    if tab is None:
        return None
    return f'browser:{tab.app_key}:window:{tab.window_id}:tab:{tab.tab_id}'


def _tab_focus_title(tab: BrowserTabInfo | None) -> str | None:
    if tab is None:
        return None
    title = tab.title or 'Untitled browser tab'
    if tab.url:
        return f'{title} — {tab.url}'
    return title


def _browser_name(value: Any) -> str:
    raw = str(value or '').strip()
    text = raw.lower()
    if 'brave' in text:
        return 'Brave'
    if 'firefox' in text or 'librewolf' in text:
        return 'Firefox'
    if 'edge' in text or 'edg/' in text or 'microsoft-edge' in text:
        return 'Microsoft Edge'
    if 'opera' in text or 'opr/' in text:
        return 'Opera'
    if 'chromium' in text:
        return 'Chromium'
    if 'chrome' in text:
        return 'Google Chrome'
    return raw or 'Unknown Browser'


def _app_key(browser: str) -> str:
    return {
        'Google Chrome': 'chrome',
        'Chromium': 'chromium',
        'Brave': 'brave',
        'Firefox': 'firefox',
        'Microsoft Edge': 'edge',
        'Opera': 'opera',
    }.get(browser, 'browser')


def _clean_text(value: Any, limit: int) -> str | None:
    if value is None:
        return None
    text = str(value).replace('\x00', ' ').strip()
    if not text:
        return None
    return text[:limit]


def _safe_int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

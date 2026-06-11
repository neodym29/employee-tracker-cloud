# Employee Tracker

Transparent Ubuntu-only background activity logger with local SQLite storage, workspace file change logging, process telemetry, open-window snapshots, Warp command observation, and active-window screenshots when X display capture is available.

## What it logs

- active app/window every poll
- active window ID, title, class, PID, and idle time
- all visible X-display windows at the same timestamp
- process inventory snapshots and lifecycle events from `/proc`
- Warp terminal child command observations based on its process tree
- periodic active-window screenshots when the window is capturable
- file create / modify / delete events inside the chosen workspace
- initial workspace inventory so you can see the files that exist now

## Setup

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -U pip
pip install .
employee-tracker init-db
employee-tracker run
```

## CSV export

```bash
employee-tracker export-csv --output /tmp/activity_logs.csv
employee-tracker export-csv --output /tmp/window_logs.csv --dataset windows
employee-tracker export-csv --output /tmp/warp_logs.csv --dataset warp
employee-tracker export-csv --output /tmp/process_snapshot_logs.csv --dataset processes
employee-tracker export-csv --output /tmp/process_event_logs.csv --dataset process-events
employee-tracker export-csv --output /tmp/file_logs.csv --dataset files
```

## Local storage

Default paths:

- `~/.local/share/employee-tracker/activity.sqlite3`
- `~/.local/share/employee-tracker/screenshots/`

Environment overrides:

- `EMPLOYEE_TRACKER_DB`
- `EMPLOYEE_TRACKER_SCREENSHOT_DIR`
- `EMPLOYEE_TRACKER_WORKSPACE`
- `EMPLOYEE_TRACKER_ENABLE_SCREENSHOTS=0`
- `EMPLOYEE_TRACKER_POLL_SECONDS`
- `EMPLOYEE_TRACKER_FILE_SCAN_SECONDS`
- `EMPLOYEE_TRACKER_PROCESS_SCAN_SECONDS`
- `EMPLOYEE_TRACKER_SCREENSHOT_SECONDS`
- `EMPLOYEE_TRACKER_USERNAME`

## systemd user service

Copy `systemd/employee-tracker.service` to `~/.config/systemd/user/employee-tracker.service`, then run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now employee-tracker.service
```

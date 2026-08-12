# Files-only AI CLI tracer

A Python-standard-library-only Linux wrapper that uses `strace` as the parent of
an explicitly invoked, approved AI CLI process tree.

```sh
files-agent exec --agent codex -- codex
files-agent status
files-agent list
files-agent flush
```

## Privacy boundary

The durable queue and HTTP payload contain only successful file mutation paths,
operation categories, byte/count metadata, timestamps, a random run ID, and the
configured agent/device IDs. They do **not** contain file contents, traced command
arguments, keyboard input, browser data, screenshots, or audio. `/proc`, `/sys`,
`/dev`, trace scratch files, and queue files are excluded. Write-family calls use
strace raw-pointer rendering so write buffers are not rendered into trace output.
Temporary traces are mode 0600 and deleted after parsing.

The wrapped process retains its stdin/stdout/stderr and exit code. Events are
committed to SQLite before a detached best-effort upload is started; failed
uploads remain queued. `flush` can also be scheduled externally.

## Configuration

Default: `~/.config/files-agent/config.json` (0600 recommended):

```json
{
  "endpoint": "https://example.test/v1/file-events",
  "device_token": "per-device-secret",
  "auth": "bearer",
  "agents": ["codex", "claude"]
}
```

`auth` may be `bearer` or `x-device-token`. Override locations for testing with
`FILES_AGENT_CONFIG` and `FILES_AGENT_STATE_DIR`.

## Packaging

`manifest.json` describes the payload. A trusted installer generator should JSON-
escape and replace every placeholder in `install.sh.template`, including the
base64 payload, endpoint, unique device credential, auth scheme, and allowlist.
Never reuse one device token across users.

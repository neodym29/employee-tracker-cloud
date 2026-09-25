// Post-activation patch: leave checksum-pinned upstream untouched.
function replace(source, before, after) {
  if (!source.includes(before)) throw new Error('Onboarding seam changed: '+before.slice(0,80));
  return source.replace(before, after);
}
export function onboardingPatch(name, source) {
  if (name === 'linux-installer.ts') {
    source = replace(source, 'umask 077\n', `umask 077
NO_SERVICE=0
if [ "\${1:-}" = --no-service ]; then
  if [ "\${2:-}" != --isolated-home ] || [ -z "\${3:-}" ]; then
    echo 'Usage: --no-service --isolated-home NEW_ABSOLUTE_DIRECTORY [setup options]' >&2; exit 1
  fi
  case "$3" in /*) ;; *) echo 'Isolated home must be absolute' >&2; exit 1;; esac
  if [ -e "$3" ] || [ -L "$3" ]; then echo 'Isolated home must be new; refusing existing state' >&2; exit 1; fi
  mkdir -m 700 -- "$3"
  HOME=$(CDPATH= cd -- "$3" && pwd -P)
  EMPLOYEE_TRACE_HOME="$HOME/.employee-trace"
  export HOME EMPLOYEE_TRACE_HOME
  NO_SERVICE=1
  shift 3
  set -- --no-service "$@"
else
  for arg in "$@"; do
    if [ "$arg" = --no-service ] || [ "$arg" = --isolated-home ]; then
      echo 'Place --no-service --isolated-home NEW_DIRECTORY first' >&2; exit 1
    fi
  done
fi
` .replaceAll('${', '\\${'));
    source = replace(source, 'if ! command -v systemctl >/dev/null 2>&1; then', 'if [ "$NO_SERVICE" -eq 0 ] && ! command -v systemctl >/dev/null 2>&1; then');
    source = source.replaceAll('systemctl --user stop employee-trace.service >/dev/null 2>&1 || true', '[ "$NO_SERVICE" -eq 1 ] || systemctl --user stop employee-trace.service >/dev/null 2>&1 || true');
    source = source.replaceAll('systemctl --user daemon-reload >/dev/null 2>&1 || true', '[ "$NO_SERVICE" -eq 1 ] || systemctl --user daemon-reload >/dev/null 2>&1 || true');
    source = source.replaceAll('if [ -e "$BACKUP_DIR/service" ]; then systemctl', 'if [ "$NO_SERVICE" -eq 0 ] && [ -e "$BACKUP_DIR/service" ]; then systemctl');
    source = replace(source, 'chmod 755 "$BIN_DIR/employee-trace"', `if [ "$NO_SERVICE" -eq 1 ]; then
cat > "$BIN_DIR/employee-trace" <<'ISOLATED_WRAPPER'
#!/bin/sh
HOME=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
EMPLOYEE_TRACE_HOME="$HOME/.employee-trace"
export HOME EMPLOYEE_TRACE_HOME
exec node "$HOME/.local/share/employee-trace/cli/index.js" "$@"
ISOLATED_WRAPPER
fi
chmod 755 "$BIN_DIR/employee-trace"`);
  }
  if (name === 'index.ts') {
    source = replace(source, '      stopStartup();', "      if (!args.includes('--no-service')) stopStartup();");
    source = replace(source, "      log.success('Background service is ready for setup');", "      log.success(args.includes('--no-service') ? 'Foreground-only setup; no service changes' : 'Background service is ready for setup');");
    source = replace(source, "      installStartup();\n      log.success('Background service started');", `      if (args.includes('--no-service')) {
        log.success('Installed without a service. Not running; launch the installed employee-trace start in the foreground. Keep it running to poll.');
      } else {
        installStartup();
        log.success('Background service started');
      }`);
  }
  if (name === 'setup.ts') source = source.replace('Commands:', 'Setup options: --no-service (manual foreground start; no autostart)\\nInstaller: --no-service --isolated-home NEW_ABSOLUTE_DIRECTORY [--no-watched-dirs | --watched-dir PATH ...]\\n\\nCommands:');
  return source;
}

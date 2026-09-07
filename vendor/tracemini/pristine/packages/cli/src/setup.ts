import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline/promises';
import {stdin, stdout} from 'node:process';

export const installLogPath = () => path.join(os.homedir(), '.local', 'state', 'tracemini', 'install.log');

export function createInstallLogger(target = installLogPath()) {
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  const write = (level: string, message: string) => fs.appendFileSync(target, `${new Date().toISOString()} ${level} ${message}\n`, {mode: 0o600});
  return {
    path: target,
    step(number: number, total: number, message: string) {
      console.log(`[${number}/${total}] ${message}`);
      write('INFO ', message);
    },
    success(message: string) { console.log(`✓ ${message}`); write('INFO ', message); },
    failure(message: string) { console.error(`✗ ${message}`); write('ERROR', message); },
  };
}

export function normalizeWatchPath(value: string, home = os.homedir()) {
  const pasted = value.trim();
  const trimmed = ((pasted.startsWith('"') && pasted.endsWith('"')) || (pasted.startsWith("'") && pasted.endsWith("'")))
    ? pasted.slice(1, -1).trim()
    : pasted;
  const location = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed;
  const expanded = location === '~' ? home
    : location.startsWith('~/') ? path.join(home, location.slice(2))
      : location === '$HOME' ? home
        : location.startsWith('$HOME/') ? path.join(home, location.slice(6))
          : location;
  if (!path.isAbsolute(expanded)) throw new Error('Enter an absolute path, ~/path, or $HOME/path.');
  const resolved = path.resolve(expanded);
  const stat = fs.statSync(resolved, {throwIfNoEntry: false});
  if (!stat?.isDirectory()) throw new Error(`Folder does not exist: ${resolved}`);
  fs.accessSync(resolved, fs.constants.R_OK);
  return resolved;
}

export async function promptForWatchPaths(input = stdin, output = stdout) {
  const prompt = readline.createInterface({input, output});
  const lines = prompt[Symbol.asyncIterator]();
  const ask = async (message: string) => {
    output.write(message);
    const answer = await lines.next();
    if (answer.done) throw new Error('Setup input ended before watch-path configuration was complete.');
    return answer.value;
  };
  const watched: string[] = [];
  try {
    console.log('\nTraceMini observes Git repositories only inside folders you approve.');
    console.log('Copy the folder location from your file manager address bar and paste it here.');
    console.log(`Example: ${path.join(os.homedir(), 'Murtaza')}\n`);
    while (true) {
      let root: string | undefined;
      while (!root) {
        const answer = await ask('Paste a folder location to watch: ');
        if (!answer.trim()) throw new Error('A watch path is required to finish setup.');
        try {
          root = normalizeWatchPath(answer);
        } catch (error: any) {
          console.error(`✗ ${error.message}`);
        }
      }
      if (!watched.includes(root)) watched.push(root);
      console.log(`✓ Added ${root}`);
      const another = await ask('Add another watch path? [y/N]: ');
      if (!/^y(?:es)?$/i.test(another.trim())) return watched;
    }
  } finally {
    prompt.close();
  }
}

export const helpText = `TraceMini local Git activity agent

Usage:
  tracemini <command> [options]

Commands:
  watch PATH                 Approve a folder and discover Git repositories
  repositories               Show locally discovered repositories
  status                     Show device, service, and watch-path status
  use-workspace ID           Select the active CLI workspace
  once                       Run one background-agent cycle
  start                      Run the background agent
  help, --help               Show this help

Examples:
  tracemini watch "$HOME/projects"
  tracemini status
  tracemini --help`;

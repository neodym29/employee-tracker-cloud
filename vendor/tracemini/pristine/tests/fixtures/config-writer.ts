import fs from 'node:fs';
import {loadConfig, saveConfig} from '../../packages/cli/src/config.js';

const [root, gate, ready] = process.argv.slice(2);
fs.writeFileSync(ready, 'ready');
while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const config = loadConfig();
config.watchedPaths.push(root);
saveConfig(config);

import fs from 'node:fs';
import {mutateQueue} from '../../packages/cli/src/config.js';

const [eventKey, gate, ready] = process.argv.slice(2);
fs.writeFileSync(ready, 'ready');
while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
mutateQueue(queue => queue.push({eventKey, repositoryId: 1, localKey: '/work/repo', type: 'commit', occurredAt: new Date(0).toISOString(), data: {}, attempts: 0, nextAttempt: 0}));

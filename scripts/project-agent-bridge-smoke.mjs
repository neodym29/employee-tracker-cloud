#!/usr/bin/env node
// Explicit, opt-in live smoke check. This consumes one locally authenticated Codex request.
import { runCodex } from './project-agent-bridge.mjs';

const result = await runCodex([
  { role: 'system', content: 'Return a short greeting. Do not propose actions.' },
  { role: 'user', content: 'Say hello in two words.' },
]);
if (!result || typeof result.answer !== 'string' || !Array.isArray(result.actions)) throw new Error('invalid bridge result');
process.stdout.write(`${JSON.stringify(result)}\n`);

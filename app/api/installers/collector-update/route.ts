import fs from 'node:fs';
import path from 'node:path';
import {collectorUpdateScript} from '../../../../lib/collector-update.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
// Public software distribution only. No enrollment secret, database or user mutation.
export async function GET(){
 const script=collectorUpdateScript(fs.readFileSync(path.join(process.cwd(),'build/tracemini/cli/index.js')));
 return new Response(script,{headers:{'content-type':'text/x-shellscript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','content-disposition':'attachment; filename="employee-trace-update.sh"'}});
}

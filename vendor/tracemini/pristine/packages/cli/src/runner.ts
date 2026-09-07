import {spawn} from 'node:child_process';
export interface ReportRunner{generate(prompt:string,cwd:string):Promise<string>}
function run(bin:string,args:string[],prompt:string,cwd:string,timeout=120000){return new Promise<string>((resolve,reject)=>{const p=spawn(bin,args,{cwd,stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{p.kill('SIGTERM');reject(new Error(`${bin} timed out`))},timeout);p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);code===0&&out.trim()?resolve(out.trim()):reject(new Error(`${bin} failed (${code}): ${err.slice(-1000)}`))});p.stdin.end(prompt)})}
export function codexExecArgs(cwd:string){return ['exec','--ephemeral','--sandbox','read-only','--skip-git-repo-check','-C',cwd,'-']}
export class CodexRunner implements ReportRunner{generate(prompt:string,cwd:string){return run('codex',codexExecArgs(cwd),prompt,cwd)}}
export class HermesRunner implements ReportRunner{generate(prompt:string,cwd:string){return run('hermes',['--oneshot',prompt,'--safe-mode'], '',cwd)}}

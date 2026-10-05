import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/env-loader-audit.js', import.meta.url));
const canary = 'never_print_value_e6832de2';
function sandbox(fn) {
  const dir=mkdtempSync(join(tmpdir(),'env-audit-test-'));
  try { return fn(dir); } finally { rmSync(dir,{recursive:true,force:true}); }
}
function run(args, extra={}) {
  // Controlled child environment, never pass host environment or user files.
  return spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{},timeout:10000,...extra});
}
function safe(result) {
  assert.ok(!result.stdout.includes(canary));
  assert.ok(!result.stderr.includes(canary));
  assert.ok(!result.error, result.error?.code);
}

test('text and JSON CLI hide values, return drift, and never edit input', () => sandbox(dir => {
  const a=join(dir,'a.env'), b=join(dir,'b.env');
  const contents=[`A=${canary}`,`A=${canary}_different`];
  [a,b].forEach((path,index)=>writeFileSync(path,contents[index]));
  for(const flags of [[],['--json'],['--json','--reverse-candidate']]) {
    const result=run([...flags,'--',a,b]); safe(result); assert.equal(result.status,1);
    if(flags.includes('--json')) assert.equal(JSON.parse(result.stdout).summary.definite,1);
  }
  assert.equal(readFileSync(a,'utf8'),contents[0]);
  assert.equal(readFileSync(b,'utf8'),contents[1]);
}));
test('missing path and invalid arguments never echo supplied text', () => sandbox(dir => {
  for(const args of [['--',join(dir,canary)],['--json','--',join(dir,canary)],[`--${canary}`],['--json','--external',canary+'=oops','--',join(dir,'missing')]]) {
    const result=run(args); safe(result); assert.equal(result.status,2);
  }
}));
test('invalid UTF-8, unsupported name, NUL and prototype inputs are generic safe errors', () => sandbox(dir => {
  const path=join(dir,'bad.env');
  for(const content of [Buffer.from([0xc3,0x28]),`BAD-NAME=${canary}`,`A=${canary}\0`, `__proto__=${canary}`]) {
    writeFileSync(path,content);
    for(const flags of [[],['--json']]) {
      const result=run([...flags,'--',path]); safe(result); assert.equal(result.status,2);
    }
  }
}));
test('missing argument, no files, unsupported flag and invalid external name exit 2', () => sandbox(dir => {
  const path=join(dir,'good.env'); writeFileSync(path,'A=known');
  for(const args of [[],['--external'],['--json'],['--unknown'],['--external','A=value','--',path],['--help','--',path]]) {
    assert.equal(run(args).status,2);
  }
}));
test('directories and oversized files are rejected', () => sandbox(dir => {
  const subdir=join(dir,'directory');mkdirSync(subdir);
  assert.equal(run(['--',subdir]).status,2);
  const path=join(dir,'big.env');writeFileSync(path,Buffer.alloc(4*1024*1024+1,0x41));
  assert.equal(run(['--',path]).status,2);
}));
test('NODE_OPTIONS and shell substitutions from input are never applied', () => sandbox(dir => {
  const path=join(dir,'inert.env'), marker=join(dir,'should-not-exist');
  writeFileSync(path,`NODE_OPTIONS=--this-would-abort-node\nCOMMAND_ONE=$(touch ${marker})\nCOMMAND_TWO=\`touch ${marker}\`\n`);
  const result=run(['--json','--',path]);
  assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stdout).summary.manualReview,1);
  assert.equal(existsSync(marker),false);
}));
test('ambient values and names are never inspected', () => sandbox(dir => {
  const path=join(dir,'simple.env');writeFileSync(path,'A=known');
  const result=run(['--json','--',path],{env:{A:canary,SECRET_ONLY_IN_HOST:canary}});
  safe(result);
  const report=JSON.parse(result.stdout);
  assert.deepEqual(report.input.externalNames,[]);
  assert.deepEqual(report.variables.map(v=>v.name),['A']);
  assert.equal(report.variables[0].baseline.kind,'file');
}));
test('unknown external winner is possible drift and -- separator supports option-like filenames', () => sandbox(dir => {
  writeFileSync(join(dir,'--odd.env'),'A=known');
  const result=run(['--json','--override','--external','A','--','--odd.env'],{cwd:dir});
  assert.equal(result.status,1);
  assert.equal(JSON.parse(result.stdout).summary.possible,1);
}));
test('single equal configuration exits 0, and help needs no files', () => sandbox(dir => {
  const path=join(dir,'good.env');writeFileSync(path,'A=known');
  assert.equal(run(['--',path]).status,0);
  const help=run(['--help']);assert.equal(help.status,0);assert.ok(help.stdout.includes('Usage:'));
}));
test('production source has no subprocess, environment population, network or evaluation calls', () => {
  for(const path of ['../src/audit.js','../bin/env-loader-audit.js']) {
    const source=readFileSync(new URL(path,import.meta.url),'utf8');
    for(const pattern of [/child_process/,/process\.env/,/dotenv\.config\(/,/dotenv\.populate\(/,/\beval\(/,/\bfetch\(/,/https?:\/\//]) assert.ok(!pattern.test(source), String(pattern));
  }
});
test('JSON-looking filenames and external names do not select output format', () => sandbox(dir => {
  for(const args of [['--','--json'],['--external','--json']]) {
    const result=run(args,{cwd:dir});
    assert.equal(result.status,2);
    assert.equal(result.stdout,'');
    assert.ok(result.stderr.startsWith('env-loader-audit:'));
  }
}));
test('parser-reinterpreted secret fragments never reach CLI output', () => sandbox(dir => {
  const path=join(dir,'ambiguous.env');
  const cases=[`X="hello\\"\n${canary}=foo\n"\n`, `X="v" \\n${canary}=foo ' `, `X=\n"hello\nnever_\rprint_value_e6832de2=foo\n"\n`];
  for(const content of cases) {
    writeFileSync(path,content);
    for(const flags of [[],['--json']]) {
      const result=run([...flags,'--',path]);
      safe(result);
      assert.ok([0,1,2].includes(result.status));
    }
  }
}));

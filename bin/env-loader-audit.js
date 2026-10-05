#!/usr/bin/env node
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { audit, formatText, AuditError } from '../src/audit.js';

const HELP = `env-loader-audit: compare dotenv loading with native Node --env-file
Usage: node bin/env-loader-audit.js [options] -- FILE [FILE ...]
  --json                    Emit values-hidden JSON
  --override                Model dotenv override:true (default false)
  --external NAME           Declare an externally provided name; repeatable
  --reverse-candidate       Re-evaluate reversed native file order
  --help                    Show this help
Requires Node >=22, POSIX, regular UTF-8 files, portable ASCII variable names.
Explicit files only; no project discovery or ambient environment inspection.
Exit: 0 no observed effective change, 1 drift/manual review, 2 invalid/unsupported.
`;
const MAX_BYTES = 4 * 1024 * 1024;
let jsonOutput = false;

function readFile(path, index) {
  let fd;
  try {
    // Non-blocking open avoids hanging on a FIFO; fstat rejects non-regular inputs.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new AuditError('not-regular-file', index);
    if (stat.size > MAX_BYTES) throw new AuditError('file-too-large', index);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > MAX_BYTES) throw new AuditError('file-too-large', index);
    try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)); }
    catch { throw new AuditError('invalid-utf8', index); }
  } catch (error) {
    if (error instanceof AuditError) throw error;
    throw new AuditError('file-read-failed', index);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function options(argv) {
  const result = { json: false, override: false, reverseCandidate: false, externalNames: [], paths: [] };
  let files = false;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (files) result.paths.push(token);
    else if (token === '--') files = true;
    else if (token === '--json') { result.json = true; jsonOutput = true; }
    else if (token === '--override') result.override = true;
    else if (token === '--reverse-candidate') result.reverseCandidate = true;
    else if (token === '--external') {
      if (++index === argv.length) throw new AuditError('missing-external-name');
      result.externalNames.push(argv[index]);
    } else if (token === '--help' && argv.length === 1) result.help = true;
    else throw new AuditError('invalid-arguments');
  }
  if (!result.help && (!result.paths.length || result.paths.length > 32)) throw new AuditError('invalid-file-list');
  return result;
}

// Even input/IO/parser failures never serialize an untrusted exception or path.
try {
  const args = options(process.argv.slice(2));
  if (args.help) process.stdout.write(HELP);
  else {
    const files = args.paths.map((path, index) => ({ path, content: readFile(path, index) }));
    const report = audit(files, args);
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatText(report));
    process.exitCode = report.summary.exitCode;
  }
} catch (error) {
  const safe = error instanceof AuditError ? error : new AuditError('audit-failed');
  const report = { schemaVersion: 1, tool: 'env-loader-audit', error: { code: safe.code, ...(safe.fileIndex === undefined ? {} : { fileIndex: safe.fileIndex }) }, exitCode: 2 };
  if (jsonOutput) process.stdout.write(`${JSON.stringify(report)}\n`);
  else process.stderr.write(`env-loader-audit: ${safe.code}${safe.fileIndex === undefined ? '' : ` (file[${safe.fileIndex}])`}\n`);
  process.exitCode = 2;
}

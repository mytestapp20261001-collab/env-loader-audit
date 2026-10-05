import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import dotenv from 'dotenv';
import { audit, AuditError, DOTENV_VERSION } from '../src/audit.js';

// Run this test under each supported Node binary. Every child uses the same binary
// as this test and an explicit empty or fully synthetic environment.
const require = createRequire(import.meta.url);
const dotenvPath = require.resolve('dotenv');
const root = dirname(fileURLToPath(import.meta.url));
const own = (object, name) => Object.prototype.hasOwnProperty.call(object, name);
const portable = name => /^[A-Za-z_]/.test(name) && !/[^A-Za-z0-9_]/.test(name);
const shape = (object, name) => own(object, name) ? ['present', object[name]] : ['absent'];
const parseDotenv = content => dotenv.parse(content, { fast: false });
const corpus = [
  ['plain duplicate and empty', 'A=first\nA=last-in-file\nEMPTY=\nB=one\n'],
  ['space-only empty value', 'A=  \nB=two\n'],
  ['BOM and CRLF', '\uFEFFA=one\r\nB=two\r\n'],
  ['bare CR', 'A=one\rB=two\r'],
  ['quotes and hashes', 'A="one # two"\nB=\' three \'\nC=`four`\n'],
  ['multiline quotes', 'A="one\ntwo"\nB=\'three\nfour\'\n'],
  ['literal escapes', 'A="one\\ntwo\\rthree\\tfour"\nB=\'one\\ntwo\'\n'],
  ['escaped quote', 'A="one\\"two"\nB=next\n'],
  ['quote trailing text', 'A="one"junk\nB=next\n'],
  ['mismatched quotes', 'A="one\'\nB=next\n'],
  ['export', 'export A=one\nexport B=two\n'],
  ['empty export', 'export A=\nexport B=\n'],
  ['tab export', 'export\tA=one\n'],
  ['colon syntax', 'A: one\nB: two\n'],
  ['malformed prefix', '!A=one\nB=two\n'],
  ['malformed intervening line', 'BAD LINE\nA=one\n'],
  ['indented assignment comment', '   # comment=bad\nA=one\n'],
  ['prototype-like normal names', 'constructor=one\ntoString=two\nhasOwnProperty=three\n'],
  ['unicode whitespace', '\u00a0A\u00a0=\u00a0one\u00a0\n'],
  ['empty native name', '=\nA=two\n'],
];
const overlay = 'A=second-file\nB=second-file\nEMPTY=second-file\nZ=second-file\nconstructor=second-file\n';

function runChild(args, env) {
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.error, undefined, 'synthetic child must start');
  assert.equal(child.signal, null, 'synthetic child must not receive a signal');
  assert.equal(child.status, 0, `synthetic child must succeed: ${child.stderr}`);
  return JSON.parse(child.stdout);
}

function actualDotenv(paths, override, external) {
  const script = `const d = require(${JSON.stringify(dotenvPath)});
    const target = Object.assign(Object.create(null), ${JSON.stringify(external)});
    const result = d.config({path:${JSON.stringify(paths)}, override:${override},
      processEnv:target, fast:false, quiet:true, debug:false, encoding:'utf8'});
    if (result.error) throw result.error;
    console.log(JSON.stringify(target));`;
  return runChild(['-e', script], {});
}

function actualNative(paths, external) {
  return runChild([
    ...paths.map(path => `--env-file=${path}`),
    '-e', 'console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env))))',
  ], external);
}

function verifyProvenance(source, name, actual, parsedFiles, external) {
  if (source.kind === 'absent') {
    assert.equal(own(actual, name), false, `${name}: absent provenance`);
  } else if (source.kind === 'external') {
    assert.equal(own(external, name), true, `${name}: declared external provenance`);
    assert.deepEqual(shape(actual, name), shape(external, name), `${name}: external value`);
  } else {
    assert.equal(source.kind, 'file');
    assert.equal(own(parsedFiles[source.fileIndex], name), true, `${name}: reported file supplies key`);
    assert.deepEqual(shape(actual, name), shape(parsedFiles[source.fileIndex], name), `${name}: reported winner value`);
  }
}

function verifyVariables(variables, oldEnvironment, newEnvironment, parsedDotenv, parsedNative, external) {
  const reportNames = new Set(variables.map(variable => variable.name));
  for (const name of new Set([...Object.keys(oldEnvironment), ...Object.keys(newEnvironment)])) {
    assert.ok(reportNames.has(name), `${name}: actual output represented in report`);
  }
  for (const variable of variables) {
    const equal = JSON.stringify(shape(oldEnvironment, variable.name)) === JSON.stringify(shape(newEnvironment, variable.name));
    if (variable.change === 'none') assert.equal(equal, true, `${variable.name}: no change must be equal`);
    else if (variable.change === 'definite') assert.equal(equal, false, `${variable.name}: definite change must differ`);
    else {
      // Actual values are known to the test, while audit intentionally knows only
      // external names. A possible change is therefore not a false positive.
      assert.equal(variable.change, 'possible');
      assert.ok(variable.baseline.kind === 'external' || variable.native.kind === 'external');
    }
    if (!own(external, variable.name)) assert.equal(variable.change, equal ? 'none' : 'definite');
    verifyProvenance(variable.baseline, variable.name, oldEnvironment, parsedDotenv, external);
    verifyProvenance(variable.native, variable.name, newEnvironment, parsedNative, external);
  }
}

test('pinned dotenv parser used by regression and product agrees', () => {
  assert.equal(DOTENV_VERSION, require('dotenv/package.json').version);
});

for (const [label, content] of corpus) {
  test(`actual loaders cross-check: ${label} (Node ${process.versions.node})`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'env-audit-regression-'));
    try {
      const inputs = [content, overlay];
      const paths = inputs.map((text, index) => {
        const path = join(directory, `${index}.env`);
        writeFileSync(path, text);
        return path;
      });
      const files = inputs.map((text, index) => ({ path: paths[index], content: text }));
      const parsedDotenv = inputs.map(parseDotenv);
      const parsedNative = inputs.map(parseEnv);
      const unsupported = [...parsedDotenv, ...parsedNative].some(parsed => Object.keys(parsed).some(name => !portable(name)));
      if (unsupported) {
        assert.throws(() => audit(files), error => error instanceof AuditError && error.code === 'unsupported-variable-name');
        return;
      }
      if (parsedDotenv.some((d,index) => { const n = parsedNative[index]; return Object.keys(d).length !== Object.keys(n).length || Object.keys(d).some(k => !own(n,k)); })) {
        assert.throws(() => audit(files), error => error instanceof AuditError && error.code === 'parser-key-set-drift');
        return;
      }
      const keys = new Set([...parsedDotenv,...parsedNative].flatMap(p => Object.keys(p)));
      const values = [...parsedDotenv,...parsedNative].flatMap(p => Object.values(p)).filter(Boolean).join('\0');
      if ([...keys].some(k => values.includes(k))) {
        assert.throws(() => audit(files), error => error instanceof AuditError && error.code === 'ambiguous-name-value-overlap');
        return;
      }
      for (const reverseInput of [false, true]) {
        const orderedFiles = reverseInput ? [...files].reverse() : files;
        const orderedPaths = orderedFiles.map(file => file.path);
        const dMaps = reverseInput ? [...parsedDotenv].reverse() : parsedDotenv;
        const nMaps = reverseInput ? [...parsedNative].reverse() : parsedNative;
        for (const external of [{}, { A: 'synthetic-parent', B: '', EXTERNAL_ONLY: 'synthetic-only' }]) {
          const nativeActual = actualNative(orderedPaths, external);
          const reverseNativeActual = actualNative([...orderedPaths].reverse(), external);
          for (const override of [false, true]) {
            const report = audit(orderedFiles, { override, externalNames: Object.keys(external), reverseCandidate: true });
            const dotenvActual = actualDotenv(orderedPaths, override, external);
            verifyVariables(report.variables, dotenvActual, nativeActual, dMaps, nMaps, external);
            verifyVariables(report.reverseCandidate.variables, dotenvActual, reverseNativeActual, dMaps, nMaps, external);
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('unsupported data is rejected before any application launch', () => {
  for (const content of ['A=one\0two\n', '__proto__=one\n', '# __proto__ comment\nA=one\n']) {
    assert.throws(() => audit([{ path: 'synthetic.env', content }]), error => error instanceof AuditError && ['unsupported-content', 'unsupported-prototype-token'].includes(error.code));
  }
});

test('NODE_OPTIONS marks startup behavior as unmodeled without launching it', () => {
  const report = audit([{ path: 'synthetic.env', content: 'NODE_OPTIONS=--synthetic-invalid-option\n' }]);
  assert.equal(report.variables.find(variable => variable.name === 'NODE_OPTIONS').manualReview, true);
  assert.equal(report.summary.exitCode, 1);
});

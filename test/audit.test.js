import test from 'node:test';
import assert from 'node:assert/strict';
import { audit, formatText, AuditError } from '../src/audit.js';
const input = (...contents) => contents.map((content, index) => ({ path: `synthetic-${index}.env`, content }));
const variable = (report, name = 'A') => report.variables.find(item => item.name === name);

test('default first/last precedence explains a real effective change and reverse correction', () => {
  const result = audit(input('A=local\n', 'A=base\n'), { reverseCandidate: true });
  assert.equal(variable(result).change, 'definite');
  assert.deepEqual(variable(result).categories, ['file-precedence']);
  assert.deepEqual(variable(result).baseline, {kind:'file',fileIndex:0});
  assert.deepEqual(variable(result).native, {kind:'file',fileIndex:1});
  assert.equal(result.reverseCandidate.summary.exitCode, 0);
  assert.deepEqual(result.reverseCandidate.nativeFileOrder, [1,0]);
});
test('equal values change provenance without claiming drift', () => {
  const result = audit(input('A=same\nEMPTY=\n', 'A=same\nEMPTY=\n'));
  assert.equal(result.summary.exitCode, 0);
  for (const v of result.variables) assert.deepEqual(v.categories, ['equal-value-provenance']);
});
test('override true keeps last file, and reversal can introduce drift', () => {
  const result = audit(input('A=first', 'A=last'), { override:true, reverseCandidate:true });
  assert.equal(result.summary.exitCode, 0);
  assert.equal(result.reverseCandidate.summary.exitCode, 1);
});
test('declared external value masks file drift under override false', () => {
  const result = audit(input('A=first', 'A=last'), { externalNames:['A'] });
  assert.equal(result.summary.exitCode, 0);
  assert.equal(variable(result).change, 'none');
  assert.deepEqual(variable(result).baseline, {kind:'external'});
  assert.equal(variable(result).evidence.maskedDifference, true);
  assert.ok(variable(result).categories.includes('external-masking'));
});
test('unknown external value versus any known value is only a possible change', () => {
  for (const value of ['', 'ordinary', 'undefined', 'null']) {
    const result = audit(input(`A=${value}`), {override:true,externalNames:['A'],reverseCandidate:true});
    assert.equal(variable(result).change, 'possible');
    assert.equal(result.reverseCandidate.variables[0].change, 'possible');
    assert.deepEqual(variable(result).categories, ['external-masking']);
  }
});
test('external-only keys preserve the same unknown value', () => {
  const result = audit(input(''), {override:true,externalNames:['A','A']});
  assert.equal(variable(result).change, 'none');
  assert.equal(result.summary.exitCode, 0);
  assert.deepEqual(result.input.externalNames, ['A']);
});
test('case-sensitive variables remain distinct', () => {
  assert.equal(audit(input('A=one\na=two')).variables.length, 2);
});
test('official parsers cover simple quotes, comments, export, empty, duplicate, multiline, CRLF', () => {
  const text = "A=first\r\nA=last\r\nEMPTY=\r\nexport B='two words'\r\nC=three # comment\r\nD=\"line1\nline2\"\r\n";
  const result = audit(input(text));
  assert.equal(result.summary.exitCode, 0);
  assert.deepEqual(result.variables.map(v => v.name), ['A','B','C','D','EMPTY']);
});
test('parser differences have independent four-cell evidence', () => {
  const result = audit(input('A="one"junk', 'A=other'));
  assert.ok(variable(result).categories.includes('parser'));
  assert.ok(variable(result).categories.includes('file-precedence'));
  assert.deepEqual(variable(result).evidence.parserFiles,[0]);
  assert.equal(variable(result).evidence.parserUnderFirst,true);
  assert.equal(variable(result).evidence.parserUnderLast,false);
});
test('reverse candidate does not hide parser incompatibility', () => {
  const result = audit(input('A="one"junk', 'A=other'), {reverseCandidate:true});
  assert.equal(result.reverseCandidate.summary.definite,1);
});
test('parser difference can be present but masked by a later equal winning file', () => {
  const result = audit(input('A="one"junk', 'A=shared'), {override:true});
  assert.equal(result.summary.exitCode,0);
  assert.deepEqual(variable(result).categories,['parser']);
});
test('NODE_OPTIONS always requires startup review even masked or equal', () => {
  for (const options of [{},{override:true},{externalNames:['NODE_OPTIONS']}]) {
    const result = audit(input('NODE_OPTIONS=--definitely-not-a-real-node-flag'),options);
    assert.equal(result.summary.exitCode,1);
    assert.ok(variable(result,'NODE_OPTIONS').manualReview);
    assert.ok(!JSON.stringify(result).includes('--definitely'));
  }
  assert.equal(audit(input(''),{externalNames:['NODE_OPTIONS']}).summary.exitCode,1);
});
test('command-looking values are inert and omitted', () => {
  const result = audit(input('A=$(touch /tmp/not_executed)\nB=`whoami`\nC=${external}'));
  assert.ok(!JSON.stringify(result).includes('not_executed'));
  assert.ok(!formatText(result).includes('whoami'));
});
test('no secret values, hashes, lengths, or excerpts in returned objects or text', () => {
  const secret = 'canary_do_not_disclose_8e6c';
  const result = audit(input(`A=${secret}\nB="${secret}\ncontinued"`, `A=${secret}different`),{reverseCandidate:true});
  const output = JSON.stringify(result)+formatText(result);
  assert.ok(!output.includes(secret));
  for (const forbidden of ['"value"','"valueLength"','"hash"','"excerpt"']) assert.ok(!output.includes(forbidden));
});
test('unsupported names are hidden rather than echoing malformed input', () => {
  for (const content of ['WITH-DASH=secret','WITH.DOT=secret','1NUMBER=secret']) {
    assert.throws(() => audit(input(content)),error => error instanceof AuditError && error.code === 'unsupported-variable-name' && !error.message.includes('secret'));
  }
});
test('prototype token and NUL cannot silently disappear or truncate', () => {
  for (const content of ['__proto__=secret','A=__proto__','A=x\0y','BAD\0NAME=value']) {
    assert.throws(() => audit(input(content)),AuditError);
  }
});
test('constructor and toString are ordinary names', () => {
  assert.deepEqual(audit(input('constructor=one\ntoString=two')).variables.map(v=>v.name),['constructor','toString']);
});
test('Windows and bad options are explicitly unsupported', () => {
  assert.throws(() => audit(input('A=x'),{platform:'win32'}),/unsupported-windows-environment/);
  assert.throws(() => audit(input('A=x'),{externalNames:['A=value']}),/invalid-external-names/);
  assert.throws(() => audit([]),/invalid-file-list/);
  assert.throws(() => audit(input(''),{override:'false'}),/invalid-options/);
});
test('JSON/text are deterministic and control characters in paths are escaped', () => {
  const files=[{path:'line\n\u001b[31m.env',content:'Z=a\nA=b'}];
  const a=audit(files); const b=audit(files);
  assert.deepEqual(a,b);
  assert.equal(formatText(a),formatText(b));
  assert.ok(!formatText(a).includes('\u001b'));
  assert.ok(formatText(a).includes('\\u001b'));
});
test('multiline value reinterpreted as a portable key never leaks', () => {
  const secret='CANARY_DoNotDisclose_8e6c';
  for(const quote of ['"',"'",'`']) {
    const content=`A=${quote}one\\${quote}\n${secret}=foo\n${quote}\n`;
    try {
      const report=audit(input(content));
      assert.ok(!JSON.stringify(report).includes(secret));
      assert.ok(!formatText(report).includes(secret));
    } catch(error) {
      assert.ok(error instanceof AuditError);
      assert.ok(!error.message.includes(secret));
    }
  }
});
test('even benign name/value overlaps are conservatively unsupported', () => {
  assert.throws(()=>audit(input('NAME=NAME')),/ambiguous-name-value-overlap/);
});
test('escaped-quote transformed-key bypasses cannot leak names', () => {
  const secret='CANARY_DoNotDisclose_8e6c';
  for(const content of [`A="v\\" \\n${secret}=foo ' `, `A="v\\"x\u2028\\r${secret}=foo\u2028'\u2028`]) {
    assert.throws(()=>audit(input(content)),error=>['parser-key-set-drift','ambiguous-name-value-overlap'].includes(error.code) && !String(error).includes(secret));
  }
});
test('known additional Node startup controls are manual review', () => {
  for(const name of ['NODE_PATH','NODE_NO_WARNINGS']) {
    assert.equal(audit(input(`${name}=synthetic`)).summary.manualReview,1);
  }
});
test('bare CR cannot join multiline value fragments into a reported name', () => {
  try {
    const report=audit(input('X=\n"hello\nsec\rret_canary=foo\n"\n'));
    assert.ok(!JSON.stringify(report).includes('secret_canary'));
  } catch(error) {
    assert.ok(error instanceof AuditError);
    assert.ok(!String(error).includes('secret_canary'));
  }
});

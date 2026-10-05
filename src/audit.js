import dotenv from 'dotenv';
import * as util from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const DOTENV_VERSION = require('dotenv/package.json').version;
export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const absent = Object.freeze({ kind: 'absent' });
const STARTUP_NAMES = new Set(['NODE_OPTIONS', 'NODE_PATH', 'NODE_NO_WARNINGS']);

// Errors intentionally carry no parser exception, input, path, or value.
export class AuditError extends Error {
  constructor(code, fileIndex = undefined) {
    super(code);
    this.name = 'AuditError';
    this.code = code;
    if (fileIndex !== undefined) this.fileIndex = fileIndex;
  }
}

function parse(content, parser, fileIndex) {
  let object;
  try { object = parser(content); } catch { throw new AuditError('parse-failed', fileIndex); }
  const map = new Map(Object.entries(object));
  // A malformed line can be absorbed into a parser-produced name. Do not print it.
  for (const [name, value] of map) {
    if (!NAME.test(name)) throw new AuditError('unsupported-variable-name', fileIndex);
    if (typeof value !== 'string' || value.includes('\0')) throw new AuditError('unsupported-content', fileIndex);
  }
  return map;
}

function merge(parsed, order, lastWins) {
  const result = new Map();
  for (const fileIndex of order) {
    for (const [name, value] of parsed[fileIndex]) {
      if (lastWins || !result.has(name)) result.set(name, { kind: 'file', fileIndex, value });
    }
  }
  return result;
}

function from(map, name) { return map.get(name) ?? absent; }
function effective(map, name, external, override) {
  if (external.has(name) && (!override || !map.has(name))) return { kind: 'external', name };
  return from(map, name);
}
function comparison(a, b) {
  if (a.kind === 'absent' || b.kind === 'absent') return a.kind === b.kind ? 'none' : 'definite';
  if (a.kind === 'external' || b.kind === 'external') {
    return a.kind === b.kind && a.name === b.name ? 'none' : 'possible';
  }
  return a.value === b.value ? 'none' : 'definite';
}
function source(value) {
  return value.kind === 'file' ? { kind: 'file', fileIndex: value.fileIndex } : { kind: value.kind };
}
function sameSource(a, b) {
  return a.kind === b.kind && (a.kind !== 'file' || a.fileIndex === b.fileIndex);
}

function buildComparison(parsedDotenv, parsedNode, order, external, override) {
  const cells = {
    dotenvFirst: merge(parsedDotenv, order, false),
    dotenvLast: merge(parsedDotenv, order, true),
    nodeFirst: merge(parsedNode, order, false),
    nodeLast: merge(parsedNode, order, true),
  };
  const baseline = override ? cells.dotenvLast : cells.dotenvFirst;
  const keys = [...new Set([...cells.dotenvFirst.keys(), ...cells.nodeFirst.keys(), ...external])].sort();
  const variables = keys.map(name => {
    const oldValue = effective(baseline, name, external, override);
    const newValue = effective(cells.nodeLast, name, external, false);
    const change = comparison(oldValue, newValue);
    const parserFiles = order.filter(index => {
      const d = parsedDotenv[index]; const n = parsedNode[index];
      return d.has(name) !== n.has(name) || d.get(name) !== n.get(name);
    });
    const parserUnderFirst = comparison(from(cells.dotenvFirst, name), from(cells.nodeFirst, name)) !== 'none';
    const parserUnderLast = comparison(from(cells.dotenvLast, name), from(cells.nodeLast, name)) !== 'none';
    const precedenceUnderDotenv = comparison(from(cells.dotenvFirst, name), from(cells.dotenvLast, name)) !== 'none';
    const precedenceUnderNode = comparison(from(cells.nodeFirst, name), from(cells.nodeLast, name)) !== 'none';
    const rawChange = comparison(from(baseline, name), from(cells.nodeLast, name));
    const maskedDifference = external.has(name) && !override && rawChange !== 'none';
    const categories = [];
    if (parserFiles.length) categories.push('parser');
    if (!override && (precedenceUnderDotenv || precedenceUnderNode)) categories.push('file-precedence');
    if (external.has(name) && (maskedDifference || oldValue.kind !== newValue.kind)) categories.push('external-masking');
    if (maskedDifference) categories.push('masked-difference');
    if (change === 'none' && !sameSource(oldValue, newValue)) categories.push('equal-value-provenance');
    const manualReview = STARTUP_NAMES.has(name);
    if (manualReview) categories.push('startup-review');
    return {
      name, change, categories, manualReview,
      baseline: source(oldValue), native: source(newValue),
      counterfactuals: Object.fromEntries(Object.entries(cells).map(([key, map]) => [key, source(from(map, name))])),
      evidence: { parserFiles, parserUnderFirst, parserUnderLast, precedenceUnderDotenv, precedenceUnderNode, maskedDifference },
    };
  });
  return variables;
}

function summarize(variables) {
  const definite = variables.filter(v => v.change === 'definite').length;
  const possible = variables.filter(v => v.change === 'possible').length;
  const manualReview = variables.filter(v => v.manualReview).length;
  return {
    status: definite || possible ? 'drift' : manualReview ? 'manual-review' : 'no-observed-effective-change',
    definite, possible, manualReview,
    informational: variables.filter(v => v.change === 'none' && !v.manualReview && v.categories.length).length,
    exitCode: definite || possible || manualReview ? 1 : 0,
  };
}

/** Side-effect-free comparison. Returns only names, provenance and classifications. */
export function audit(files, { override = false, externalNames = [], reverseCandidate = false, platform = process.platform } = {}) {
  if (platform === 'win32') throw new AuditError('unsupported-windows-environment');
  if (typeof util.parseEnv !== 'function' || Number(process.versions.node.split('.')[0]) < 22) throw new AuditError('unsupported-node-version');
  if (typeof override !== 'boolean' || typeof reverseCandidate !== 'boolean') throw new AuditError('invalid-options');
  if (!Array.isArray(files) || !files.length || files.length > 32) throw new AuditError('invalid-file-list');
  if (!Array.isArray(externalNames) || externalNames.length > 4096 || externalNames.some(n => typeof n !== 'string' || !NAME.test(n))) throw new AuditError('invalid-external-names');
  if (files.reduce((sum, file) => sum + (typeof file?.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : 0), 0) > 2 * 1024 * 1024) throw new AuditError('total-input-too-large');
  const parsedDotenv = []; const parsedNode = [];
  files.forEach((file, index) => {
    if (!file || typeof file.path !== 'string' || !file.path.length || typeof file.content !== 'string') throw new AuditError('invalid-file', index);
    if (file.content.includes('\0')) throw new AuditError('unsupported-content', index);
    // Both official parse APIs can omit this key even though the native loader sets it.
    // Reject the token conservatively anywhere, rather than implement a competing parser.
    if (file.content.includes('__proto__')) throw new AuditError('unsupported-prototype-token', index);
    const d = parse(file.content, dotenv.parse, index);
    const n = parse(file.content, util.parseEnv, index);
    // Differing key sets may expose value material reinterpreted as a name.
    // Decline that file without naming additions/removals; never invent a parser.
    if (d.size !== n.size || [...d.keys()].some(name => !n.has(name))) throw new AuditError('parser-key-set-drift', index);
    parsedDotenv.push(d);
    parsedNode.push(n);
  });
  const allMaps = [...parsedDotenv, ...parsedNode];
  const outputNames = new Set([...externalNames, ...allMaps.flatMap(map => [...map.keys()])]);
  if (outputNames.size > 2048) throw new AuditError('too-many-variables');
  // A parser can reinterpret part of a multiline value as a new variable name.
  // Reject any name/value overlap, including benign overlaps, before serialization.
  const valueText = allMaps.flatMap(map => [...map.values()]).filter(Boolean).join('\0');
  if ([...outputNames].some(name => valueText.includes(name))) throw new AuditError('ambiguous-name-value-overlap');
  const order = files.map((_, index) => index);
  const external = new Set(externalNames);
  const variables = buildComparison(parsedDotenv, parsedNode, order, external, override);
  const report = {
    schemaVersion: 1,
    tool: 'env-loader-audit', version: '0.1.0',
    runtime: { node: process.versions.node, dotenv: DOTENV_VERSION, platform },
    input: { files: files.map((f, index) => ({ index, path: f.path })), dotenvOverride: override, externalNames: [...external].sort() },
    assumptions: { environment: 'posix-case-sensitive', externalValues: 'unknown', externalNamesComplete: true, dotenvParser: 'default-regex', nativeParser: 'running-node-util.parseEnv' },
    summary: summarize(variables), variables,
  };
  if (reverseCandidate) {
    // Keep the source dotenv order fixed. Only the native candidate is reversed.
    const reversedNode = merge(parsedNode, [...order].reverse(), true);
    const baseline = merge(parsedDotenv, order, override);
    const reversedVariables = variables.map(variable => {
      const oldValue = effective(baseline, variable.name, external, override);
      const newValue = effective(reversedNode, variable.name, external, false);
      return { name: variable.name, change: comparison(oldValue, newValue), manualReview: variable.manualReview, baseline: source(oldValue), native: source(newValue), categories: [] };
    });
    report.reverseCandidate = { nativeFileOrder: [...order].reverse(), summary: summarize(reversedVariables), variables: reversedVariables };
  }
  return report;
}

export function formatText(report) {
  const q = value => JSON.stringify(value);
  const show = value => value.kind === 'file' ? `file[${value.fileIndex}]` : value.kind;
  const lines = [
    `env-loader-audit ${report.version} | Node ${report.runtime.node} | dotenv ${report.runtime.dotenv}`,
    `Result: ${report.summary.status}; definite=${report.summary.definite}, possible=${report.summary.possible}, manual-review=${report.summary.manualReview}`,
    `Source: dotenv override=${report.input.dotenvOverride}; target: native last-file-wins; POSIX case-sensitive`,
    'External values are unknown. Only explicitly declared external names are modeled.',
    ...report.input.files.map(file => `file[${file.index}]: ${q(file.path)}`),
    ...report.variables.map(v => `${q(v.name)}: ${v.change}; ${show(v.baseline)} -> ${show(v.native)}${v.categories.length ? `; ${v.categories.join(', ')}` : ''}`),
  ];
  if (report.reverseCandidate) {
    lines.push(`Reversed native candidate [${report.reverseCandidate.nativeFileOrder.join(', ')}]: ${report.reverseCandidate.summary.status}`);
    lines.push(...report.reverseCandidate.variables.filter(v => v.change !== 'none' || v.manualReview).map(v => `  ${q(v.name)}: ${v.change}; ${show(v.baseline)} -> ${show(v.native)}${v.manualReview ? '; startup-review' : ''}`));
  }
  lines.push('Configuration parsing/loading comparison only; not full application compatibility certification.');
  if (report.summary.manualReview) lines.push('Listed Node startup controls require manual review. No settings were applied and no application was launched.');
  return `${lines.join('\n')}\n`;
}

# env-loader-audit

**Will replacing `dotenv.config({ path: ['.env.local', '.env'] })` with native Node `--env-file` change the configuration?**

This small offline CLI checks the explicit files you give it and explains observed differences without printing their values. The migration trap is real: dotenv normally keeps the **first** file's value; native Node keeps the **last** file's value. Parsers also differ across Node versions.

Rather than just diff two dictionaries, the auditor calculates four parser/precedence combinations, preserves winning-file provenance, separates parser differences from file precedence and external masking, and optionally rechecks a reversed-order candidate.

## Try the synthetic example

Requires a POSIX system and Node 22 or newer. Tested versions: **22.0.0 and 24.19.0**. The Node parser is always the version running the command; the pinned dotenv parser is **18.0.5**. Other Node releases are not a promise of identical parser behavior.

```sh
git clone https://github.com/mytestapp20261001-collab/env-loader-audit.git
cd env-loader-audit
npm ci --ignore-scripts --no-audit --no-fund
node bin/env-loader-audit.js --reverse-candidate -- examples/local.env examples/base.env
```

The install retrieves the pinned dependency; the auditor itself has no network code, telemetry, service, credentials or runtime downloads. This source repository is not published to npm.

The example reports:

```text
"API_ORIGIN": definite; file[0] -> file[1]; file-precedence
"EMPTY": none; file[0] -> file[1]; equal-value-provenance
"SAME": none; file[0] -> file[1]; equal-value-provenance
Reversed native candidate [1, 0]: no-observed-effective-change
```

The command still exits **1** because the originally requested migration changes `API_ORIGIN`. The candidate is a separate result, not an applied fix.

## Audit your files locally

Run the executable from this checkout, supplying the intended dotenv file order explicitly:

```sh
node bin/env-loader-audit.js --json --reverse-candidate -- /local/project/.env.local /local/project/.env
```

Already supplied variables must be declared by **name only**. For example, if your deployment supplies `PORT` and `DATABASE_URL`:

```sh
node bin/env-loader-audit.js --external PORT --external DATABASE_URL -- /local/project/.env.local /local/project/.env
```

For `dotenv.config({ override: true })`, add `--override`. No values are accepted through the `--external` option. The complete set of relevant external names is your responsibility: omitted names are modeled as absent. The tool never inspects ambient `process.env`, so it does not silently compare your current shell instead of your intended deployment.

Use `--` before file paths. File paths may be absolute or relative to your current working directory. Symlinks are followed to regular files; there is no project search or auto-discovery. Every file must exist and decode as UTF-8. The tool reads once into memory and compares that snapshot; do not modify input files during the audit.

## Interpret the result

- `definite`: effective known file values differ
- `possible`: a known file value is replaced by an unknown external value, or the reverse; equality cannot be established
- `none`: observed effective configuration agrees under the supplied assumptions
- `parser`: at least one individual file parses differently; evidence says whether the difference survives first/last selection
- `file-precedence`: first-vs-last selection changes a parsed value while the migration uses different selection rules
- `external-masking`: a declared external value masks a difference or changes the selected source
- `masked-difference`: file-level drift is hidden by the same declared external variable on both sides
- `equal-value-provenance`: winning file changes but its value does not
- `startup-review`: `NODE_OPTIONS`, `NODE_PATH`, or `NODE_NO_WARNINGS` requires separate startup-behavior review, even when masked or equal

Categories describe contributing or latent differences, not a claim of exclusive causality. A parser difference can be present without an effective change. JSON includes all four counterfactual winning sources and evidence booleans to make such cases inspectable.

`--reverse-candidate` keeps the original dotenv order and reverses only the candidate native order. It reparses nothing and independently recomputes selection and external masking. Reversal may fail to fix a parser difference, may introduce new drift under `override:true`, and cannot clear a startup-review finding.

Exit codes:

- **0**: no observed effective change; informational findings may remain
- **1**: definite/possible drift or manual startup review
- **2**: invalid or unsupported input; no compatibility conclusion

See [SCHEMA.md](SCHEMA.md) and [report.schema.json](report.schema.json) for the report contract. Errors have fixed codes and optional zero-based file indices, never raw parser errors or input excerpts.

## Privacy and safety boundaries

Production code uses only `dotenv.parse` and Node's `util.parseEnv`, with an in-memory merge model. It does **not** source files, expand variables, execute shell substitutions, populate `process.env`, start a child process, launch your application, modify files, or upload anything. Strings such as `$(command)` remain inert. Tests alone launch real loaders against synthetic fixtures and controlled child environments.

Reports intentionally contain **variable names, declared external names and your supplied file paths**. Those are metadata and can themselves be sensitive; review before sharing. This is not a general-purpose secret redactor. Do not put credentials in filenames or external-name arguments, upload real `.env` files to this repository, or assume other commands/CI logs hide values.

A parser may reinterpret part of a multiline value as a new key. To avoid printing that material, the tool refuses any per-file parser key-set disagreement with `parser-key-set-drift`, without naming added/removed variables. It still compares differing values when both parsers recognize the same keys. It also conservatively rejects any reported variable name that occurs as a substring of a nonempty value produced by either parser. This can reject benign files such as `NAME=NAME` or interpolation-looking values containing another variable name. It emits a generic `ambiguous-name-value-overlap` error instead of a partial report.

Additional deliberately narrow boundaries:

- POSIX case-sensitive environment semantics only; Windows is rejected
- Portable ASCII names only: `[A-Za-z_][A-Za-z0-9_]*`; parser-produced unusual names are rejected without echoing them
- NUL anywhere is rejected, because real environment loading may truncate it
- `__proto__` anywhere, including a comment/value, is rejected: both parse APIs can omit this name although native loading can create it
- Maximum 32 files, 4 MiB per file, 2 MiB combined UTF-8 content, and 2,048 distinct reported names
- No alternate dotenv parser, dotenv-expand/dotenvx, framework discovery, interpolation, `.env.vault`, Bash, Docker or Compose semantics
- The source model uses dotenv's default regex parser and explicit path/override settings; environment-controlled options, custom `processEnv` wrappers and plugins are outside the model
- Malformed lines may be ignored or interpreted differently by the official parsers. This tool is a migration comparison, not a syntax linter. A 0 result does not prove the files are well formed

**This compares parsed configuration and declared loading rules, not full application compatibility.** Native flags run at Node startup, while dotenv usually runs inside application initialization. Timing, imports, other Node startup variables, permissions, application behavior and runtime versions still require review/testing. `NODE_OPTIONS`, `NODE_PATH` and `NODE_NO_WARNINGS` are always flagged, never applied or assessed for safety. This small known-control list is not an exhaustive startup-variable detector.

## How the comparison works

For each file, both official parsers run without applying the result. The engine computes:

1. dotenv parser + first-file wins
2. dotenv parser + last-file wins
3. Node parser + first-file wins
4. Node parser + last-file wins

The original dotenv model chooses (1), or (2) with `--override`. The native model chooses (4). Externally supplied names mask file values on both sides by default; dotenv `override:true` lets its file winner replace an external value while native loading still preserves the external value. Unknown external values are symbolic, so a changed winner is never incorrectly described as known-equal.

Duplicate assignments **inside one file** are left to each official parser; dotenv's `override` option controls file/external selection, not those duplicate assignments.

## Develop and verify

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

Tests cover precedence, reversed candidates, equal values, empty values, duplicate assignments, external masking, case sensitivity, BOM/CRLF, multiline/quotes/comments/export, malformed and unusual names, inert command-looking strings, runtime-specific parser behavior and canary privacy regressions. Real-loader tests cross-check the effective map and winning provenance against actual `dotenv.config` and `node --env-file` using synthetic input only.

Public CI uses standard Ubuntu runners for exactly Node 22.0.0 and 24.19.0, SHA-pinned official actions, read-only contents permission, no persisted checkout credentials, no secrets, no caches and no uploaded artifacts.

## References and provenance

- [dotenv path and precedence](https://github.com/motdotla/dotenv#path)
- [Pinned dotenv implementation](https://github.com/motdotla/dotenv/blob/v18.0.5/lib/main.js)
- [Node --env-file](https://nodejs.org/api/cli.html#--env-filefile)
- [Node util.parseEnv](https://nodejs.org/api/util.html#utilparseenvcontent)

References and dependency version checked October 5, 2026. The comparison engine, CLI, documentation and tests are original work under [MIT](LICENSE); dotenv retains its own upstream license. No adoption or production-readiness claim is implied. [SKILL.md](SKILL.md) provides an optional local-agent workflow.

## Creator disclosure

Prepared by the creator of [MyTest](https://mytest.app). This is an optional promotional link. The auditor works independently; no visit, account, or MyTest usage is required. There is no tracking or referral parameter in the link.

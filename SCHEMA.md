# Report contract, schema version 1

`--json` writes one object to stdout. On invalid/unsupported input, it writes an error object instead of any partial result. Text errors go to stderr. Exit status always refers to the original file-order comparison, not the reverse candidate.

`report.schema.json` describes structure. Additional fields require a schema-version change; consumers should validate `schemaVersion` before processing.

## Successful audit

- `tool`, `version`: tool identity and release
- `runtime`: exact `node` and `dotenv` versions plus host `platform`
- `input.files`: original ordered list of `{index, path}`; indices are zero-based
- `input.dotenvOverride`: source mode
- `input.externalNames`: sorted, deduplicated, explicitly supplied names
- `assumptions`: case-sensitive POSIX, unknown external values, declaration treated as complete, selected parser modes
- `summary`: `status`, counts `definite`, `possible`, `manualReview`, `informational`, and `exitCode`
- `variables`: sorted by JavaScript code-unit ordering of name; contains no values

Every full variable record has:

- `name`: portable ASCII variable name
- `change`: `none`, `definite`, or `possible`
- `categories`: ordered array from `parser`, `file-precedence`, `external-masking`, `masked-difference`, `equal-value-provenance`, `startup-review`
- `manualReview`: true for `NODE_OPTIONS`, `NODE_PATH` or `NODE_NO_WARNINGS`
- `baseline`, `native`: winning source `{kind:"file",fileIndex:N}`, `{kind:"external"}` or `{kind:"absent"}`
- `counterfactuals`: source-only `dotenvFirst`, `dotenvLast`, `nodeFirst`, `nodeLast`, before external masking
- `evidence.parserFiles`: original file indices whose parsed presence or value differs, in evaluated input order
- `evidence.parserUnderFirst`, `parserUnderLast`: parser differences survive selection with that policy
- `evidence.precedenceUnderDotenv`, `precedenceUnderNode`: first/last policy changes a parsed value or presence with that parser
- `evidence.maskedDifference`: file drift hidden by the same declared external name with override false

A category can describe a latent difference even if `change` is `none`. `informational` counts variables with categories but no change or manual review, not all equal variables. Manual review is counted independently of drift.

`reverseCandidate`, when requested, contains `nativeFileOrder`, its own `summary`, and shorter variable records (`name`, `change`, `manualReview`, `baseline`, `native`, empty `categories`). Original dotenv selection remains fixed. Candidate summaries count definite/possible/manual-review findings; their informational count is always zero.

## Error object

`{schemaVersion:1, tool:"env-loader-audit", error:{code, fileIndex?}, exitCode:2}`

Current codes:

- CLI: `invalid-arguments`, `missing-external-name`, `invalid-file-list`, `file-read-failed`, `not-regular-file`, `file-too-large`, `invalid-utf8`
- Engine: `unsupported-windows-environment`, `unsupported-node-version`, `invalid-options`, `invalid-external-names`, `invalid-file`, `total-input-too-large`, `too-many-variables`, `parse-failed`, `unsupported-variable-name`, `unsupported-content`, `unsupported-prototype-token`, `parser-key-set-drift`, `ambiguous-name-value-overlap`
- Unexpected caught failure: `audit-failed`

No raw exception message, failed path, content excerpt or partial variable list is included. `fileIndex` is present only when failure was attributable to a specific supplied file.

Reports deliberately reveal names and user-supplied paths. They never serialize value fields, value hashes or value lengths. A privacy guard rejects name/value overlaps rather than emit an ambiguous name; this does not make report metadata safe for arbitrary publication.

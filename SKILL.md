---
name: env-loader-audit
description: Compare explicit local dotenv files with the running Node --env-file parser and loading rules before a migration. Reports causes and provenance without printing values; not a general environment linter or application compatibility certificate.
---

# Audit a dotenv-to-Node migration

Use this checkout's `bin/env-loader-audit.js`; install its pinned dependency with `npm ci --ignore-scripts --no-audit --no-fund` when authorized. Run on the intended deployment Node version (supported POSIX mode, Node >=22). Do not silently install/switch runtimes.

Get the exact original file order, dotenv `override` setting, and complete relevant external variable names. Never request external values. Do not discover project files, read the ambient environment, source `.env` files, launch the application with these files, or upload them.

Example with synthetic local paths:

```sh
node bin/env-loader-audit.js --json --reverse-candidate --external PORT -- /project/.env.local /project/.env
```

Use `--override` only when it matches the source dotenv call. Without a complete external-name declaration, results are conditional on omitted variables being absent.

Read the JSON summary and per-variable evidence. Explain definite versus possible drift, parser/file-order causes, external masking and equal-value provenance. A reversed-order candidate is separately recomputed; it is not an applied fix. Preserve manual startup review for flagged Node startup controls even if the values compare equal.

Exit 2 means unsupported/invalid input, not compatibility. Do not bypass the NUL/prototype/key-set/name-value-overlap guards or print source snippets to diagnose them. Describe the fixed error code and affected file index. Refer to README boundaries and SCHEMA.md if needed.

Keep reports local by default: they hide values but contain names and supplied paths. Obtain the user's authorization before changing configuration, running the application or sharing findings externally. A 0 result does not certify application behavior or well-formed syntax.

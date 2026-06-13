# Changelog

Notable changes to TreeTrace. The format follows Keep a Changelog, and the project uses semantic versioning.

## Unreleased

### Security

- Redaction now catches generic secret assignments whose quoted value contains escaped characters, such as the serialized JSON form `{"api_key":"line1\nline2"}` with a literal backslash, an escaped quote, an escaped tab, or an escaped backslash. Serialized JSON is a common way for multiline and escaped secret values to appear in transcripts, and these shapes previously reached written artifacts even under `--redact-auto`.

### Fixed

- The hallucination detector no longer reports ordinary dotted code symbols such as `JSON.parse`, `params.name`, `test.skip`, and `describe.skip` as missing file paths. A dotted token with no slash is only treated as a file reference when its extension is a known file extension, so member expressions are left alone while genuine paths such as `src/missing.ts` are still flagged.
- The hallucination detector now recognizes common extensionless file references, including `Dockerfile`, `Makefile`, `README`, `.env`, and slash-containing local paths such as `src/route`. Known filename words are only flagged when a file-operation verb is nearby, which keeps prose mentions from becoming false positives.

## 0.5.0 - 2026-06-13

### Added

- `--security` focused report mode. Prints a security-focused report that leads with concrete failure classes and answers five questions from the existing analysis: whether the agent touched auth, secrets, access control, crypto, dependency config, CI, deployment, or tests; whether it disabled or skipped tests; whether it ran risky shell commands; whether it referenced files, paths, imports, or packages that do not exist; and which human correction should become a future eval or memory item. It reuses the same signals as the full analysis and does not run a separate scanner. The report prints to stdout and writes `.treetrace/hallucinations.json`, both gated through the redaction shadow scan.
- Deterministic hallucination detector. TreeTrace runs inside the repository, so it extracts the files, paths, imports, and packages the agent referenced in prompts and captured actions, then verifies them against the real working tree and `package.json`, `package-lock.json`, and Python manifests. References that do not resolve are flagged as likely hallucinations in two categories, `hallucinated_file_or_path` and `hallucinated_import_or_package`, and surfaced both in the security report and in `.treetrace/hallucinations.json` (mirroring the `failures.json` shape). Each one carries an eval candidate. File and path existence and import and package declaration are checked; per-symbol and per-API resolution inside a module is not attempted, and the tool says so. Files the agent created during the session, Node builtins, and Python standard library modules are excluded to avoid false positives. Relative paths inside the project (`./` and bare) are resolved and verified; absolute paths and `../` references that fall outside the project directory are treated as out of scope and are never stat checked, so detection never reveals host filesystem state outside the project.
- Read-only MCP server. `treetrace mcp` (or `treetrace --mcp`) starts a Model Context Protocol server over stdio using JSON-RPC 2.0, hand-rolled with no dependencies. It implements `initialize`, `tools/list`, and `tools/call`, and exposes four read-only tools that reuse existing functionality: `handoff`, `lessons`, `security_summary`, and `eval_candidates`. No tool mutates files, runs shell, hits the network, or requires authentication. Every returned text passes the same redaction shadow scan as the file exports. Tools take no arguments and reject extra arguments; point the server at a project with `--dir` or import with `--file` (the JSON-RPC transport owns stdin, so `--stdin` is not available in MCP mode).

### Security

- Redaction now catches generic secret assignments written in JSON style (`"api_key":"..."`), single-quoted keys, backtick values, and multiline quoted values, and treats a generic secret-key assignment as a finding even when the value has low entropy. Over-redaction is the safe side for a privacy tool. These shapes previously reached written artifacts even under `--redact-auto`.
- A prior `keep` decision in `.treetrace/redactions.json` is no longer honored for high or medium findings under `--redact-auto`, non-interactive (non-TTY) runs, or the MCP server. A `keep` is only honored inside an interactive terminal session, so a preseeded redactions file in an untrusted repository can no longer cause a raw secret to be emitted.
- The hallucination detector and MCP `security_summary` no longer stat absolute paths or `../` references outside the project directory, removing a filesystem existence oracle.
- Claude session auto-discovery validates each session's recorded `cwd` against the target directory, so a different project whose path munges to the same storage directory name is no longer read.

### Fixed

- The hallucination detector flags an `Edit` or `NotebookEdit` to a file that does not exist in the working tree (only `Write`, or an edit to a file that exists, counts as created), and resolves relative (`./`, bare) missing paths that were previously skipped.
- Risky-command detection covers `rm -fr`, `rm -r -f`, `chmod -R 777`, `chmod 0777`, `curl | sudo bash`, `curl | zsh`, `bash <(curl ...)`, `DROP SCHEMA`, and bare `TRUNCATE`. Test-disable detection covers `test.skip`, `describe.skip`, `it.skip`, `xit`, and similar framework skip and removal idioms.
- Value-taking options (`--from`, `--dir`, `--out`, `--report-file`, `--since`) reject a missing value or a value that begins with `--`, so a typo no longer writes a file named after a flag. `--since` requires a real date and applies only to timestamped sessions. `--stdin --from claude` is rejected with a clear message.
- `--handoff` persists redaction decisions to `.treetrace/redactions.json` when any were made.

## 0.4.1 - 2026-06-13

A fix release driven by an adversarial end-to-end test pass across every adapter on real sessions. See [TESTING.md](TESTING.md) for the method and coverage.

### Fixed

- Security: bare hexadecimal secrets of 32 characters or more, a common shape for framework secret keys and HMAC signing keys, are now redacted. They were previously not detected and could reach a written artifact even with `--redact-auto`. A 40 character git commit hash is also redacted, which is the safe default for a privacy tool. Covered by a regression test and the leak self-test.
- Redaction no longer aborts on a single very large token. A multi-megabyte pasted blob used to overflow the regex stack and end the run with an internal error. The scan is now bounded.
- Security signal precision. A benign long flag such as `--force-device-scale-factor` and a user interface file named like `semantic-tokens.ts` no longer mint a high confidence credential signal. A single bare keyword with no corroborating evidence is down tiered below verified. Real credential files and secret-handling commands still verify.
- `tree.json` records the actual source tool (`codex-rollout`, `chatgpt-export`, `gemini-cli`, `copilot-chat`, `cursor-export`, `grok-cli`, `claude-code-jsonl`, `transcript`) instead of always reporting `claude-code-jsonl`.
- The handoff brief picks the latest accepted direction chronologically rather than by insertion order, so a multi-session export no longer names a stale topic.
- `--from` is honored together with `--stdin`.
- `--analysis` combined with `--report` writes both the analysis files and the reports instead of silently dropping the tree and reports.
- The Copilot and Cursor adapters fail gracefully on malformed or empty JSON instead of throwing a raw error.
- Markdown footers stamp the tool version, and command evidence inside code blocks is no longer HTML escaped.
- Grok format detection requires a Grok specific signal, so a Cursor style export is no longer at risk of being routed to the Grok parser.

## 0.4.0 - 2026-06-13

This release rebuilds the analysis layer so the output holds up on a real session, and turns the security positioning into something the tool actually produces.

### Added

- Security audit trail. TreeTrace flags every agent action that touched auth, secrets, or access control, with a confidence tier (verified, high, confirmed, inferred), the evidence, and the model that did it. The signals land in `failures.json`, the report, and `agent-memory.md`.
- Per-turn agent actions in the lineage. Each prompt carries the tools the agent ran, the file it touched, the Bash command, a truncated tool-input summary, and the model. That is what makes the verified security tier possible.
- Constraint extraction. `agent-memory.md` lists the rules the user actually enforced during the session (license, local-only, no inline comments, narrow the product, and so on) instead of claiming none were found.
- Known bad paths. Destructive-then-recovery episodes, such as a file deleted and then restored, are detected and recorded so the next agent knows where the sharp edges are.
- Reasoning-block count and model attribution in the report.
- Import adapters emit per-turn actions for Codex, Gemini, Copilot, and Cursor, which unlocks the verified tier for imported sessions.
- Both the curated and raw prompt counts are shown, so a merge of duplicate or continuation turns is explained rather than looking like a miscount.
- Repository housekeeping: `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates, and a tag-triggered publish workflow.

### Changed

- Failure detection is corroborated and time-aware. A single prompt no longer mints three different failures, and a correction can no longer resolve a failure that happened after it. Linkage prefers shared files and real text overlap over array position.
- Redaction now covers agent action bodies, not just prompt text, so a token in a Bash command cannot reach an artifact.
- Lessons read as concrete, attributed notes drawn from the real evidence instead of one boilerplate line per failure type.
- The prompt-tree legend only lists the markers that appear in the tree.
- The handoff accepted-decisions list drops apologies, acknowledgements, and questions.

### Fixed

- User prompts that the harness wrapped in a `<system-reminder>` or `<task-notification>` block were dropped entirely. The real prompt text is now recovered, which on a one-hour test session brought back twelve genuine turns, including stated constraints and decisions.
- Redaction no longer matches the `sk` inside ordinary words, and GitHub token shapes (`ghp_` and related) are caught.

## 0.3.0 - 2026-06-12

- Import adapters for Codex, ChatGPT, Gemini, Copilot, Cursor, Grok, and plain transcripts.
- Local-first redaction gate with provider rules, high-entropy fallback, interactive review in a terminal, and fail-closed behavior everywhere else.
- Prompt lineage tree, failure analysis, eval export, lessons, and agent handoff memory.
- Apache-2.0 license.

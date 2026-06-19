# Changelog

Notable changes to TreeTrace. The format follows Keep a Changelog, and the project uses semantic versioning.

## 0.9.1 - 2026-06-19

### Added

- `tree.json` now exports token totals (aggregate stats and per-session), a per-turn `model` field on each node, and a per-node `actions` array (tool invocations, file paths, and Bash commands). Claims in the README about token usage, model-per-turn, and tool/file capture now reflect what the schema exports.
- Bash-command file paths are now counted in `filesTouched`.

### Changed

- Hallucination detection no longer flags prose `word/word` fragments as missing file paths, and now checks the structured `action.file` path for Write, Edit, and NotebookEdit actions.
- Analysis adds an inferred-tier recall backstop so strongly worded uncorroborated frustration, scope-drift, and overbuilt-solution turns still surface a signal.
- The `bearer` redaction rule is now case-insensitive, and `--redact-auto` resolves residual high-entropy shadow-scan hits instead of failing closed; the interactive fail-closed path is unchanged.
- The combined report counts the full set of models seen and lists correction chains.
- Examples regenerated for v0.9.1.

### Documentation

- `SCHEMA.md` documents the new token, model, and action fields and the `hallucinations.json` shape.
- Signal-coverage matrix version label updated from v0.8.1 to v0.9.1.
- Terminal output modes (`--graph`, `--full`, `--summary`) documented as early-return modes that do not compose with `--report` or `--analysis`, and the CLI now prints a notice when other output flags are skipped because a graph mode is set.

## 0.8.1 - 2026-06-19

### Changed

- Relicensed from Apache-2.0 to the PolyForm Noncommercial License 1.0.0 (SPDX: `LicenseRef-PolyForm-Noncommercial-1.0.0`). TreeTrace is now free for any noncommercial purpose (personal, research, education, nonprofit, government) and commercial or for-profit use requires a separate license from the copyright holder (zionboggan@gmail.com). The relicense applies to this version onward; copies obtained under 0.8.0 and earlier remain under Apache-2.0 for those versions. `package.json` declares `LicenseRef-PolyForm-Noncommercial-1.0.0`, and `LICENSE` is included in the published package files.

## 0.8.0 - 2026-06-18

### Added

- Typed rejection, refusal, and decline capture (schema v0.3). TreeTrace now records six classes of human-steering event that previously vanished from the lineage: a user declining a proposed tool action (`user_declined_tool`), an interrupt (`user_interrupt`), a typed decline like "stop, don't do that" (`user_text_decline`), a tool execution error (`tool_execution_error`), an environment permission denial (`permission_denied`), and a model refusal (`model_refusal`, captured from both `stop_reason: "refusal"` at 0.95 confidence and refusal text at 0.7). Each rejection carries kind, source, confidence, tool-use id, timestamp, and redacted evidence. Native Claude Code JSONL is fully wired; the other adapters gain an `addRejection` helper in `adapters/shared.js` for per-source wiring in later releases. Detection patterns are named, individually testable regex pieces composed at load time, following the v0.7.0 precedent for security intent and risky-command detection.
- `--rejections` CLI flag. Mirrors `--failures` / `--lessons` / `--security` and writes `.treetrace/rejections.json`, a flattened, timestamp-sorted ledger of every captured rejection with a `byKind` summary. Each entry joins back to its source node id so consumers can locate it in the tree.
- Read-only MCP `rejections_summary` tool. The MCP server gains a sixth read-only tool that returns the same rejection view as `--rejections`, so an agent can ask "what did the human reject in this session?" without leaving the protocol. Same no-arguments, no-mutations, redaction-shadow-scan-gated shape as the existing five tools.
- Four new failure types derived from rejections: `user_rejected_action`, `tool_execution_failed`, `model_refused`, `permission_denied`. Each generates a lesson and an eval candidate of the matching type (`tool_permission_regression`, `tool_error_recovery`, `refusal_handling`), so the same failure-to-eval-to-handoff loop that existed for security and scope drift now exists for rejections.
- `rejection` as a new PromptNode `kind` for synthetic nodes that exist only to carry a rejection signal (e.g. a tool-result rejection that arrived before any text prompt). Such nodes have empty `text`, a derived `title`, and one or more entries in `rejections`.

### Changed

- Schema version bumped from `0.2` to `0.3`. Additive only; consumers that only understand v0.2 can keep reading `nodes` and `edges` and ignore `rejections`. The bump is centralized in `src/config.js` and propagates to every writer (per the v0.7.0 single-source change).
- The redaction gate now scans `node.rejections[].evidence` alongside prompt text and action bodies, and applies the same redaction decisions to it. A secret in a tool_result error message or refusal text is now caught before any written artifact. Covered by a regression test.
- The CLI `--from claude` value is now honored explicitly instead of falling through to the "unknown tool" error. The `TOOLS` array has always advertised `claude`; this closes the false-advertising gap end-to-end.
- `flattenUserContent` now returns tool_result contents (`toolResults: [{ toolUseId, isError, content, contentType }]`) instead of just a count, so rejection classification has the text it needs.

### Performance

- Rejection surfacing stays O(N) over nodes times O(R) over rejections per node (R bounded by tool blocks per turn). The pass deliberately does not call `nearestCorrectionAfter` / `nearestAcceptedAfter` for rejection-derived failures (each is O(N) and would reintroduce the quadratic scaling the v0.7.0 release eliminated on rejection-heavy sessions). A rejection IS the failure event; its resolution is implicit in the next accepted turn rather than something we chase. Covered by a 5000-node × 3-rejection regression test that completes in well under the 15s threshold.

## 0.7.0 - 2026-06-18

### Added

- `--keep-git-shas` retains git object hashes as non-secret. A 40 character commit SHA and a 64 character tree or blob hash are ordinarily redacted, which is the safe default for a privacy tool. When you are reviewing a session that legitimately discusses git history, pass `--keep-git-shas` to keep a hash that appears in git context (next to `commit`, `sha`, `HEAD`, a `git` command, or similar) while still redacting it everywhere else. The flag is opt-in and fail-closed: a hash is only kept when the flag is set, the surrounding text is git context, and the finding is not a high-severity secret, so a real key shaped like a hash is never exposed. The run reports how many hashes it kept.
- Read-only MCP `tree` tool. The MCP server gains a fifth read-only tool that returns the assembled prompt tree as canonical JSON, the same structure the CLI renders, so an agent can read the lineage directly instead of only the derived handoff and lessons. Like the existing tools it takes no arguments, mutates nothing, and passes the redaction shadow scan before returning.
- Structured exit codes. The CLI now exits with a documented, stable code instead of a bare 1 on every error: 0 success, 1 internal error, 2 usage error (a bad flag, a missing value, an unknown option), 3 no usable data (no sessions, no prompts, nothing since a date), and 4 a withheld write that would have leaked a secret. The codes are listed under `Exit codes:` in `--help`, so a script or CI step can branch on the reason a run stopped.

### Changed

- The security intent and risky command detectors are now built from named, individually testable regex pieces composed at load time instead of two hand-maintained monolithic patterns. Behavior is unchanged and covered by equivalence tests; the change makes the security signals easier to audit and extend.
- The artifact schema version is defined in one place and shared by every writer (`tree.json`, the JSON render, and the hallucination export) instead of being repeated as a literal, so the schema version can never drift between artifacts.

### Performance

- Tree assembly and analysis no longer scale quadratically. `buildTree` previously resolved each node's parent with a linear scan of the node list, and `analyzeTree` recomputed token sets while walking the tree, so both grew as O(N^2) on the node count. Parent resolution is now a single pass and token sets are memoized per node, taking both to O(N). Output is byte-identical to before; large sessions assemble and analyze noticeably faster.

## 0.6.0 - 2026-06-16

### Added

- Prompt-tree graph visual via `treetrace --graph`. Emits `PROMPT_TREE_GRAPH.md`, a brand-styled Mermaid flowchart that runs from the goal through the steered progression of prompts to the result, with abandoned explorations as dimmed dotted detours. The diagram renders natively and free on GitHub and any Mermaid viewer, with zero runtime dependencies. Edge labels carry an opaque backing so their text stays legible over the spine line, and node labels truncate on a word boundary so they never end mid-word.
- Large-project summary mode for the graph. Once a tree exceeds 25 live nodes, the graph automatically collapses to a spine-only summary so the whole project still reads at a glance: each abandoned branch folds into a single dim "N abandoned steps" stub, routine intermediate steps fold into "N steps" count stubs, and the goal, strategic turns, failure-flagged nodes, and result are kept. Small trees render in full. Pass `--full` or `--summary` to force a mode.

## 0.5.1 - 2026-06-15

### Fixed

- Package metadata, README, and config links now point to github.com/TreeTraceTool/TreeTrace.

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
- Redaction now catches generic secret assignments whose quoted value contains escaped characters, such as the serialized JSON form `{"api_key":"line1\nline2"}` with a literal backslash, an escaped quote, an escaped tab, or an escaped backslash. Serialized JSON is a common way for multiline and escaped secret values to appear in transcripts, and these shapes previously reached written artifacts even under `--redact-auto`.
- The high-entropy fallback now catches a long secret made only of lowercase letters and digits (no uppercase), such as a bare token pasted in prose. The previous rule required all three character classes, so a high-entropy lowercase-and-digit token could reach a written artifact; the entropy threshold still keeps ordinary identifiers, UUIDs, and paths from being flagged.

### Fixed

- The hallucination detector flags an `Edit` or `NotebookEdit` to a file that does not exist in the working tree (only `Write`, or an edit to a file that exists, counts as created), and resolves relative (`./`, bare) missing paths that were previously skipped.
- Risky-command detection covers `rm -fr`, `rm -r -f`, `chmod -R 777`, `chmod 0777`, `curl | sudo bash`, `curl | zsh`, `bash <(curl ...)`, `DROP SCHEMA`, and bare `TRUNCATE`. Test-disable detection covers `test.skip`, `describe.skip`, `it.skip`, `xit`, and similar framework skip and removal idioms.
- Value-taking options (`--from`, `--dir`, `--out`, `--report-file`, `--since`) reject a missing value or a value that begins with `--`, so a typo no longer writes a file named after a flag. `--since` requires a real date and applies only to timestamped sessions. `--stdin --from claude` is rejected with a clear message.
- `--handoff` persists redaction decisions to `.treetrace/redactions.json` when any were made.
- The hallucination detector no longer reports ordinary dotted code symbols such as `JSON.parse`, `params.name`, `test.skip`, and `describe.skip` as missing file paths. A dotted token with no slash is only treated as a file reference when its extension is a known file extension, so member expressions are left alone while genuine paths such as `src/missing.ts` are still flagged.
- The hallucination detector now recognizes common extensionless file references, including `Dockerfile`, `Makefile`, `README`, `.env`, and slash-containing local paths such as `src/route`. Known filename words are only flagged when a file-operation verb is nearby, which keeps prose mentions from becoming false positives.
- The hallucination detector no longer reports `process.env` as a missing file. A bare `name.env` token with no slash is treated as a member expression, while genuine `.env` files and `path/to/file.env` references are still resolved.
- A relative `require('./x')` or dynamic `import('./x')` is no longer reported as a missing import named `.`. Relative and local module specifiers are skipped before the package root is taken, and a genuinely missing relative file is still flagged as a file reference.

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

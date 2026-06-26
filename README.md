<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/TreeTraceTool/TreeTrace/main/.github/assets/logo-dark.svg">
  <img alt="TreeTrace" src="https://raw.githubusercontent.com/TreeTraceTool/TreeTrace/main/.github/assets/logo-light.svg" width="440">
</picture>

<h3>Catch your AI agent's security slips. Turn them into local regression evals.</h3>

<p><b>TreeTrace reads the session transcript on your machine, flags every touch of auth, secrets, or tests and every risky command, and captures the human correction as a deterministic eval. No upload. No telemetry. No LLM judge.</b></p>

<p><i>Local-first security regression for AI coding agents.</i></p>

<p>
  <a href="https://www.npmjs.com/package/treetrace"><img alt="npm" src="https://img.shields.io/npm/v/treetrace?style=flat-square&label=npm&color=2E5BFF&labelColor=0B0C0E"></a>
  <a href="https://github.com/TreeTraceTool/TreeTrace/actions/workflows/ci.yml"><img alt="ci" src="https://img.shields.io/github/actions/workflow/status/TreeTraceTool/TreeTrace/ci.yml?branch=main&style=flat-square&label=ci&color=2E5BFF&labelColor=0B0C0E"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache%202.0-2E5BFF?style=flat-square&labelColor=0B0C0E"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A518-2E5BFF?style=flat-square&labelColor=0B0C0E">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-2E5BFF?style=flat-square&labelColor=0B0C0E">
  <img alt="local-first" src="https://img.shields.io/badge/local--first-no_telemetry-2E5BFF?style=flat-square&labelColor=0B0C0E">
  <a href="#accuracy"><img alt="accuracy" src="https://img.shields.io/badge/blind--holdout_F1-0.93-2E5BFF?style=flat-square&labelColor=0B0C0E"></a>
  <img alt="tests" src="https://img.shields.io/badge/tests-166%2F0-2E5BFF?style=flat-square&labelColor=0B0C0E">
</p>

<p>
  <a href="#install">Install</a> &nbsp;&middot;&nbsp;
  <a href="#why-it-exists">Why</a> &nbsp;&middot;&nbsp;
  <a href="#what-one-record-makes-possible">Use cases</a> &nbsp;&middot;&nbsp;
  <a href="#what-it-captures">What it captures</a> &nbsp;&middot;&nbsp;
  <a href="#accuracy">Accuracy</a> &nbsp;&middot;&nbsp;
  <a href="#outputs">Outputs</a> &nbsp;&middot;&nbsp;
  <a href="#mcp-server">MCP</a> &nbsp;&middot;&nbsp;
  <a href="examples/">Examples</a> &nbsp;&middot;&nbsp;
  <a href="https://treetrace.dev">treetrace.dev</a>
</p>

<p align="center"><a href="https://treetrace.dev/assets/treetrace-v43.mp4"><img src="https://treetrace.dev/assets/treetrace-v43-poster.jpg" alt="Watch the TreeTrace demo video" width="760"></a></p>

<!-- demo.gif intentionally omitted: the in-terminal walkthrough GIF is being regenerated from the recolored promo video. Re-add it here once the cobalt-branded capture is ready. -->

</div>

## Install

```bash
cd your-project
npx treetrace
```

Node.js 18 or newer. TreeTrace ships with no runtime dependencies, so `npx treetrace` needs nothing else installed. No accounts, no uploads, no telemetry. Your transcripts never leave your machine.

## Why it exists

Git history shows what changed. TreeTrace shows how the work actually got done.

Coding and CLI agent sessions contain the most useful steering data you generate: where the model misunderstood the goal, which correction fixed it, which branch was abandoned, what constraint kept getting ignored, what the agent was refused or denied, and what should carry forward so the next session does not repeat the waste. That data vanishes when the session ends. TreeTrace captures it locally as a structured, vendor-neutral record.

## What one record makes possible

One record. Many uses.

### Today

<table>
<tr>
<td width="50%" valign="top">

**Model-training data**

Real corrections become regression evals. No LLM judge.

</td>
<td width="50%" valign="top">

**Dev & token efficiency insight**

See the cost of rework and where steering was needed.

</td>
</tr>
</table>

### Where is it headed?

<table>
<tr>
<td valign="top">

**Compliance & GRC**

A redacted, signed-off record of what an agent did and was refused. Not a current capability - the foundation is being built toward this.

</td>
</tr>
</table>

## What it captures

TreeTrace reads coding and CLI agent sessions (Claude Code, Codex, Cursor, Copilot, ChatGPT export, Gemini, Grok) and extracts:

- **Prompt lineage** - nodes, edges, parent chain, and prompt kinds (root, direction, correction, scope-change, checkpoint, question, rejection)
- **Token usage** - input and output token counts per session (adapter coverage varies; see matrix below)
- **Models used** - which model handled each turn
- **Tools and files** - every tool invocation and file path touched
- **Human steering** - corrections, scope changes, checkpoints, and abandoned branches
- **Refusals and denials** - typed rejection events: `user_declined_tool`, `user_interrupt`, `user_text_decline`, `tool_execution_error`, `permission_denied`, `model_refusal`
- **Failed tasks** - failure signals with type, confidence score, evidence text, and source node IDs
- **Timestamps** - session first and last timestamps across all adapters

### Signal coverage by adapter

Signal coverage depends on what each tool exports. The matrix below reflects the actual source code (v0.10.0); cells marked `--` are confirmed absent. A plain `User:` / `Assistant:` transcript imported with `--from transcript` also captures prompt lineage, corrections, model refusals, and user declines.

| Signal | Claude Code | ChatGPT | Codex | Cursor | Copilot | Gemini | Grok |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Prompt lineage | full | full | full | full | full | full | full |
| Input tokens | full | -- | full | -- | -- | partial | -- |
| Output tokens | full | -- | full | -- | -- | partial | -- |
| Cost in USD | -- | -- | -- | -- | -- | -- | -- |
| Cache tokens | -- | -- | -- | -- | -- | -- | -- |
| Models used | full | partial | full | partial | partial | partial | partial |
| Tool uses | full | partial | full | full | full | full | partial |
| Files touched | full | -- | full | full | full | full | -- |
| Bash commands | full | -- | partial | partial | partial | partial | -- |
| Refusals / denials | full | partial | partial | partial | -- | partial | -- |
| Thinking / reasoning blocks | partial | -- | full | -- | -- | full | -- |
| Timestamps (first/last) | full | partial | partial | partial | partial | partial | partial |
| Per-turn latency | -- | -- | -- | -- | -- | -- | -- |
| Corrections / scope-changes | full | full | full | full | full | full | full |
| Rejections by kind | full | partial | partial | partial | -- | partial | -- |

Refusal capture: `full` on Claude Code (model refusal by text and stop-reason, user declines, tool-permission denials); `partial` on ChatGPT, Codex, Cursor, and Gemini (assistant-text model refusals). Copilot and Grok exports do not currently surface refusal signals.

**Cell key:** `full` - extracted and stored in schema field. `partial` - extracted where the source format exposes it. `--` - not captured; confirmed absent in source code.

Claude Code (native JSONL) is the richest source: it covers all rejection kinds, thinking blocks, token deduplication by message ID, and file paths from tool inputs. All other adapters capture prompt lineage and corrections; token and refusal coverage varies.

## Accuracy

TreeTrace's analysis layer is validated against a seeded ground-truth benchmark of 40 scenarios. Each scenario pairs a real signal with a benign distractor, so the benchmark measures precision and recall, not just coverage. A blind holdout split is kept out of development, so reported accuracy reflects generalization rather than memorization. Every result is reproduced on committed code, and the full test suite gates every change.

| Metric | Result |
| --- | --- |
| Blind-holdout F1 | **0.93** (from 0.72) |
| False positives (benchmark) | **40 → 18** (more than halved) |
| Analysis-layer precision / recall | 0.95 / 0.97 |
| Unit tests | **166 / 0** |
| Scenarios / blind splits | 40 / 2 |

Detectors are deterministic, exact-match rules tuned to a published taxonomy and scored independently per signal class: corrections and declines, credential and security exposure, hallucinated file references, destructive actions, and lesson quality. Precision is held or improved at every step, so the tool does not trade false positives for coverage.

## Outputs

| Artifact | Purpose |
|----------|---------|
| `TREETRACE_REPORT.md` | Combined human-readable report for review, terminals, and chat handoff |
| `PROMPT_TREE.md` | Human-readable narrative of the build path |
| `.treetrace/tree.json` | Canonical machine-readable lineage schema |
| `.treetrace/failures.json` | Failure signals, correction chains, and summaries |
| `.treetrace/rejections.json` | Typed rejection, refusal, decline, tool-error, and permission-denial events |
| `.treetrace/hallucinations.json` | Files, paths, imports, and packages the agent referenced that do not exist in the working tree |
| `.treetrace/lessons.md` | Human-readable lessons for future work |
| `.treetrace/evals.jsonl` | Generic model-agnostic eval cases |
| `.treetrace/agent-memory.md` | Compact memory pack for Codex, Claude Code, Cursor, or another agent |
| `PROMPT_TREE_GRAPH.md` | Branded Mermaid graph of the prompt tree from `treetrace --graph`; renders free on GitHub with no dependencies, and large projects auto-summarize |
| `treetrace --handoff` | Agent-ready continuation brief printed to stdout |

<details>
<summary><b>How it works, step by step</b></summary>

<br>

1. **Discovers local transcripts.** Claude Code session files are found automatically from `~/.claude/projects/...`; plain transcripts can be imported with `--file` or `--stdin`.
2. **Extracts prompt lineage.** Tool noise, slash-command wrappers, sidechain chatter, duplicate resends, and "continue" nudges are filtered or folded.
3. **Builds a fork-aware tree.** Corrections, scope changes, checkpoints, questions, abandoned branches, and accepted paths are derived from prompt topology and user text.
4. **Analyzes failures, rejections, and corrections.** TreeTrace adds failure signals, typed rejection/refusal events, correction chains, lessons, and eval candidates using transparent heuristics.
5. **Exports structured artifacts.** JSON, Markdown, JSONL, and handoff memory are written locally for agents, CI, eval harnesses, and humans.
6. **Gates every export with redaction.** Detected secrets must be resolved before anything is written; non-interactive runs redact automatically and shadow-scan rendered output.

</details>

<details>
<summary><b>All commands</b></summary>

<br>

| Command | What it does |
|---------|--------------|
| `npx treetrace` | Trace this project and write all artifacts |
| `npx treetrace --report` | Write all artifacts and print the human report |
| `npx treetrace --handoff` | Print an agent ready continuation brief |
| `npx treetrace --file session.jsonl` | Import specific session or transcript files (format auto-detected) |
| `npx treetrace --from chatgpt --file conversations.json` | Import another tool's export with an explicit format |
| `npx treetrace --stdin < chat.txt` | Parse a pasted `User:` / `Assistant:` transcript |
| `npx treetrace --failures` | Write and print `.treetrace/failures.json` |
| `npx treetrace --rejections` | Write and print `.treetrace/rejections.json` |
| `npx treetrace --lessons` | Write and print `.treetrace/lessons.md` |
| `npx treetrace --evals` | Write and print `.treetrace/evals.jsonl` |
| `npx treetrace --memory` | Write and print `.treetrace/agent-memory.md` |
| `npx treetrace --graph` | Write `PROMPT_TREE_GRAPH.md`, a branded Mermaid graph that renders free on GitHub with no dependencies; large projects auto-summarize, and `--full` or `--summary` force a mode |
| `npx treetrace --security` | Print a security-focused report and write `.treetrace/hallucinations.json` |
| `npx treetrace --each` | Write one full report bundle per session into `--out-dir` (default `treetrace-reports/`), plus `INDEX.md` and `index.json` manifests; auto-redacts each bundle and fails closed |
| `npx treetrace --deterministic` | Pin the generation timestamp so re-running on the same session produces byte-identical artifacts |
| `npx treetrace mcp` | Start a read-only MCP server over stdio |
| `npx treetrace --titles-only` | Compact human tree, no full prompt details |
| `npx treetrace --redact-auto` | Redact every detected secret without prompting |
| `npx treetrace --since 2026-06-01` | Limit to sessions on or after a date |

For a Terminus, Codex CLI, Claude Code, or SSH session where you want the report in the terminal window, use `npx treetrace --report --redact-auto`. For both terminal output and an extra shell-captured copy, pipe it: `npx treetrace --report --redact-auto | tee treetrace-output.md`.

**Terminal output modes (`--graph`, `--full`, `--summary`):** These three flags activate a terminal graph mode that returns early after writing `PROMPT_TREE_GRAPH.md`. They do not compose with `--report` or `--analysis`: when any of them is present, the graph is written and the run stops -- other outputs are skipped. `--full` and `--summary` control graph detail level (full node expansion vs. spine-only summary), not which artifacts are written. Run the graph as its own separate invocation from any report or analysis pass.

If you see a file literally named `output`, that usually came from `--out output` or shell redirection like `> output`. Prefer `TREETRACE_REPORT.md` for human reading and leave `.treetrace/*.json` / `.jsonl` for tools.

</details>

## Rejections and refusals

`treetrace --rejections` writes `.treetrace/rejections.json`, a timestamp-sorted ledger of typed human and environment stop signals. Native Claude Code JSONL capture currently recognizes:

- `user_declined_tool` - the human declined a proposed tool use
- `user_interrupt` - the human interrupted the agent mid-response
- `user_text_decline` - the human typed a decline such as "stop, don't do that"
- `tool_execution_error` - a tool result returned an execution error
- `permission_denied` - the environment denied access or permissions
- `model_refusal` - the model refused the request

Each entry includes the source node id, kind, source, confidence, timestamp, optional tool-use id, and redacted evidence. Rejections also surface as failure signals, lessons, and eval candidates, so a refused or rejected path becomes part of the same failure-to-eval-to-handoff loop as security and scope corrections.

## Security report

`treetrace --security` prints a security-focused report that leads with concrete failure classes. It reuses the same analysis as the full run and answers five questions:

1. Did the agent touch auth, secrets, access control, crypto, dependency config, CI, deployment, or tests?
2. Did it disable or skip tests?
3. Did it run risky shell commands?
4. Did it reference files, paths, imports, or packages that do not exist?
5. What human correction should become a future eval or memory item?

Here is a real one, from an actual session where an agent built API-key auth (`examples/api-key-auth/`):

```
# TreeTrace Security Report - api-key-auth

## Surfaces touched
- secrets: src/auth/apiKey.js [node_001, node_002]

## Security signals (highest tier first)
- (high) [node_003] risky command: "git commit -am 'wip' --no-verify && git push --force"
- (stated intent) [node_001] human security correction: "No, do not hardcode the
  secret in the source. Read the API key from an environment variable instead."

## Test skips
- (node_003) "The auth tests are failing. Just skip the auth tests for now so we can ship."

## Hallucinated references
- (hallucinated_file_or_path)  [node_001] "./src/middleware/rateLimit.js" does not exist
- (hallucinated_import_or_package) [node_001] "jsonwebtoken" is not a declared dependency

## Corrections to promote
- (node_002) "Read the API key from an environment variable instead." -> eval candidate
```

Every line is a transparent heuristic with the node IDs you can check. No model rendered that verdict. The report goes to stdout and the run writes `.treetrace/hallucinations.json`; both pass the redaction shadow scan before anything is printed or written. Full version: [examples/api-key-auth/SECURITY_REPORT.md](examples/api-key-auth/SECURITY_REPORT.md).

<details>
<summary><b>Deterministic hallucination detection</b></summary>

<br>

TreeTrace runs inside the repository, so it can verify what the agent claimed against what is actually there. It extracts the files, paths, imports, and packages referenced in prompts and captured actions, then checks them against the real working tree and the manifests (`package.json`, `package-lock.json`, and Python requirement files). References that do not resolve are flagged in two categories:

- `hallucinated_file_or_path`
- `hallucinated_import_or_package`

Each one becomes an eval candidate, for example "verify the file or import exists before editing." The checks are fully deterministic: file and path existence and import and package declaration. File references include paths with a known extension, common extensionless files such as `Dockerfile`, `Makefile`, `README`, and `.env`, and slash-containing local paths such as `src/route`. To avoid false positives, files the agent created during the session, relative paths, Node builtins, and Python standard library modules are excluded, ordinary dotted code symbols such as `JSON.parse` or `test.skip` are not treated as paths, and known filename words are only flagged when a file-operation verb is nearby.

This is honest about its limits. File, path, import, and package existence are solid. Per-symbol and per-API resolution inside a module is not attempted, because that would need an AST and a language toolchain, which would break the zero-dependency promise. TreeTrace does not claim to detect a hallucinated function or method on a real module.

</details>

<details>
<summary><b>Failure analysis and types</b></summary>

<br>

TreeTrace does not claim to perfectly understand every session. The first analysis pass is heuristic and explainable: every failure signal includes a type, confidence score, evidence text, and source node IDs.

Initial failure types include `ignored_constraint`, `misunderstood_goal`, `scope_drift`, `wrong_tool_choice`, `hallucinated_file_or_api`, `repeated_failed_fix`, `overbuilt_solution`, `underbuilt_solution`, `security_or_privacy_risk`, `dependency_or_environment_mismatch`, `format_violation`, `user_frustration`, `abandoned_path`, `user_rejected_action`, `tool_execution_failed`, `model_refused`, and `permission_denied`.

The goal is not judgment. The goal is a structured record: identify what future agents should preserve, avoid, or test.

</details>

## Eval export

`.treetrace/evals.jsonl` turns real session corrections into generic eval cases:

```json
{"id":"eval_001","source":"treetrace","type":"scope_drift_detection","task":"Continue development without drifting outside the corrected scope.","expected_behavior":["Stay inside the corrected scope","Do not add unrequested product surfaces"],"sourceNodeIds":["node_002","node_003"]}
```

The format is intentionally model-agnostic. Adapters for promptfoo, OpenAI Evals-style harnesses, LangSmith-style datasets, and other eval systems can build from this JSONL without changing TreeTrace's local-first core.

## MCP server

`treetrace mcp` (or `treetrace --mcp`) starts a Model Context Protocol server over stdio. It speaks JSON-RPC 2.0, is hand-rolled with no dependencies, and implements `initialize`, `tools/list`, and `tools/call`. It exposes six read-only tools, each reusing existing functionality:

- `handoff` - the continuation brief for the next agent
- `lessons` - accepted constraints and repeated corrections
- `security_summary` - evidence-backed security-sensitive touches
- `eval_candidates` - compact regression cases
- `tree` - the canonical prompt lineage JSON
- `rejections_summary` - typed rejection, refusal, decline, tool-error, and permission-denial events

No tool mutates files, runs shell, reaches the network, or requires authentication. Every returned text passes the same redaction shadow scan as the file exports. Point it at a project with `--dir`, or import a transcript with `--file`. The MCP server uses stdin for its JSON-RPC transport, so `--stdin` transcript paste is not available in MCP mode; use `--file` instead.

<details>
<summary><b>The redaction gate</b></summary>

<br>

A privacy-positioned tool gets exactly one chance with your secrets, so every export goes through the same gate:

- Curated provider rules for AWS, GitHub, GitLab, Anthropic, OpenAI, Slack, Stripe, npm, Tailscale, Google, SendGrid, Twilio, Telegram, Discord webhooks, JWTs, private key blocks, WireGuard keys, basic-auth URLs, bearer tokens, and secret assignments.
- High-entropy fallback for unknown token shapes.
- Detection for common line-wrapped provider tokens.
- Interactive review of every unique hit in a TTY.
- Automatic redaction outside a TTY.
- Shadow scan of the rendered artifact before write.
- `.treetrace/redactions.json` stores only content hashes and actions, never raw secrets.

</details>

<details>
<summary><b>Supported sources and adapters</b></summary>

<br>

TreeTrace reads Claude Code automatically and imports other tools through `--file`. When you pass a `.json` or `.jsonl` file, the format is auto-detected; you can also force it with `--from <tool>`. Everything stays local and passes the same redaction gate. The generic `User:` / `Assistant:` transcript parser remains the fallback for anything unrecognized.

Verified means the adapter was validated against real session or real published export data. Experimental means it was built to the tool's documented export schema and validated against a fixture in that exact shape, but not yet against a captured real session. See [test/fixtures/adapters/PROVENANCE.md](test/fixtures/adapters/PROVENANCE.md) for the source of every fixture.

| Source | `--from` | Status |
|--------|----------|--------|
| Claude Code (`~/.claude/projects` JSONL) | `claude` | Built-in, zero-config, verified |
| Codex CLI (`~/.codex/sessions/.../rollout-*.jsonl`) | `codex` | Verified against a real session |
| ChatGPT / OpenAI account export (`conversations.json`) | `chatgpt` | Verified against a real published export sample |
| Google Gemini CLI session (ChatRecordingService JSON) | `gemini` | Verified against the real gemini-cli session file |
| GitHub Copilot Chat session (`chatSessions/*.json`) | `copilot` | Verified against a real published session sample |
| Cursor exported chat JSON | `cursor` | Verified against the export schema (see note) |
| xAI Grok exported conversation JSON | `grok` | Experimental, built to the exporter schema |
| Pasted / plain-text transcripts (`User:` / `Assistant:`) | `transcript` | Built-in fallback |

**Why TreeTrace does not read SQLite.** Cursor stores its chat in a `state.vscdb` SQLite database, and the common Grok CLI keeps history in SQLite as well. That raw database is rich: it holds real file diffs, reasoning, rejected edits, and attached-file context. TreeTrace deliberately does not read it, because the zero-runtime-dependency promise is a feature, not an accident. Nothing extra to install, a smaller supply-chain and attack surface, and a tool that a privacy-conscious or security team can audit in one sitting matter more right now than the extra signal. So the Cursor adapter ingests an exported chat JSON instead: export your Cursor chat to JSON first (for example with a community Cursor chat exporter), then run `treetrace --from cursor --file your-chat.json`.

</details>

## Schema

`.treetrace/tree.json` uses the TreeTrace v0.3 schema documented in [SCHEMA.md](SCHEMA.md). It is designed to compose with Agent Trace: Agent Trace can describe which lines were AI-generated, while TreeTrace describes the human instruction lineage that shaped the build. Consumers should ignore unknown fields; failure signals, rejection events, correction chains, lessons, and eval candidates are additive.

## Examples

See [examples/](examples/) for generated artifacts produced by running the CLI with no hand-editing. The checked-in examples are versioned snapshots regenerated for v0.9.1; footers and any schema fields introduced since the previous version reflect the current release.

- [examples/weather-dashboard](examples/weather-dashboard) shows lineage and the redaction gate on a clean session.
- [examples/api-key-auth](examples/api-key-auth) shows the [`--security` report](examples/api-key-auth/SECURITY_REPORT.md), [rejection capture](examples/api-key-auth/.treetrace/rejections.json), and [hallucination detection](examples/api-key-auth/.treetrace/hallucinations.json) lighting up on a session that touches auth, hardcodes a secret, skips tests, force-pushes, references a missing file, and imports an undeclared package.
- [examples/rejections](examples/rejections) shows typed decline, interrupt, tool-error, permission-denial, and model-refusal capture.

## License

[Apache License 2.0](LICENSE). Copyright 2026 Zion Boggan.

TreeTrace is **free and open source** for any use, including commercial. Use it, modify it, ship it inside your own products, run it at work. The Apache 2.0 license includes an explicit patent grant.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for the full terms.

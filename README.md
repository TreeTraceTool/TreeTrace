# TreeTrace

**Turn AI coding sessions into regression-ready prompt lineage.**

TreeTrace reads local AI coding transcripts and extracts the path of human steering: the root goal, direction changes, corrections, abandoned branches, accepted decisions, and the final shipped path.

It then exports:

- `TREETRACE_REPORT.md` as the combined human-readable report
- `PROMPT_TREE.md` for humans
- `.treetrace/tree.json` for tools
- `.treetrace/failures.json` for agent mistake analysis
- `.treetrace/lessons.md` for reusable correction memory
- `.treetrace/evals.jsonl` for regression and eval harnesses
- `.treetrace/agent-memory.md` for future coding agents
- `treetrace --handoff` for the next agent

```bash
cd your-project
npx treetrace
```

No accounts. No uploads. No telemetry. Your transcripts never leave your machine.

## Requirements

Node.js 18 or newer. TreeTrace ships with no runtime dependencies, so `npx treetrace` needs nothing else installed.

## Why

Git history shows what changed. TreeTrace shows how the human had to steer the agent to get there.

AI coding sessions contain the most useful regression data teams have: where the model misunderstood the goal, which correction fixed it, which branch was abandoned, what constraint kept getting ignored, and what should become an eval so the next agent does not repeat the failure.

TreeTrace is the local-first layer between raw chat logs, runtime traces, and code provenance.

## What It Does

1. **Discovers local transcripts.** Claude Code session files are found automatically from `~/.claude/projects/...`; plain transcripts can be imported with `--file` or `--stdin`.
2. **Extracts prompt lineage.** Tool noise, slash-command wrappers, sidechain chatter, duplicate resends, and "continue" nudges are filtered or folded.
3. **Builds a fork-aware tree.** Corrections, scope changes, checkpoints, questions, abandoned branches, and accepted paths are derived from prompt topology and user text.
4. **Analyzes failures and corrections.** TreeTrace adds failure signals, correction chains, lessons, and eval candidates using transparent heuristics.
5. **Exports regression artifacts.** JSON, Markdown, JSONL, and handoff memory are written locally for agents, CI, eval harnesses, and humans.
6. **Gates every export with redaction.** Detected secrets must be resolved before anything is written; non-interactive runs redact automatically and shadow-scan rendered output.

## Outputs

| Artifact | Purpose |
|----------|---------|
| `TREETRACE_REPORT.md` | Combined human-readable report for review, terminals, and chat handoff |
| `PROMPT_TREE.md` | Human-readable narrative of the build path |
| `.treetrace/tree.json` | Canonical machine-readable lineage schema |
| `.treetrace/failures.json` | Failure signals, correction chains, and summaries |
| `.treetrace/lessons.md` | Human-readable lessons for future work |
| `.treetrace/evals.jsonl` | Generic model-agnostic eval cases |
| `.treetrace/agent-memory.md` | Compact memory pack for Codex, Claude Code, Cursor, or another agent |
| `treetrace --handoff` | Agent-ready continuation brief printed to stdout |

## Usage

| Command | What it does |
|---------|--------------|
| `npx treetrace` | Trace this project and write all artifacts |
| `npx treetrace --report` | Write all artifacts and print the human report |
| `npx treetrace --handoff` | Print an agent ready continuation brief |
| `npx treetrace --file session.jsonl` | Import specific transcripts |
| `npx treetrace --stdin < chat.txt` | Parse a pasted `User:` / `Assistant:` transcript |
| `npx treetrace --failures` | Write and print `.treetrace/failures.json` |
| `npx treetrace --lessons` | Write and print `.treetrace/lessons.md` |
| `npx treetrace --evals` | Write and print `.treetrace/evals.jsonl` |
| `npx treetrace --memory` | Write and print `.treetrace/agent-memory.md` |
| `npx treetrace --titles-only` | Compact human tree, no full prompt details |
| `npx treetrace --redact-auto` | Redact every detected secret without prompting |
| `npx treetrace --since 2026-06-01` | Limit to sessions on or after a date |

For a Termius, Codex CLI, Claude Code, or SSH session where you want the report in the terminal window, use:

```bash
npx treetrace --report --redact-auto
```

For both terminal output and an extra shell-captured copy:

```bash
npx treetrace --report --redact-auto | tee treetrace-output.md
```

If you see a file literally named `output`, that usually came from `--out output` or shell redirection like `> output`. Prefer `TREETRACE_REPORT.md` for human reading and leave `.treetrace/*.json` / `.jsonl` for tools.

## Failure Analysis

TreeTrace does not claim to perfectly understand every session. The first analysis pass is heuristic and explainable: every failure signal includes a type, confidence score, evidence text, and source node IDs.

Initial failure types include:

- `ignored_constraint`
- `misunderstood_goal`
- `scope_drift`
- `wrong_tool_choice`
- `hallucinated_file_or_api`
- `repeated_failed_fix`
- `overbuilt_solution`
- `underbuilt_solution`
- `security_or_privacy_risk`
- `dependency_or_environment_mismatch`
- `format_violation`
- `user_frustration`
- `abandoned_path`

The goal is not judgment. The goal is regression memory: identify what future agents should preserve, avoid, or test.

## Eval Export

`.treetrace/evals.jsonl` turns real session corrections into generic eval cases:

```json
{"id":"eval_001","source":"treetrace","type":"scope_drift_detection","task":"Continue development without drifting outside the corrected scope.","expected_behavior":["Stay inside the corrected scope","Do not add unrequested product surfaces"],"sourceNodeIds":["node_002","node_003"]}
```

The format is intentionally model-agnostic. Adapters for promptfoo, OpenAI Evals-style harnesses, LangSmith-style datasets, and other eval systems can build from this JSONL without changing TreeTrace's local-first core.

## Redaction Gate

A privacy-positioned tool gets exactly one chance with your secrets, so every export goes through the same gate:

- Curated provider rules for AWS, GitHub, GitLab, Anthropic, OpenAI, Slack, Stripe, npm, Tailscale, Google, SendGrid, Twilio, Telegram, Discord webhooks, JWTs, private key blocks, WireGuard keys, basic-auth URLs, bearer tokens, and secret assignments.
- High-entropy fallback for unknown token shapes.
- Detection for common line-wrapped provider tokens.
- Interactive review of every unique hit in a TTY.
- Automatic redaction outside a TTY.
- Shadow scan of the rendered artifact before write.
- `.treetrace/redactions.json` stores only content hashes and actions, never raw secrets.

## Sources

| Source | Status |
|--------|--------|
| Claude Code (`~/.claude/projects` JSONL) | Built-in, zero-config |
| Pasted / plain-text transcripts (`User:` / `Assistant:` markers) | Built-in |
| Codex CLI, Cursor, SpecStory, ChatGPT export | Importers welcome |

## Schema

`.treetrace/tree.json` uses the open TreeTrace v0.2 schema documented in [SCHEMA.md](SCHEMA.md). It is designed to compose with Agent Trace: Agent Trace can describe which lines were AI-generated, while TreeTrace describes the human instruction lineage that shaped the build.

Consumers should ignore unknown fields. Failure signals, correction chains, lessons, and eval candidates are additive.

## Product Boundaries

TreeTrace is not a hosted SaaS, telemetry product, generic LangSmith clone, prompt-sharing network, or graph visualizer first.

The strongest identity is:

> local, private, structured, eval-ready, agent-aware.

## License

GNU Affero General Public License v3.0 only (AGPL-3.0-only).

Copyright 2026 Zion Boggan.

You may use, study, share, and modify TreeTrace under the terms of the AGPL version 3. If you run a modified version as a network service, you must offer its users the corresponding source. See [LICENSE](LICENSE).

---

See [examples/](examples/) for a full set of generated artifacts. The Markdown tree is one artifact among several: the main product is structured, local, eval-ready knowledge about how agents fail and how humans correct them.

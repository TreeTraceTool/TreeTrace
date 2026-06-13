# Changelog

Notable changes to TreeTrace. The format follows Keep a Changelog, and the project uses semantic versioning.

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

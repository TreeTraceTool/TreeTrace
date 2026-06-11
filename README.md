# 🌳 treetrace

**Your repo says what you built. `PROMPT_TREE.md` says how.**

treetrace reads the AI coding sessions already sitting on your disk and turns them into a clean, shareable prompt lineage — the root idea, the directions, the corrections, the dead ends, and the path that shipped.

```bash
cd your-project
npx treetrace
```

Thirty seconds later:

```
🌳 your-project — 41 prompts · 6 sessions · 9 days · 3 ↩ corrections · 1 ✗ abandoned · 1,204 tool calls
  ⬢ Build a tool that turns AI chat logs into a prompt tree
  → Make it agent-agnostic so it works with any transcript
  ↩ No, scrap the web app — make it a zero-config CLI
  ⚑ Add a redaction gate so secrets never reach the export
  ◆ Ship it: README, schema, examples

✓ wrote PROMPT_TREE.md and .treetrace/tree.json
```

No accounts. No uploads. No config. Your transcripts never leave your machine.

## Why

Projects are increasingly built through hundreds of prompts — and that history evaporates into chat logs nobody reopens. The prompt lineage is the **how** of modern software:

- **Show your work.** "Built with AI" invites slop-skepticism; a visible, honest prompt tree is the receipt.
- **Hand off cleanly.** `treetrace --handoff` distills the lineage into a context pack for the next agent (or the next human): goal, accepted decisions, constraints learned the hard way, known dead ends.
- **Teach and compare.** The fastest way to get better at directing agents is reading how others do it.
- **Audit-friendly.** Every node links back to its source event ID in your local transcript.

## What it does

1. **Discovers** Claude Code session files for your project (`~/.claude/projects/...`) — or imports any transcript via `--file` / `--stdin`.
2. **Extracts** the meaningful human prompts; tool noise, slash commands, "continue" nudges, and subagent chatter are filtered or folded.
3. **Classifies** each prompt: `⬢` root · `→` direction · `↩` correction · `⚑` scope change · `◆` checkpoint — and detects genuinely abandoned branches (`✗`) from real rewind topology, not guesswork.
4. **Gates** every export behind a secret scan. Nothing is written until each hit is resolved (`redact` / `keep` / `edit`). Outside a TTY, every hit is auto-redacted — treetrace **fails closed**.
5. **Exports** `PROMPT_TREE.md` (for humans, GitHub-ready), `.treetrace/tree.json` (open schema, [SCHEMA.md](SCHEMA.md)), and `--handoff` briefs (for agents).

## The redaction gate

A privacy-positioned tool gets exactly one chance with your secrets, so this is the most engineered part of treetrace:

- Curated provider rules (AWS, GitHub, GitLab, Anthropic, OpenAI, Slack, Stripe, npm, Tailscale, Google, SendGrid, Twilio, Telegram, Discord webhooks, JWTs, private key blocks, WireGuard, basic-auth URLs, bearer tokens, secret assignments) plus a high-entropy fallback.
- Interactive review of every unique hit before anything is written.
- A **shadow scan** re-checks the final rendered artifact; an unresolved hit aborts the write.
- Your decisions persist in `.treetrace/redactions.json` as salted-free **hashes only** — the file never contains a secret and re-runs never re-ask.

## Usage

```bash
npx treetrace                  # trace this project
npx treetrace --handoff        # agent-ready brief to stdout (pipe into your next agent)
npx treetrace --handoff | claude -p "Read this handoff brief and continue the project"
npx treetrace --file session.jsonl     # specific transcript(s)
npx treetrace --stdin < chat-export.txt # pasted transcript (User:/Assistant: markers)
npx treetrace --titles-only    # compact tree, no full prompt texts
npx treetrace --redact-auto    # redact every hit without prompting
npx treetrace --since 2026-06-01
```

## Sources

| Source | Status |
|--------|--------|
| Claude Code (`~/.claude/projects` JSONL) | ✅ built-in, zero-config |
| Pasted / plain-text transcripts (`User:` / `Assistant:` markers) | ✅ built-in |
| Codex CLI, Cursor, SpecStory, ChatGPT export | 🚧 importers welcome — [open an issue](https://github.com/zionsworking/treetrace/issues) |

## The format

`PROMPT_TREE.md` is a convention, not a lock-in: commit it at your repo root the way you commit `AGENTS.md`. The machine-readable lineage (`.treetrace/tree.json`) uses an open nodes/edges schema documented in [SCHEMA.md](SCHEMA.md), designed to compose with the [Agent Trace](https://agent-trace.dev/) RFC — Agent Trace records that code was AI-attributed; treetrace records the conversation structure that shaped it.

## Privacy promises

- Local-first: no network calls, no telemetry, no accounts. Ever.
- Raw transcripts are read, never copied, never exported.
- Prompt-only by default: assistant output stays out of your exports.
- Fails closed: un-reviewed secrets cannot reach a written artifact.

## License

MIT © Zion Boggan

---

*This repository ships its own [PROMPT_TREE.md](PROMPT_TREE.md) — the prompt tree of the tool that makes prompt trees.*

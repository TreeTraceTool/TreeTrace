# Contributing to TreeTrace

Thanks for looking. TreeTrace is a small, local-first CLI with no runtime dependencies, and the goal is to keep it that way: readable in one sitting, easy to audit, safe to trust with a session transcript.

## Ground rules

- No runtime dependencies. The tool must keep working with a bare `npx treetrace` and nothing else installed. Dev-only tooling is fine. Anything that would ship in `files` is not.
- Local-first. No network calls, no telemetry, no uploads. A user's transcripts never leave their machine.
- The redaction gate fails closed. If you touch redaction, add a fixture that proves a secret shape is caught, and never loosen a rule without a test that shows why it is safe.
- Ship clean code. No commented-out blocks, no inline narration. If a line needs a comment to be understood, the code usually wants rewriting first.

## Getting set up

```bash
git clone https://github.com/TreeTraceTool/TreeTrace.git
cd treetrace
npm test
```

There is no build step. Source is plain ES modules under `src/`, the entry point is `bin/treetrace.js`, and tests use the Node built-in test runner.

Run the CLI against a session while you work:

```bash
node bin/treetrace.js --file path/to/session.jsonl --dir /tmp/tt-out --redact-auto
```

## Pull requests

- Keep each pull request focused on one change.
- Add or update a test for any behavior change. The suite is the spec.
- Run `npm test` and confirm it is green before opening the request.
- Describe what changed and why in plain language.

## Adding a source adapter

New tools live in `src/adapters/`. An adapter turns a tool's export into the shared session shape and emits per-turn actions where it can. Add a fixture under `test/fixtures/adapters/` and record where it came from in that folder's `PROVENANCE.md`. Keep the adapter marked experimental until it has been validated against a real captured session, not just a schema-shaped fixture.

## Reporting bugs and ideas

Open an issue with the template that fits. For anything security-related, use the private channel in [SECURITY.md](SECURITY.md) instead of a public issue.

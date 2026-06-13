# Examples

Generated TreeTrace outputs from two synthetic sessions. Both are produced by running the CLI exactly as a user would; nothing here is hand-edited.

## weather-dashboard

A short, well-behaved session that builds a static weather page, with one correction and one scope change. It shows the lineage and the redaction gate: a secret pasted into a prompt is redacted before anything is written.

- [weather-dashboard/PROMPT_TREE.md](weather-dashboard/PROMPT_TREE.md): human-readable prompt lineage
- [weather-dashboard/TREETRACE_REPORT.md](weather-dashboard/TREETRACE_REPORT.md): combined human-readable report
- [weather-dashboard/.treetrace/tree.json](weather-dashboard/.treetrace/tree.json): canonical v0.2 machine-readable lineage
- [weather-dashboard/.treetrace/failures.json](weather-dashboard/.treetrace/failures.json): failure signals and correction chains
- [weather-dashboard/.treetrace/hallucinations.json](weather-dashboard/.treetrace/hallucinations.json): deterministic file, path, import, and package existence check
- [weather-dashboard/.treetrace/lessons.md](weather-dashboard/.treetrace/lessons.md): lessons for future agents
- [weather-dashboard/.treetrace/evals.jsonl](weather-dashboard/.treetrace/evals.jsonl): eval candidates
- [weather-dashboard/.treetrace/agent-memory.md](weather-dashboard/.treetrace/agent-memory.md): compact memory pack

Reproduce:

```bash
node bin/treetrace.js --file test/fixtures/synthetic-session.jsonl --dir examples/weather-dashboard --redact-auto --quiet
```

## api-key-auth

A session that adds API key auth to an Express route and goes wrong in several security-relevant ways: it touches an auth file and the dependency manifest, hardcodes a secret (which the human corrects to an env var), skips the failing auth tests, force-pushes with `--no-verify`, references a file that does not exist, and imports a package that is not declared. This is what the `--security` report and the hallucination detector are for.

- [api-key-auth/SECURITY_REPORT.md](api-key-auth/SECURITY_REPORT.md): the `--security` report, answering the five security questions for this session
- [api-key-auth/PROMPT_TREE.md](api-key-auth/PROMPT_TREE.md): prompt lineage
- [api-key-auth/TREETRACE_REPORT.md](api-key-auth/TREETRACE_REPORT.md): combined report
- [api-key-auth/.treetrace/hallucinations.json](api-key-auth/.treetrace/hallucinations.json): the missing file and the undeclared import, each with an eval candidate
- [api-key-auth/.treetrace/failures.json](api-key-auth/.treetrace/failures.json), [lessons.md](api-key-auth/.treetrace/lessons.md), [evals.jsonl](api-key-auth/.treetrace/evals.jsonl), [agent-memory.md](api-key-auth/.treetrace/agent-memory.md)

The `package.json`, `server.js`, and `src/auth/apiKey.js` in that folder are the working tree the detector verifies references against. The referenced `src/middleware/rateLimit.js` is absent and `jsonwebtoken` is undeclared, so both are flagged; `express` and the files that exist are not.

Reproduce (the working tree is committed alongside the outputs):

```bash
node bin/treetrace.js --from claude --file <your-session>.jsonl --dir examples/api-key-auth --security --redact-auto --quiet
```

The Markdown tree is one artifact among several. The structured outputs are the main product: lineage JSON, failure analysis, hallucination checks, eval candidates, and agent memory.

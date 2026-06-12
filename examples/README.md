# Examples

Generated TreeTrace outputs from the synthetic weather-dashboard fixture.

## Weather Dashboard

- [weather-dashboard/PROMPT_TREE.md](weather-dashboard/PROMPT_TREE.md) - human-readable lineage
- [weather-dashboard/TREETRACE_REPORT.md](weather-dashboard/TREETRACE_REPORT.md) - combined human-readable report
- [weather-dashboard/tree.json](weather-dashboard/tree.json) - canonical v0.2 machine-readable lineage
- [weather-dashboard/.treetrace/failures.json](weather-dashboard/.treetrace/failures.json) - failure signals and correction chains
- [weather-dashboard/.treetrace/lessons.md](weather-dashboard/.treetrace/lessons.md) - lessons for future agents
- [weather-dashboard/.treetrace/evals.jsonl](weather-dashboard/.treetrace/evals.jsonl) - eval candidates
- [weather-dashboard/.treetrace/agent-memory.md](weather-dashboard/.treetrace/agent-memory.md) - compact memory pack

The root-level example files mirror the same analysis artifacts for quick inspection:

- [failures.json](failures.json)
- [lessons.md](lessons.md)
- [evals.jsonl](evals.jsonl)
- [agent-memory.md](agent-memory.md)

Generated with:

```bash
node bin/treetrace.js --file test/fixtures/synthetic-session.jsonl --dir examples/weather-dashboard --redact-auto --quiet
```

## Dogfooding

TreeTrace ships its own [PROMPT_TREE.md](../PROMPT_TREE.md), but the pivot makes that Markdown tree one artifact among several. The structured outputs are the main product: lineage JSON, failure analysis, eval candidates, and agent memory.

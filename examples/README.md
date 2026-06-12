# Examples

Real `treetrace` output, so you can see the artifact before you run it.

## [weather-dashboard/](weather-dashboard/)

A short session that exercises every feature: a **root** goal, a **direction**, a **correction** ("scrap the radar map"), and a **scope change** ("also add a settings panel") — plus the redaction gate masking a planted Anthropic key and a basic-auth URL, and a **reusable prompt pack** that folds the correction in as a learned constraint.

Generated with:

```bash
treetrace --file session.jsonl --redact-auto
```

## Dogfooding

treetrace ships its own [`PROMPT_TREE.md`](../PROMPT_TREE.md) at the repo root — the prompt tree of the tool that makes prompt trees, regenerated from its own build sessions. That's the standing invitation: if you build something with an agent, commit the tree next to the code.

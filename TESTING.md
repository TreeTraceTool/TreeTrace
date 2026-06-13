# Testing

TreeTrace ships with a zero-dependency test suite and is put through an adversarial end-to-end pass before each release. This page documents what is actually tested, on what data, and what is not, so you can judge the coverage yourself rather than take a claim on faith.

## Run the suite

```
node --test test/treetrace.test.js test/adapters.test.js
```

No dependencies and no network. The suite covers parsing, prompt classification, tree building, the redaction gate, the analysis layer, and every import adapter, including regression tests for each issue listed in the changelog.

## The three invariants

Every release is checked against three properties:

1. Ingestion fidelity. Each tool's real export parses correctly, and format auto-detection selects the right tool and not the others.
2. Safety. No secret from any source reaches any written artifact. The redaction gate fails closed: outside an interactive terminal every detected secret is redacted automatically, and a shadow scan refuses to write a file if anything unresolved remains.
3. Analysis honesty. Failure signals, lessons, evals, and security flags must correspond to real events in the session. The tool never invents a failure, and it never asks a model to judge your code. Every signal is a transparent heuristic with evidence and node ids you can check.

## Adversarial pre-release pass

Before a release, TreeTrace is run end to end against a corpus of real sessions, not synthetic fixtures, and probed by a set of adversarial checks:

- A secret-leak self-test injects many credential formats (provider keys, tokens, private keys, basic-auth URLs, and bare high-entropy and hexadecimal strings) into every field of every adapter format, runs the tool, then greps every written artifact. The requirement is zero leaks across every adapter.
- An auto-detection matrix confirms each real export is recognized as exactly one tool, with no false positives against the other adapters.
- Fuzz and robustness checks feed truncated, malformed, empty, oversized, and unicode inputs. The tool must fail with a clear message and a non-zero exit, never a stack trace or a partial artifact.
- Determinism and memory checks confirm repeat runs are identical except for the timestamp, and that a large real session stays within a sane time and memory budget.
- A ground-truth analysis audit checks the security and failure signals against what actually happened in a known session, looking for both invented signals and missed ones.

## Corpus honesty

What "tested on real data" means for each adapter:

| Source | Tested on |
| --- | --- |
| Claude Code | Live captured sessions |
| Codex CLI | Live captured rollout |
| ChatGPT export | Real published account export |
| Gemini CLI | Real published session |
| Copilot Chat | Real published session |
| Cursor | Documented export schema only |
| Grok | Documented export schema only |

Cursor and Grok keep history in a SQLite database rather than a JSON file on disk, so their adapters are validated against the documented export schema, not a captured live session. We say so plainly here and in the adapter notes until that changes.

## Found and fixed

The most recent pre-release pass caught a redaction gap: a bare hexadecimal string of 32 characters or more, a common shape for framework secret keys and signing keys, was not detected and could reach an artifact even with automatic redaction. It is fixed, covered by a regression test, and the leak self-test now passes for every format across every adapter. See [CHANGELOG.md](CHANGELOG.md) for the full list from that pass.

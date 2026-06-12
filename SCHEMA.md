# TreeTrace lineage schema v0.2

`.treetrace/tree.json` is an open, vendor-neutral format for prompt lineage and agent-regression analysis in AI-assisted projects.

TreeTrace records the human steering layer: what was asked, what changed direction, what was corrected, what was abandoned, what future agents should remember, and which failures should become evals.

## Layering

| Layer | Standard or artifact | What it records |
|-------|----------------------|-----------------|
| Code attribution | Agent Trace | which lines were AI-generated, by which model, linked to which conversation |
| Runtime telemetry | OpenTelemetry `gen_ai` | per-call spans for operators |
| Build integrity | SLSA / in-toto | signed provenance of build artifacts |
| Human steering | TreeTrace | prompt lineage, corrections, abandoned paths, lessons, eval candidates |

Agent Trace answers "which code came from AI?" TreeTrace answers "how did the human have to steer the agent?"

## Top-Level Shape

```jsonc
{
  "schemaVersion": "0.2",
  "generator": { "name": "treetrace", "version": "0.2.0", "url": "..." },
  "project": { "name": "...", "generatedAt": "ISO-8601", "sourceType": "claude-code-jsonl" },
  "stats": { "prompts": 41, "sessions": 6, "days": 9, "corrections": 3 },
  "analysis": {
    "failureSignals": 7,
    "correctionChains": 3,
    "evalCandidates": 4,
    "lessons": 4
  },
  "sessions": [ { "id": "...", "title": "...", "firstTs": "...", "lastTs": "...", "promptCount": 7 } ],
  "nodes": [ /* PromptNode */ ],
  "edges": [ /* Edge */ ],
  "correctionChains": [ /* CorrectionChain */ ],
  "lessons": [ /* Lesson */ ],
  "evalCandidates": [ /* EvalCandidate */ ]
}
```

All v0.2 additions are optional and additive. Consumers that only understand v0.1 can keep reading `nodes` and `edges`.

## PromptNode

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | stable within the file (`node_001`, etc.) |
| `parentId` | string \| null | lineage parent (null = root) |
| `role` | `"user"` | reserved for future system/developer nodes |
| `kind` | enum | `root`, `direction`, `correction`, `scope-change`, `checkpoint`, `question` |
| `title` | string | first-sentence distillation |
| `text` | string | full prompt text after redaction |
| `status` | enum | `accepted`, `abandoned` |
| `nudges` | number | folded "continue"-style acknowledgements |
| `reruns` | number | repeated instruction re-issues folded into this node |
| `session` | string | session id this prompt came from |
| `timestamp` | string \| null | ISO-8601 |
| `failureSignals` | FailureSignal[] | optional v0.2 failure labels attached to this node |
| `evalCandidate` | boolean | whether this node contributes to an eval candidate |
| `lessonIds` | string[] | lessons derived from this node |
| `sourceEventIds` | string[] | local transcript record UUIDs; raw transcripts are never exported |

## FailureSignal

```jsonc
{
  "type": "ignored_constraint",
  "confidence": 0.82,
  "evidence": "User corrected the agent after it built a web app despite asking for a CLI.",
  "resolvedBy": "node_004"
}
```

Initial `type` values:

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

The enum may gain values. Consumers should treat unknown values as advisory labels.

## Edge

```jsonc
{ "from": "node_001", "to": "node_002", "relationship": "refines" }
```

`relationship` is derived from the child node's `kind`:

- `refines`
- `corrects`
- `expands`
- `checkpoints`
- `asks`

## CorrectionChain

```jsonc
{
  "id": "chain_001",
  "failureNodeId": "node_003",
  "correctionNodeId": "node_004",
  "resolvedNodeId": "node_006",
  "failureType": "ignored_constraint",
  "confidence": "high",
  "summary": "The agent initially pursued a web app; the user corrected it toward a zero-config CLI."
}
```

A correction chain links a likely failure node to the user correction that changed direction. It does not require assistant output; it is derived from prompt topology and user text. Low-confidence chains may be omitted.

## Lesson

```jsonc
{
  "id": "lesson_001",
  "title": "Preserve explicit constraints",
  "nodeIds": ["node_003", "node_004"],
  "text": "Future agents should carry explicit user constraints forward as high-priority requirements."
}
```

Lessons are compact rules for future agents. They should be specific enough to use in handoffs or memory packs.

## EvalCandidate

```jsonc
{
  "id": "eval_001",
  "source": "treetrace",
  "type": "instruction_following_regression",
  "task": "Continue development while preserving the corrected direction from the session lineage.",
  "context": "The user rejected a web app and corrected the project toward a zero-config CLI.",
  "input": "Continue development of the project while preserving the corrected direction and constraints.",
  "expected_behavior": [
    "Use the corrected prompt lineage as durable context",
    "Do not repeat the documented failure mode"
  ],
  "failure_mode": "Agent repeats ignored constraint despite prior correction.",
  "sourceNodeIds": ["node_003", "node_004"]
}
```

Initial eval `type` values:

- `instruction_following_regression`
- `constraint_preservation`
- `scope_drift_detection`
- `correction_adherence`
- `privacy_boundary_preservation`
- `handoff_quality`
- `tool_choice_regression`

## Separate Analysis Artifacts

TreeTrace also writes a combined human report plus focused files derived from the same redacted tree:

- `TREETRACE_REPORT.md`
- `.treetrace/failures.json`
- `.treetrace/lessons.md`
- `.treetrace/evals.jsonl`
- `.treetrace/agent-memory.md`

These files must not contain raw assistant logs or unredacted secrets.

## Composing With Agent Trace

An Agent Trace record can point to a TreeTrace session and node range:

- Agent Trace `conversation` -> TreeTrace `sessions[].id`
- Agent Trace line-range records -> work performed between two TreeTrace node IDs
- TreeTrace correction chains -> regression tests or code-review context for the next agent

This keeps responsibilities clean: Agent Trace handles code attribution; TreeTrace handles human steering and correction memory.

## Mapping to W3C PROV

For provenance tooling:

- each `PromptNode` is a `prov:Activity`
- the human is a `prov:Agent`
- edges are `prov:wasInformedBy`
- exported artifacts are `prov:Entity`
- correction chains can be modeled as qualified derivations from a failure activity to a corrected activity

## Stability

- `schemaVersion` follows semver-minor for additive changes.
- Consumers MUST ignore unknown fields.
- Enum values may gain members.
- New top-level arrays may be absent, empty, or partially populated.

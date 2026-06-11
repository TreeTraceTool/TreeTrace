# treetrace lineage schema v0.1

`.treetrace/tree.json` is an open, vendor-neutral format for the **prompt lineage** of an AI-assisted project: the tree of human instructions — branches, corrections, scope changes, dead ends, and the accepted path — that produced a result.

It deliberately occupies the layer existing standards leave open:

| Layer | Standard | What it records |
|-------|----------|-----------------|
| Code attribution | [Agent Trace](https://agent-trace.dev/) | which lines were AI-generated, by which model, linked to which conversation |
| Runtime telemetry | OpenTelemetry `gen_ai` | per-call spans for operators, ephemeral |
| Build integrity | SLSA / in-toto | signed provenance of artifacts |
| **Conversation structure** | **treetrace (this document)** | **the human prompt lineage: what was asked, in what order, what was corrected, what was abandoned** |

## Top-level shape

```jsonc
{
  "schemaVersion": "0.1",
  "generator": { "name": "treetrace", "version": "0.1.0", "url": "..." },
  "project": { "name": "...", "generatedAt": "ISO-8601", "sourceType": "claude-code-jsonl" },
  "stats": { "prompts": 41, "sessions": 6, "days": 9, "corrections": 3, "...": "..." },
  "sessions": [ { "id": "...", "title": "...", "firstTs": "...", "lastTs": "...", "promptCount": 7, "isContinuation": false } ],
  "nodes": [ /* PromptNode */ ],
  "edges": [ /* Edge */ ]
}
```

## PromptNode

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | stable within the file (`node_001`…) |
| `parentId` | string \| null | lineage parent (null = root) |
| `role` | `"user"` | reserved for future system/developer nodes |
| `kind` | enum | `root` · `direction` · `correction` · `scope-change` · `checkpoint` · `question` |
| `title` | string | first-sentence distillation |
| `text` | string | full prompt text **after** redaction |
| `status` | enum | `accepted` · `abandoned` (off the accepted path via real rewind topology) |
| `nudges` | number | folded "continue"-style acknowledgements |
| `session` | string | session id this prompt came from |
| `timestamp` | string \| null | ISO-8601 |
| `sourceEventIds` | string[] | record UUIDs inside the **local** source transcript (audit link; transcripts themselves are never exported) |

## Edge

```jsonc
{ "from": "node_001", "to": "node_002", "relationship": "refines" }
```

`relationship` is derived from the child's `kind`: `refines` (direction), `corrects` (correction), `expands` (scope-change), `checkpoints` (checkpoint), `asks` (question).

## Composing with Agent Trace

An Agent Trace record attributes file/line ranges to a conversation URL or ID. A treetrace export can be referenced as that conversation's **structural summary**:

- Agent Trace `conversation` → treetrace `sessions[].id`
- Agent Trace line-range records → the work performed *between* two treetrace nodes (bounded by `sourceEventIds`)

This keeps responsibilities clean: Agent Trace answers *"which code came from AI?"*; treetrace answers *"what was the human actually steering?"*. Emitting both gives line-level attribution **and** human-readable narrative.

## Mapping to W3C PROV

For provenance tooling: each `PromptNode` is a `prov:Activity` (instruction issuance) by a `prov:Agent` (the human); edges are `prov:wasInformedBy`; exported artifacts are `prov:Entity` with `prov:wasGeneratedBy` the final checkpoint node.

## Stability

- `schemaVersion` follows semver-minor for additive changes.
- Consumers MUST ignore unknown fields.
- `kind`/`status`/`relationship` enums may gain values; treat unknown values as `direction`/`accepted`/`refines`.

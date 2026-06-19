# TreeTrace lineage schema v0.3

`.treetrace/tree.json` is an open, vendor-neutral format for prompt lineage and agent-regression analysis in AI-assisted projects.

TreeTrace records the human steering layer: what was asked, what changed direction, what was corrected, what was abandoned, what was rejected, what future agents should remember, and which failures should become evals.

## Layering

| Layer | Standard or artifact | What it records |
|-------|----------------------|-----------------|
| Code attribution | Agent Trace | which lines were AI-generated, by which model, linked to which conversation |
| Runtime telemetry | OpenTelemetry `gen_ai` | per-call spans for operators |
| Build integrity | SLSA / in-toto | signed provenance of build artifacts |
| Human steering | TreeTrace | prompt lineage, corrections, abandoned paths, rejections, lessons, eval candidates |

Agent Trace answers "which code came from AI?" TreeTrace answers "how did the human have to steer the agent?"

## Top-Level Shape

```jsonc
{
  "schemaVersion": "0.3",
  "generator": { "name": "treetrace", "version": "0.9.0", "url": "..." },
  "project": { "name": "...", "generatedAt": "ISO-8601", "sourceType": "claude-code-jsonl" },
  "stats": {
    "prompts": 41, "sessions": 6, "days": 9,
    "corrections": 3, "rejections": 4,
    "toolUses": 12, "filesTouched": 7,
    "inputTokens": 8400, "outputTokens": 2100,
    "models": ["claude-opus-4-8"],
    "firstTs": "ISO-8601", "lastTs": "ISO-8601"
  },
  "analysis": {
    "failureSignals": 11,
    "correctionChains": 3,
    "evalCandidates": 6,
    "lessons": 7
  },
  "sessions": [
    {
      "id": "...", "title": "...",
      "firstTs": "ISO-8601", "lastTs": "ISO-8601",
      "promptCount": 7, "isContinuation": false,
      "inputTokens": 8400, "outputTokens": 2100
    }
  ],
  "nodes": [ /* PromptNode */ ],
  "edges": [ /* Edge */ ],
  "correctionChains": [ /* CorrectionChain */ ],
  "lessons": [ /* Lesson */ ],
  "evalCandidates": [ /* EvalCandidate */ ]
}
```

All v0.3 additions are optional and additive. Consumers that only understand v0.2 can keep reading `nodes` and `edges` and ignore `rejections`.

## stats fields

| Field | Type | Meaning |
|-------|------|---------|
| `prompts` | number | total classified prompt nodes |
| `rawPrompts` | number | total raw prompt records across all sessions |
| `sessions` | number | sessions that contained at least one prompt |
| `days` | number | calendar days spanned |
| `corrections` | number | nodes classified as `correction` |
| `scopeChanges` | number | nodes classified as `scope-change` |
| `checkpoints` | number | nodes classified as `checkpoint` |
| `abandonedBranches` | number | distinct abandoned sub-trees |
| `rejections` | number | total rejection/refusal/decline events |
| `rejectionsByKind` | object | count per rejection kind |
| `toolUses` | number | total tool invocations across all sessions |
| `filesTouched` | number | distinct file paths referenced (Edit/Write paths and shell command paths) |
| `inputTokens` | number | sum of input tokens across all sessions (0 when not available for the source format) |
| `outputTokens` | number | sum of output tokens across all sessions (0 when not available for the source format) |
| `models` | string[] | deduplicated list of model identifiers seen across all sessions |
| `firstTs` | string \| null | ISO-8601 timestamp of the earliest record |
| `lastTs` | string \| null | ISO-8601 timestamp of the latest record |

Token coverage by source: Claude Code JSONL (full), Codex rollout (full), Gemini CLI (full), ChatGPT export (none), Copilot (none), Cursor (none), Grok (none), plain transcript (none).

## sessions[] fields

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | session identifier |
| `title` | string \| null | session title if captured |
| `firstTs` | string \| null | ISO-8601 |
| `lastTs` | string \| null | ISO-8601 |
| `promptCount` | number | classified prompts in this session |
| `isContinuation` | boolean | session resumed from a prior compact summary |
| `inputTokens` | number | input tokens for this session (0 when not available) |
| `outputTokens` | number | output tokens for this session (0 when not available) |

## PromptNode

| Field | Type | Meaning |
|-------|------|---------|
| `id` | string | stable within the file (`node_001`, etc.) |
| `parentId` | string \| null | lineage parent (null = root) |
| `role` | `"user"` | reserved for future system/developer nodes |
| `kind` | enum | `root`, `direction`, `correction`, `scope-change`, `checkpoint`, `question`, `rejection` |
| `title` | string | first-sentence distillation |
| `text` | string | full prompt text after redaction |
| `status` | enum | `accepted`, `abandoned` |
| `nudges` | number | folded "continue"-style acknowledgements |
| `reruns` | number | repeated instruction re-issues folded into this node |
| `session` | string | session id this prompt came from |
| `timestamp` | string \| null | ISO-8601 |
| `model` | string \| null | model that handled this turn (from the first action on the turn; null if not available) |
| `actions` | Action[] | tool invocations made in response to this prompt, after redaction |
| `failureSignals` | FailureSignal[] | optional v0.2 failure labels attached to this node |
| `evalCandidate` | boolean | whether this node contributes to an eval candidate |
| `lessonIds` | string[] | lessons derived from this node |
| `rejections` | Rejection[] | optional v0.3 typed rejection/refusal/decline events captured on this turn |
| `sourceEventIds` | string[] | local transcript record UUIDs; raw transcripts are never exported |

## Action

```jsonc
{ "tool": "Edit", "file": "/src/auth.js", "command": null, "model": "claude-opus-4-8" }
```

| Field | Type | Meaning |
|-------|------|---------|
| `tool` | string \| null | tool name (`Bash`, `Edit`, `Write`, `Read`, etc.) |
| `file` | string \| null | file path from a structured `file_path` input; redacted |
| `command` | string \| null | shell command string for `Bash` tool calls; redacted |
| `model` | string \| null | model that issued this tool call; null when not available |

`file` and `command` values are run through the same redaction gate as `node.text`. An `action` whose `command` or `file` contains a secret will have that value replaced with a `[REDACTED:rule-id]` marker before export.

The `rejection` kind (v0.3) is assigned to synthetic nodes that exist only to carry a rejection signal, e.g. a tool-result rejection that arrived before any human-typed prompt. Such nodes have empty `text`, a `title` derived from the rejection kind(s), and one or more entries in `rejections`.

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
- `hallucinated_file_or_path` (also written as `hallucinated_file_or_api` in older exports; treat as equivalent)
- `repeated_failed_fix`
- `overbuilt_solution`
- `underbuilt_solution`
- `security_or_privacy_risk`
- `dependency_or_environment_mismatch`
- `format_violation`
- `user_frustration`
- `abandoned_path`
- `user_rejected_action` (v0.3)
- `tool_execution_failed` (v0.3)
- `model_refused` (v0.3)
- `permission_denied` (v0.3)

The enum may gain values. Consumers should treat unknown values as advisory labels.

## Rejection (v0.3)

```jsonc
{
  "kind": "user_declined_tool",
  "source": "tool_result",
  "confidence": 1.0,
  "toolUseId": "toolu_0123ABC",
  "tool": "Bash",
  "ts": "2026-06-18T12:34:56.789Z",
  "evidence": "The user doesn't want to proceed with this tool use..."
}
```

`kind` enum:

- `user_declined_tool` - human rejected a proposed tool action (Claude Code canonical "user doesn't want to proceed" text)
- `user_interrupt` - human pressed Esc / interrupt mid-response
- `user_text_decline` - human typed an explicit decline (`no, don't`, `stop`, `cancel`)
- `tool_execution_error` - tool ran and returned `is_error: true` for a non-decline reason
- `permission_denied` - environment denied the action (`permission denied`, `EACCES`, `Operation cancelled`)
- `model_refusal` - the model declined the request (`stop_reason: "refusal"` or refusal text)

`source` enum: `tool_result`, `text`, `stop_reason`, `text_heuristic`.

`confidence` follows the same banding as FailureSignal: 0.95+ verified, 0.8+ high, 0.65+ confirmed, else inferred.

`evidence` is truncated and redacted; it carries enough context to disambiguate the rejection class. `null` when only the structured signal (e.g. `stop_reason`) is available.

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
- `rejects` (v0.3, from `kind: "rejection"`)

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
- `tool_permission_regression` (v0.3)
- `tool_error_recovery` (v0.3)
- `refusal_handling` (v0.3)

## hallucinations.json (--security)

Written to `.treetrace/hallucinations.json` when `--security` is passed. Requires a `--dir` that points to a real project tree so file existence and package manifests can be checked.

```jsonc
{
  "schemaVersion": "0.3",
  "project": { "name": "...", "generatedAt": "ISO-8601" },
  "verifiedAgainstWorkingTree": true,
  "manifestSeen": true,
  "summary": {
    "total": 2,
    "byCategory": {
      "hallucinated_file_or_path": 1,
      "hallucinated_import_or_package": 1
    }
  },
  "hallucinations": [
    {
      "category": "hallucinated_file_or_path",
      "reference": "./src/middleware/rateLimit.js",
      "nodeId": "node_001",
      "evidence": "Referenced ... which does not exist in the working tree and was not created during the session.",
      "evalCandidate": {
        "type": "reference_existence_check",
        "task": "Verify a file or path exists in the working tree before editing or relying on it.",
        "target": "./src/middleware/rateLimit.js"
      }
    }
  ],
  "note": "..."
}
```

`category` enum:

- `hallucinated_file_or_path` - a relative file/path token appears in scannable text but does not exist on disk and was not created during the session
- `hallucinated_import_or_package` - a JS or Python import specifier is not a declared dependency and is not a standard-library/builtin module

`verifiedAgainstWorkingTree` is `false` when the project directory could not be resolved. `manifestSeen` is `false` when no `package.json`, lockfile, or `requirements.txt` was found.

Detection covers: user prompt text, tool action inputs, and tool commands. It does not scan assistant prose (assistant turns are not stored in `node.text`) and does not resolve per-symbol exports inside a module.

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

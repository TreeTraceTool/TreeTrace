# TreeTrace Agent Memory

Project: api-key-auth

## Constraints the user enforced

- Do not hardcode the secret in the source
- Keep it simple

## Lessons from this lineage

- Future agents should validate environment assumptions before choosing dependencies or runtime paths. Specifically: User said: "No, do not hardcode the secret in the source. Read the API key from an environment variable instead."
- Future agents should not weaken local-first privacy, redaction, or no-network guarantees without explicit approval. Specifically: Agent action touched risky-command: "git commit -am "wip: api key auth" --no-verify &amp;&amp; git push --force"
- Future agents should treat frustration as a signal to slow down, verify assumptions, and correct course. Specifically: User said: "Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key."

## Known bad paths

- No abandoned paths were detected in this session.

## Security-sensitive actions

Treat these as durable warnings; re-verify before touching the same surfaces:
- (high) Agent action touched risky-command: "git commit -am "wip: api key auth" --no-verify &amp;&amp; git push --force"

## Preferred next work

- Continue the most recent accepted direction: Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key.
- Keep this correction satisfied: No, do not hardcode the secret in the source.

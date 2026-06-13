# TreeTrace Lessons

## 1. Respect the local environment

Future agents should validate environment assumptions before choosing dependencies or runtime paths. Specifically: User said: "No, do not hardcode the secret in the source. Read the API key from an environment variable instead."

Source nodes: node_001

## 2. Treat privacy boundaries as product requirements

Future agents should not weaken local-first privacy, redaction, or no-network guarantees without explicit approval. Specifically: Agent action touched risky-command: "git commit -am "wip: api key auth" --no-verify &amp;&amp; git push --force"

Source nodes: node_003

## 3. Escalate when user frustration appears

Future agents should treat frustration as a signal to slow down, verify assumptions, and correct course. Specifically: User said: "Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key."

Source nodes: node_001

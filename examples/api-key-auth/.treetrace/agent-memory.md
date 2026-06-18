Project: api-key-auth

## Constraints
- Do not hardcode the secret in the source
- Keep it simple

## Lessons
- Confirm proposed actions before executing: user_text_decline (text): "No, do not hardcode the secret in the source. Read the API key from an environment variable instead." [node_002]
- Treat privacy boundaries as product requirements: Human flagged a security concern about a prior action with no security label [signal: human security correction]: "No, do not hardcode the secret in the source. Read the API key from an environment variable instead." [node_001, node_003]
- Respect the local environment: User said: "No, do not hardcode the secret in the source. Read the API key from an environment variable instead." [node_001]
- Escalate when user frustration appears: User said: "Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key." [node_001]

## Security
- (high) [node_003] "git commit -am "
- (stated intent) [node_001] "No, do not hardcode the secret in the source. Read the API key from an environment variable instead."

## Next
- Continue: Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key.
- Constraint: No, do not hardcode the secret in the source.

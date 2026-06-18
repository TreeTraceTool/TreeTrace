# Prompt Tree: api-key-auth

> **4 prompts** · **1 session** · **1 day** · 1 correction · 4 tool calls · 2 files touched

## Goal

> Add API key authentication to the /admin route in our Express app. Keep it simple.

## The Path

`⬢` root · `→` direction · `↩` correction

- `⬢` **Add API key authentication to the /admin route in our Express app.** <sub>(new session, 2026-06-02)</sub>
  <details><summary>full prompt</summary>

  > Add API key authentication to the /admin route in our Express app. Keep it simple.
  </details>
- `↩` No, do not hardcode the secret in the source.
  <details><summary>full prompt</summary>

  > No, do not hardcode the secret in the source. Read the API key from an environment variable instead.
  </details>
- `→` The auth tests are failing.
  <details><summary>full prompt</summary>

  > The auth tests are failing. Just skip the auth tests for now so we can ship.
  </details>
- `→` Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key.

## Reusable Prompt Pack

```text
1. Add API key authentication to the /admin route in our Express app. Keep it simple.
   (constraint learned along the way: No, do not hardcode the secret in the source. Read the API key from an environment variable instead.)
2. The auth tests are failing. Just skip the auth tests for now so we can ship.
3. Here is my test key [REDACTED:anthropic-key], confirm the admin route rejects a bad key.
```

---

*[treetrace](https://github.com/TreeTraceTool/TreeTrace) v0.8.0 · [schema](https://github.com/TreeTraceTool/TreeTrace/blob/main/SCHEMA.md)*

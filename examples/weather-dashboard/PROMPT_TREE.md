# Prompt Tree: weather-dashboard

> **4 prompts** · **1 session** · **1 day** · 1 correction · 1 scope change · 2 tool calls · 1 file touched

## Goal

> Build a weather dashboard web app that shows the forecast for Denver using the NWS API. Keep it a single static page.

## The Path

`⬢` root · `→` direction · `↩` correction · `⚑` scope change

- `⬢` **Build a weather dashboard web app that shows the forecast for Denver using the NWS API.** <sub>(new session, 2026-06-01)</sub>
  <details><summary>full prompt</summary>

  > Build a weather dashboard web app that shows the forecast for Denver using the NWS API. Keep it a single static page.
  </details>
- `→` Try using leaflet for an interactive radar map layer on top of the forecast.
- `↩` No, scrap the radar map, it is too heavy.
  <details><summary>full prompt</summary>

  > No, scrap the radar map, it is too heavy. Keep the page lightweight, just the forecast cards.
  </details>
- `⚑` Actually wait - also add a settings panel so the user can switch cities.
  <details><summary>full prompt</summary>

  > Actually wait -  also add a settings panel so the user can switch cities. My test key is [REDACTED:anthropic-key] and the server is at [REDACTED:url-basic-auth]
  </details>

## Reusable Prompt Pack

```text
1. Build a weather dashboard web app that shows the forecast for Denver using the NWS API. Keep it a single static page.
2. Try using leaflet for an interactive radar map layer on top of the forecast.
   (constraint learned along the way: No, scrap the radar map, it is too heavy. Keep the page lightweight, just the forecast cards.)
3. Actually wait - also add a settings panel so the user can switch cities. My test key is [REDACTED:anthropic-key] and the server is at [REDACTED:url-basic-auth]
```

---

*[treetrace](https://github.com/TreeTraceTool/TreeTrace) v0.9.1 · [schema](https://github.com/TreeTraceTool/TreeTrace/blob/main/SCHEMA.md)*

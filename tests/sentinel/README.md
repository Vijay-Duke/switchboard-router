# Sentinel wire-compatibility suites

These additive suites lock down current wire-level behavior for Switchboard's most important CLI clients — Claude Code (`/v1/messages`, claude format), Codex (`/v1/responses`, openai-responses format), and Gemini CLI (gemini envelope). Each suite pins BOTH directions at the translator seam: the translated upstream request body (`translateRequest`) and the client-facing streamed response events (`translateResponse`). They document compatibility as it exists today rather than redefining it, so a translator regression flips a sentinel red before it reaches users.

Notable pins:
- Claude Code request → openai upstream: tool_use/tool_result round-trip, system flattening, and `adjustMaxTokens` raising `max_tokens` to the tool-calling floor.
- Codex responses → openai upstream: `instructions` → system message, `input_image` → `image_url`, `function_call`/`function_call_output` round-trip; response emits `response.created`/`output_text.delta`/`response.completed`.
- Gemini CLI request → gemini upstream: the URL-controlled-streaming regression guard — the upstream body must contain **no** `stream` field (the fixture carries `stream: true` on input to prove it is dropped; streaming is selected by the URL, not the body).

Golden files are deterministic: `helpers.js` normalizes volatile IDs and timestamps before comparison. To intentionally refresh fixtures, run:

```sh
cd tests && UPDATE_GOLDEN=1 npx vitest run sentinel/
```

Review every generated change before committing, for example with:

```sh
git diff -- tests/sentinel/__golden__
```

If a fixture exposes behavior that looks buggy, preserve the observed wire behavior and record the concern in `FINDINGS.md` instead of silently changing the golden expectation.

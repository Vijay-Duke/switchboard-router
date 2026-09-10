# Combos

Combos let you use one model name for a group of models.

Create them in **Combos**, then use the combo name as the `model` value in a client request.

## Strategies

| Strategy | What Happens |
|---|---|
| Fallback | Tries models in the order you set. If one fails, it tries the next. |
| Round Robin | Rotates requests across the pool. |
| Fusion | Sends the request to several models, then uses a judge model to merge the answer. This costs more because it makes multiple calls. |
| Auto | Uses a router model to pick one worker model for each request. Optional learning can improve routing over time. |

## Capacity Auto-Switch

Capacity auto-switch can move requests such as image or PDF work to a model that supports that input. This works with fallback, round-robin, and fusion combos.

## Thinking Across Members

When a request carries thinking or reasoning controls (Claude `thinking`, OpenAI `reasoning_effort`, Gemini `thinkingConfig`), each member is served in the spelling its own provider accepts. Members with no reasoning support get the thinking parameters stripped instead of failing, so a fallback combo can safely mix reasoning and non-reasoning models. For custom OpenAI-compatible providers, the per-model format is captured by **Import models** (see **Providers**).

## Peak And Off-Peak Rules

When a provider has peak hours configured (see **Providers**), each model row in the combo editor gets an availability rule:

| Rule | Meaning |
|---|---|
| Any time | Always eligible. The default. |
| Peak only | Used only while its provider is in a peak window. |
| Off-peak only | Used only while its provider is off-peak. |

The dropdown appears once any provider has a schedule. A member whose own provider has no schedule gets a disabled dropdown with a hint, and any leftover rule stays dormant: treated as Any time at runtime, with a warning on the combo card. Rules are per combo, so the same model can be off-peak-only in one combo and unrestricted in another.

At request time:

- Members outside their allowed hours are skipped before rotation in every strategy, including nested combos, Auto routing, and media combos.
- A request that names a single model directly is never gated.
- If every member is gated out, the request fails with `503` and a `Retry-After` header naming each rule and when the next window opens.
- Auto combos show skips as badges in **Combos → Routing insights**. Other strategies log each skip to the server log.

## Example

```text
Name: coding
Strategy: Fallback
Models:
  1. cc/claude-sonnet-...
  2. openai/gpt-...
  3. openrouter/...
```

Use it like:

```json
{
  "model": "coding",
  "messages": [{ "role": "user", "content": "Review this function" }]
}
```

## Keep It Simple

Start with fallback. Use round-robin for load spreading, fusion when you really want several model opinions, and Auto when you want router-based selection.

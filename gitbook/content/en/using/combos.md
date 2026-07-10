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

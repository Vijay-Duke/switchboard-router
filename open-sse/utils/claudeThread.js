// Native thread deltas refer to tool calls in provider-owned history.
export function isClaudeThreadContinuation(body) {
  const thread = body?.thread;
  return !!thread && typeof thread === "object" && !Array.isArray(thread)
    && thread.type === "continue"
    && typeof thread.previous_message_id === "string"
    && thread.previous_message_id.trim().length > 0;
}

export function hasClaudeThread(body) {
  return !!body?.thread && typeof body.thread === "object" && !Array.isArray(body.thread);
}

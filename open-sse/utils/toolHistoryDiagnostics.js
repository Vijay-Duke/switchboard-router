import { isClaudeThreadContinuation } from "./claudeThread.js";
// Structural summaries only: never persist prompt text, arguments, tool names,
// call IDs, signatures, images, or credentials. Counts survive body truncation.
export function summarizeClaudeToolHistory(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  const calls = new Set();
  const results = new Set();
  let toolCalls = 0, toolResults = 0, emptyMessages = 0;
  for (const message of messages) {
    if (Array.isArray(message?.content)) {
      if (!message.content.length) emptyMessages++;
      for (const block of message.content) {
        if (message.role === "assistant" && block?.type === "tool_use") {
          toolCalls++;
          if (block.id) calls.add(block.id);
        }
        if (message.role === "user" && block?.type === "tool_result") {
          toolResults++;
          if (block.tool_use_id) results.add(block.tool_use_id);
        }
      }
    }
  }
  if (!toolCalls && !toolResults) return null;
  let missingResults = 0, misplacedResults = 0, invalidTurnCount = 0;
  const invalidTurns = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== "assistant") continue;
    const assistantIndex = i;
    const ids = new Set();
    // Anthropic merges adjacent messages of the same role before validation.
    do {
      for (const block of Array.isArray(messages[i].content) ? messages[i].content : []) {
        if (block?.type === "tool_use" && block.id) ids.add(block.id);
      }
      i++;
    } while (messages[i]?.role === "assistant");
    const next = i;
    const adjacent = new Set();
    for (let j = next; messages[j]?.role === "user"; j++) {
      for (const block of Array.isArray(messages[j].content) ? messages[j].content : []) {
        if (block?.type === "tool_result" && block.tool_use_id) adjacent.add(block.tool_use_id);
      }
    }
    const missing = [...ids].filter(id => !adjacent.has(id));
    if (missing.length) {
      missingResults += missing.length;
      misplacedResults += missing.filter(id => results.has(id)).length;
      invalidTurnCount++;
      if (invalidTurns.length < 10) invalidTurns.push({
        assistantIndex, callCount: ids.size, missingCount: missing.length,
        nextRole: ["user", "assistant", "system", "developer"].includes(messages[next]?.role) ? messages[next].role : "other-or-end",
      });
    }
    i--;
  }
  const externalResults = [...results].filter(id => !calls.has(id)).length;
  const threadContinuation = isClaudeThreadContinuation(body);
  return {
    ...(threadContinuation ? { threadContinuation: true, externalContextResults: externalResults } : {}),
    messageCount: messages.length, toolCalls, toolResults, emptyMessages,
    missingResults, misplacedResults,
    orphanResults: threadContinuation ? 0 : externalResults,
    invalidTurnCount, invalidTurns,
  };
}

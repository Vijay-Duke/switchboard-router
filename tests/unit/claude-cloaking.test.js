/**
 * Unit tests for open-sse/utils/claudeCloaking.js
 *
 * Tests cover:
 *  - cloakClaudeTools() - tool renaming and forced tool_choice suffixing
 */

import { beforeEach, describe, it, expect } from "vitest";
import { applyCloaking, cloakClaudeTools } from "../../open-sse/utils/claudeCloaking.js";
import { resetIdentityState, setSnapshot } from "../../open-sse/identity/snapshot.js";
import { wrapHeaders } from "../../open-sse/identity/wrap.js";
import { prepareClaudeRequest } from "../../open-sse/translator/formats/claude.js";
import { CLAUDE_TOOL_SUFFIX } from "../../open-sse/config/appConstants.js";

beforeEach(() => {
  resetIdentityState();
  setSnapshot("claude-cli", {
    version: "2.1.220",
    billingVersion: "2.1.220",
    tlsSpecRev: "claude-code-2.1.220",
    entrypoint: "cli",
    userAgent: "claude-cli/2.1.220 (external, cli)",
    packageVersion: "0.94.0",
    runtimeVersion: "v22.19.0",
    betas: "oauth-2025-04-20",
  });
});

describe("applyCloaking", () => {
  it("keeps billing and machine identity stable for a credential and session", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const first = applyCloaking(body, "sk-ant-oat-credential-a", "session-a");
    const second = applyCloaking(body, "sk-ant-oat-credential-a", "session-a");

    expect(first.system[0].text).toBe(second.system[0].text);
    expect(first.system[0].text).toContain("cc_version=2.1.220.");
    expect(first.system[0].text).toContain("cc_entrypoint=cli;");
    expect(JSON.parse(first.metadata.user_id)).toEqual(JSON.parse(second.metadata.user_id));
  });

  it("changes machine identity across credentials but preserves the session", () => {
    const body = { messages: [{ role: "user", content: "hello" }] };
    const a = applyCloaking(body, "sk-ant-oat-credential-a", "shared-session");
    const b = applyCloaking(body, "sk-ant-oat-credential-b", "shared-session");
    const userA = JSON.parse(a.metadata.user_id);
    const userB = JSON.parse(b.metadata.user_id);

    expect(userA.device_id).not.toBe(userB.device_id);
    expect(userA.account_uuid).not.toBe(userB.account_uuid);
    expect(userA.session_id).toBe("shared-session");
    expect(userB.session_id).toBe("shared-session");
  });
  it("keeps body and outbound header version/session consistent", () => {
    const sessionId = "conversation-session";
    const apiKey = "sk-ant-oat-secret";
    const body = prepareClaudeRequest(
      { model: "claude-sonnet", messages: [{ role: "user", content: "hello" }] },
      "claude",
      apiKey,
      "connection-a",
      {},
      sessionId,
      "credential-a",
    );
    const outbound = wrapHeaders(
      { Authorization: `Bearer ${apiKey}`, "X-Claude-Code-Session-Id": sessionId },
      { identity: "claude-cli", credentialId: "credential-a" },
    ).headers;
    const billing = body.system[0].text;
    const user = JSON.parse(body.metadata.user_id);

    expect(outbound["User-Agent"]).toContain("claude-cli/2.1.220");
    expect(billing).toContain("cc_version=2.1.220.");
    expect(user.session_id).toBe(outbound["X-Claude-Code-Session-Id"]);
  });

  it("replaces mismatched OAuth metadata session with the outbound session", () => {
    const body = applyCloaking(
      { messages: [], metadata: { user_id: JSON.stringify({ session_id: "wrong" }) } },
      "sk-ant-oat-secret",
      "right-session",
      "credential-a",
    );

    expect(JSON.parse(body.metadata.user_id).session_id).toBe("right-session");
  });

});

describe("cloakClaudeTools", () => {
  const baseBody = {
    tools: [{ name: "todo_write", description: "write todos", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: [{ type: "text", text: "add a todo" }] }]
  };

  it("suffixes client tool names and maps them back", () => {
    const { body, toolNameMap } = cloakClaudeTools(baseBody);
    const suffixed = `todo_write${CLAUDE_TOOL_SUFFIX}`;
    expect(body.tools.find(t => t.name === suffixed)).toBeDefined();
    expect(toolNameMap.get(suffixed)).toBe("todo_write");
  });

  it("suffixes a forced tool_choice to match the renamed tool", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      tool_choice: { type: "tool", name: "todo_write" }
    });
    // Without this, Claude rejects: "Tool 'todo_write' not found in provided tools".
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("suffixes only the chosen tool when several are present", () => {
    const { body } = cloakClaudeTools({
      tools: [
        { name: "search", input_schema: { type: "object", properties: {} } },
        { name: "todo_write", input_schema: { type: "object", properties: {} } }
      ],
      tool_choice: { type: "tool", name: "todo_write" }
    });
    expect(body.tool_choice).toEqual({ type: "tool", name: `todo_write${CLAUDE_TOOL_SUFFIX}` });
  });

  it("leaves non-forced tool_choice untouched", () => {
    const auto = cloakClaudeTools({ ...baseBody, tool_choice: { type: "auto" } });
    expect(auto.body.tool_choice).toEqual({ type: "auto" });

    const none = cloakClaudeTools({ ...baseBody });
    expect(none.body.tool_choice).toBeUndefined();
  });

  it("does not suffix a forced choice that targets a non-client (decoy/built-in) tool", () => {
    // "Bash" is an injected decoy sent unsuffixed; forcing it must stay as-is.
    const { body } = cloakClaudeTools({ ...baseBody, tool_choice: { type: "tool", name: "Bash" } });
    expect(body.tool_choice).toEqual({ type: "tool", name: "Bash" });
  });

  it("renames tool_use names in message history", () => {
    const { body } = cloakClaudeTools({
      ...baseBody,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "todo_write", input: {} }] }
      ]
    });
    const block = body.messages[0].content[0];
    expect(block.name).toBe(`todo_write${CLAUDE_TOOL_SUFFIX}`);
  });

  it("returns the body unchanged when there are no tools", () => {
    const input = { messages: [{ role: "user", content: "hi" }], tool_choice: { type: "tool", name: "x" } };
    const { body, toolNameMap } = cloakClaudeTools(input);
    expect(body).toBe(input);
    expect(toolNameMap).toBeNull();
  });
});

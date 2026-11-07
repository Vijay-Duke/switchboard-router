import { describe, expect, it } from "vitest";
import { decloakToolNames, resolveCloakedToolName, stripCloakSuffix } from "../../open-sse/utils/claudeCloaking.js";
import { createPassthroughStreamWithLogger } from "../../open-sse/utils/stream.js";

// Upstream #4342: when toolNameMap is missing (lost on retry/reconnect) the
// client received unresolvable "<tool>_ide" names. Switchboard scopes the
// suffix-strip fallback to the cloaking provider (claude) so a real client
// tool named "*_ide" on any other provider is left alone.
describe("claude decloak fallback when toolNameMap misses (#4342)", () => {
  it("strips the cloak suffix but never a decoy name", () => {
    expect(stripCloakSuffix("Execute_ide")).toBe("Execute");
    expect(stripCloakSuffix("_ide")).toBeNull();
    expect(stripCloakSuffix("Execute")).toBeNull();
  });

  it("prefers the map and only falls back when asked", () => {
    const map = new Map([["run_ide", "run_original"]]);
    expect(resolveCloakedToolName("run_ide", map, true)).toBe("run_original");
    expect(resolveCloakedToolName("other_ide", map, false)).toBeNull();
    expect(resolveCloakedToolName("other_ide", null, true)).toBe("other");
  });

  it("decloaks non-streaming tool_use blocks without a map on claude only", () => {
    const body = { content: [{ type: "tool_use", id: "t1", name: "Execute_ide", input: {} }, { type: "text", text: "x" }] };
    expect(decloakToolNames(body, null, { fallback: true }).content[0].name).toBe("Execute");
    expect(decloakToolNames(body, null).content[0].name).toBe("Execute_ide");
  });

  async function runPassthrough(provider, chunk) {
    const stream = createPassthroughStreamWithLogger(provider, null, null, "claude-opus-5", "conn-1", {}, null, "sk-ant-oat-test");
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const decoder = new TextDecoder();
    const readAll = (async () => {
      let out = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value);
      }
      return out;
    })();
    await writer.write(new TextEncoder().encode(chunk));
    await writer.close();
    return readAll;
  }

  const sse = `data: ${JSON.stringify({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_01", name: "Execute_ide", input: {} },
  })}\n\n`;

  it("decloaks streamed claude tool names without a map", async () => {
    const out = await runPassthrough("claude", sse);
    expect(out).toContain('"name":"Execute"');
    expect(out).not.toContain("Execute_ide");
  });

  it("leaves other providers' *_ide tool names untouched", async () => {
    const out = await runPassthrough("anthropic", sse);
    expect(out).toContain("Execute_ide");
  });
});

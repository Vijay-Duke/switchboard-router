import { beforeEach, describe, expect, it } from "vitest";
import {
  ASK_LINE,
  ASK_MARKER,
  THANKS_LINE,
  addPendingAsk,
  computeAskValue,
  conversationInfo,
  consumePendingAsk,
  decideAsk,
  matchPendingAsk,
  messagesMentionAsk,
  parseRatingReply,
  passesInteractiveGate,
  ratingFromReply,
  recordAskAnswered,
  recordAskIgnored,
  recordInteraction,
  resetFeedbackAskState,
  stripAskExchange,
} from "../../open-sse/routing/feedbackAsk.js";

const ALWAYS_ASK = () => 0;
const KEY = "key-hash";

function ask(conversationFp, overrides = {}) {
  return decideAsk({
    apiKeyHash: KEY,
    conversationFp,
    askValue: 1,
    feedbackAskEnabled: true,
    gateOk: true,
    rng: ALWAYS_ASK,
    ...overrides,
  });
}

describe("feedback ask policy", () => {
  beforeEach(() => resetFeedbackAskState());

  it("weights each feedback signal and caps their combined value", () => {
    expect(computeAskValue({ exploration: true })).toBe(0.6);
    expect(computeAskValue({ contested: true })).toBe(0.4);
    expect(computeAskValue({ coldCell: true })).toBe(0.3);
    expect(computeAskValue({ escalatedOrRescue: true })).toBe(0.5);
    expect(computeAskValue({ judgeUnconfident: true })).toBe(0.2);
    expect(
      computeAskValue({
        exploration: true,
        contested: true,
        coldCell: true,
        escalatedOrRescue: true,
        judgeUnconfident: true,
      })
    ).toBe(1);
    expect(computeAskValue({})).toBe(0);
  });

  it("only passes complete interactive text responses", () => {
    const good = {
      hasTools: false,
      isBypass: false,
      isInternal: false,
      ok2xx: true,
      hasText: true,
      hasToolCalls: false,
      userTurns: 2,
    };
    expect(passesInteractiveGate({ ...good, hasTools: true })).toBe(false);
    expect(passesInteractiveGate({ ...good, isInternal: true })).toBe(false);
    expect(passesInteractiveGate({ ...good, userTurns: 1 })).toBe(false);
    expect(passesInteractiveGate(good)).toBe(true);
  });

  it("spends at most three ask tokens before a refill", () => {
    expect(ask("conversation-1")).toBe(true);
    expect(ask("conversation-2")).toBe(true);
    expect(ask("conversation-3")).toBe(true);
    expect(ask("conversation-4")).toBe(false);
  });

  it("refills one token after twenty interactions", () => {
    expect(ask("conversation-1")).toBe(true);
    expect(ask("conversation-2")).toBe(true);
    expect(ask("conversation-3")).toBe(true);
    for (let i = 0; i < 20; i += 1) recordInteraction(KEY);
    expect(ask("conversation-4")).toBe(true);
  });

  it("never asks twice in the same conversation", () => {
    expect(ask("conversation-1")).toBe(true);
    expect(ask("conversation-1")).toBe(false);
  });

  it("does not ask when disabled, gated off, or valueless", () => {
    expect(ask("conversation-1", { feedbackAskEnabled: false })).toBe(false);
    expect(ask("conversation-2", { gateOk: false })).toBe(false);
    expect(ask("conversation-3", { askValue: 0 })).toBe(false);
  });

  it("backs off ignored asks and restores sampling after an answer cooldown", () => {
    recordAskIgnored(KEY);
    recordAskIgnored(KEY);
    expect(ask("conversation-1", { rng: () => 0.6 })).toBe(false);
    expect(ask("conversation-1", { rng: () => 0.4 })).toBe(true);

    recordAskIgnored(KEY);
    recordAskIgnored(KEY);
    expect(ask("conversation-2", { rng: () => 0.3 })).toBe(false);
    expect(ask("conversation-2", { rng: () => 0.2 })).toBe(true);

    recordAskAnswered(KEY);
    expect(ask("conversation-3")).toBe(false);
    for (let i = 0; i < 50; i += 1) recordInteraction(KEY);
    expect(ask("conversation-3")).toBe(true);
  });

  it("matches and consumes the newest pending ask while expiring stale entries", () => {
    const ts = Date.now();
    addPendingAsk({ apiKeyHash: KEY, conversationFp: "fp", requestId: "old", ts });
    addPendingAsk({ apiKeyHash: KEY, conversationFp: "fp", requestId: "new", ts: ts + 1 });
    expect(matchPendingAsk(KEY, "fp", ts + 2)).toMatchObject({ requestId: "new" });
    expect(consumePendingAsk(KEY, "fp", ts + 2)).toMatchObject({ requestId: "new" });
    expect(matchPendingAsk(KEY, "fp", ts + 2)).toBeNull();

    addPendingAsk({ apiKeyHash: KEY, conversationFp: "expired", requestId: "stale", ts });
    expect(matchPendingAsk(KEY, "expired", ts + 30 * 60 * 1000 + 1)).toBeNull();
  });

  it("counts an expired pending ask as ignored exactly once", () => {
    addPendingAsk({
      apiKeyHash: KEY,
      conversationFp: "expired",
      requestId: "stale",
      ts: Date.now() - 31 * 60 * 1000,
    });

    expect(matchPendingAsk(KEY, "expired")).toBeNull();
    expect(matchPendingAsk(KEY, "expired")).toBeNull();
    expect(ask("after-one-expiry", { rng: () => 0.75 })).toBe(true);

    addPendingAsk({
      apiKeyHash: KEY,
      conversationFp: "second-expired",
      requestId: "second-stale",
      ts: Date.now() - 31 * 60 * 1000,
    });
    expect(matchPendingAsk(KEY, "second-expired")).toBeNull();
    expect(ask("after-two-expiries", { rng: () => 0.75 })).toBe(false);
  });

  it("does not count an answered pending ask as ignored", () => {
    const ts = Date.now();
    addPendingAsk({ apiKeyHash: KEY, conversationFp: "answered", requestId: "ask", ts });
    expect(consumePendingAsk(KEY, "answered", ts)).toMatchObject({ requestId: "ask" });

    recordAskIgnored(KEY);
    expect(ask("after-answer", { rng: () => 0.75 })).toBe(true);
  });

  it("parses only bare numeric replies and maps their ratings", () => {
    expect(parseRatingReply("2")).toBe(2);
    expect(parseRatingReply(" 3. ")).toBe(3);
    expect(parseRatingReply("1!")).toBe(1);
    expect(parseRatingReply("hello")).toBeNull();
    expect(parseRatingReply("12")).toBeNull();
    expect(parseRatingReply("")).toBeNull();
    expect(ratingFromReply(1)).toBe(-1);
    expect(ratingFromReply(2)).toBe(0);
    expect(ratingFromReply(3)).toBe(1);
  });

  it("summarizes OpenAI user turns and detects a prior synthetic ask", () => {
    const messages = [
      { role: "system", content: "rules" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: `answer\n\n${ASK_MARKER} Reply 1: bad` },
      { role: "user", content: "3" },
    ];

    expect(conversationInfo(messages)).toEqual({
      firstUserText: "first user turn",
      latestUserText: "3",
      priorAssistantHasAsk: true,
      userTurns: 2,
    });
    expect(conversationInfo([{ role: "user", content: "only turn" }])).toEqual({
      firstUserText: "only turn",
      latestUserText: "only turn",
      priorAssistantHasAsk: false,
      userTurns: 1,
    });
    expect(conversationInfo(null)).toEqual({
      firstUserText: "",
      latestUserText: "",
      priorAssistantHasAsk: false,
      userTurns: 0,
    });
  });

  it("only checks the final assistant before the latest user for an ask", () => {
    expect(
      conversationInfo([
        { role: "user", content: "first" },
        { role: "assistant", content: ASK_MARKER },
        { role: "assistant", content: "ordinary reply" },
        { role: "user", content: "latest" },
      ]).priorAssistantHasAsk
    ).toBe(false);
    expect(
      conversationInfo([
        { role: "user", content: "first" },
        { role: "assistant", content: "ordinary reply" },
        { role: "assistant", content: ASK_MARKER },
        { role: "user", content: "latest" },
      ]).priorAssistantHasAsk
    ).toBe(true);
  });

  it("extracts text parts from multimodal user content", () => {
    expect(
      conversationInfo([
        { role: "user", content: [{ type: "text", text: "first" }, { type: "image_url", image_url: {} }] },
        { role: "assistant", content: "response" },
        { role: "user", content: ["latest ", { type: "text", text: "turn" }, { type: "input_audio" }] },
      ])
    ).toMatchObject({ firstUserText: "first", latestUserText: "latest turn", userTurns: 2 });
  });

  it("detects synthetic asks only in string content", () => {
    expect(messagesMentionAsk([{ role: "assistant", content: `reply ${ASK_MARKER}` }])).toBe(true);
    expect(messagesMentionAsk([{ role: "assistant", content: [{ type: "text", text: ASK_MARKER }] }])).toBe(false);
    expect(messagesMentionAsk([{ role: "assistant", content: "ordinary reply" }])).toBe(false);
    expect(messagesMentionAsk(null)).toBe(false);
  });

  it("strips a synthetic ask, its rating reply, and its acknowledgement", () => {
    const multimodal = { role: "assistant", content: [{ type: "text", text: "keep" }] };
    const messages = [
      { role: "system", content: "rules" },
      { role: "user", content: "question" },
      { role: "assistant", content: `the answer${ASK_LINE}` },
      { role: "user", content: "3" },
      { role: "assistant", content: THANKS_LINE },
      multimodal,
      { role: "user", content: "unrelated follow-up" },
    ];

    const stripped = stripAskExchange(messages);
    expect(stripped).toHaveLength(5);
    expect(stripped[2]).toEqual({ role: "assistant", content: "the answer" });
    expect(stripped).not.toContainEqual({ role: "user", content: "3" });
    expect(stripped).not.toContainEqual({ role: "assistant", content: THANKS_LINE });
    expect(stripped[3]).toBe(multimodal);
    expect(stripped[4]).toEqual({ role: "user", content: "unrelated follow-up" });
    expect(messages[2].content).toBe(`the answer${ASK_LINE}`);
  });
});

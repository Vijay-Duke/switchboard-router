import { describe, expect, it, beforeEach } from "vitest";
import {
  recordRatingForRelearn,
  resetFeedbackRelearn,
} from "../../open-sse/routing/feedbackRelearn.js";

describe("recordRatingForRelearn", () => {
  beforeEach(() => {
    resetFeedbackRelearn();
  });

  it("triggers on every third rating and resets its counter", () => {
    expect(recordRatingForRelearn("auto")).toBe(false);
    expect(recordRatingForRelearn("auto")).toBe(false);
    expect(recordRatingForRelearn("auto")).toBe(true);
    expect(recordRatingForRelearn("auto")).toBe(false);
    expect(recordRatingForRelearn("auto")).toBe(false);
    expect(recordRatingForRelearn("auto")).toBe(true);
  });

  it("tracks different combos independently", () => {
    expect(recordRatingForRelearn("a")).toBe(false);
    expect(recordRatingForRelearn("a")).toBe(false);
    expect(recordRatingForRelearn("b")).toBe(false);
    expect(recordRatingForRelearn("a")).toBe(true);
    expect(recordRatingForRelearn("b")).toBe(false);
    expect(recordRatingForRelearn("b")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isRateLimitMessage } from "../src/browser/ui-state.js";

describe("rate-limit message detection", () => {
  it("recognizes request, usage, and frequent-chat throttles", () => {
    for (const message of [
      "Too many requests. Try again later.",
      "You have reached the usage limit.",
      "Too many messages. Please wait.",
      "You are sending messages too frequently.",
      "채팅을 너무 자주 보내고 있습니다.",
      "메시지를 너무 자주 보내고 있습니다.",
    ]) {
      expect(isRateLimitMessage(message)).toBe(true);
    }
  });

  it("does not classify ordinary remote errors as rate limits", () => {
    expect(isRateLimitMessage("Something went wrong.")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  extractConversationId,
  isValidConversationId,
  normalizeText,
  truncateUtf8,
  uniqueOptions,
} from "../src/browser/selectors.js";

describe("selector helpers", () => {
  it("extracts only ChatGPT conversation ids", () => {
    expect(extractConversationId("https://chatgpt.com/c/12345678-abcd")).toBe("12345678-abcd");
    expect(extractConversationId("https://www.chatgpt.com/c/abcdef123456")).toBe("abcdef123456");
    expect(extractConversationId("https://evil.example/c/abcdef123456")).toBeNull();
    expect(extractConversationId("https://chatgpt.com/")).toBeNull();
  });

  it("validates conversation ids conservatively", () => {
    expect(isValidConversationId("12345678-abcd")).toBe(true);
    expect(isValidConversationId("../bad")).toBe(false);
    expect(isValidConversationId("short")).toBe(false);
  });

  it("normalizes picker labels without inventing options", () => {
    expect(normalizeText("  GPT-5.6   Sol \n High ")).toBe("GPT-5.6 Sol High");
    expect(uniqueOptions([" A ", "A", "", "B"])).toEqual(["A", "B"]);
  });

  it("truncates on UTF-8 character boundaries", () => {
    const result = truncateUtf8("ab한글cd", 7);
    expect(result.text).toBe("ab한");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(7);
  });
});

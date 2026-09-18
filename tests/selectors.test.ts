import { describe, expect, it } from "vitest";
import {
  extractConversationId,
  extractProjectId,
  isValidConversationId,
  isValidProjectId,
  projectConversationUrl,
  projectHomeUrl,
  normalizeText,
  truncateUtf8,
  uniqueOptions,
} from "../src/browser/selectors.js";

describe("selector helpers", () => {
  it("extracts only ChatGPT conversation ids", () => {
    expect(extractConversationId("https://chatgpt.com/c/12345678-abcd")).toBe("12345678-abcd");
    expect(extractConversationId("https://www.chatgpt.com/c/abcdef123456")).toBe("abcdef123456");
    expect(
      extractConversationId(
        "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710-demo/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      )
    ).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(extractConversationId("https://evil.example/c/abcdef123456")).toBeNull();
    expect(extractConversationId("https://chatgpt.com/")).toBeNull();
  });


  it("extracts canonical Project ids from project homes and threads", () => {
    expect(
      extractProjectId(
        "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710-demo/project"
      )
    ).toBe("g-p-6aa23c9208608191a9b5403be2098710");
    expect(
      extractProjectId(
        "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710-hangeul/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
      )
    ).toBe("g-p-6aa23c9208608191a9b5403be2098710");
    expect(extractProjectId("https://chatgpt.com/c/abcdef123456")).toBeNull();
    expect(extractProjectId("https://evil.example/g/g-p-abc/project")).toBeNull();
  });

  it("builds canonical project URLs without trusting a slug", () => {
    const projectId = "g-p-6aa23c9208608191a9b5403be2098710";
    const conversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(isValidProjectId(projectId)).toBe(true);
    expect(projectHomeUrl(projectId)).toBe(
      "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710/project"
    );
    expect(projectConversationUrl(projectId, conversationId)).toBe(
      "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710/c/" + conversationId
    );
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

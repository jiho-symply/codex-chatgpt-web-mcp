import { describe, expect, it } from "vitest";
import { payloadHash } from "../src/turns/store.js";

describe("turn payload attachment hashing", () => {
  it("changes the idempotency hash when staged attachments change", () => {
    const base = { prompt: "review", conversationId: "12345678-abcd" };
    expect(payloadHash({ ...base, inputAssetIds: ["input_aaaaaaaaaaaaaaaaaaaaaaaa"] }))
      .not.toBe(payloadHash({ ...base, inputAssetIds: ["input_bbbbbbbbbbbbbbbbbbbbbbbb"] }));
  });

  it("keeps attachment order part of the request identity", () => {
    const base = { prompt: "compare" };
    expect(payloadHash({ ...base, inputAssetIds: ["a", "b"] }))
      .not.toBe(payloadHash({ ...base, inputAssetIds: ["b", "a"] }));
  });
});

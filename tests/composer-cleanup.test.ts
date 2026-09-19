import { describe, expect, it } from "vitest";
import { composerNeedsAttachmentReset } from "../src/browser/composer-cleanup.js";

describe("composer cleanup", () => {
  it("requires reload for any stale attachment evidence", () => {
    expect(
      composerNeedsAttachmentReset({
        attachmentChipCount: 1,
        attachmentRemoveControlCount: 0,
        attachedFileCount: 0,
      })
    ).toBe(true);
    expect(
      composerNeedsAttachmentReset({
        attachmentChipCount: 0,
        attachmentRemoveControlCount: 1,
        attachedFileCount: 0,
      })
    ).toBe(true);
    expect(
      composerNeedsAttachmentReset({
        attachmentChipCount: 0,
        attachmentRemoveControlCount: 0,
        attachedFileCount: 1,
      })
    ).toBe(true);
  });

  it("does not reload a clean composer", () => {
    expect(
      composerNeedsAttachmentReset({
        attachmentChipCount: 0,
        attachmentRemoveControlCount: 0,
        attachedFileCount: 0,
      })
    ).toBe(false);
  });
});

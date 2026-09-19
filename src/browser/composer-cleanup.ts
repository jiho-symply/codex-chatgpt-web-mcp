export interface ComposerResidueSnapshot {
  attachmentChipCount: number;
  attachmentRemoveControlCount: number;
  attachedFileCount: number;
}

export function composerNeedsAttachmentReset(
  snapshot: ComposerResidueSnapshot
): boolean {
  return (
    snapshot.attachmentChipCount > 0 ||
    snapshot.attachmentRemoveControlCount > 0 ||
    snapshot.attachedFileCount > 0
  );
}

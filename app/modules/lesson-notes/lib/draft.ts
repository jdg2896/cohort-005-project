export type NoteDraftStatus = {
  /** Characters the server will store: the draft is trimmed before saving. */
  length: number;
  maxLength: number;
  tooLong: boolean;
  empty: boolean;
  unsaved: boolean;
  canSave: boolean;
};

export function describeDraft(
  draft: string,
  savedBody: string | null,
  maxLength: number
): NoteDraftStatus {
  const trimmed = draft.trim();
  const length = trimmed.length;
  const tooLong = length > maxLength;
  const empty = length === 0;
  const unsaved = trimmed !== (savedBody ?? "").trim();

  return {
    length,
    maxLength,
    tooLong,
    empty,
    unsaved,
    canSave: unsaved && !empty && !tooLong,
  };
}

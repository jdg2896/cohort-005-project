import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { describeDraft, type NoteDraftStatus } from "./lib/draft";

export type { NoteDraftStatus };

/**
 * What the note editor should show for the text in the box, compared with the
 * note last saved for this lesson (`null` when there is none yet). Mirrors the
 * server's rules — trimmed, non-empty, at most MAX_NOTE_LENGTH — so the Save
 * button is only enabled for a note the server will accept.
 */
export function noteDraftStatus(
  draft: string,
  savedBody: string | null,
  maxLength: number = MAX_NOTE_LENGTH
): NoteDraftStatus {
  return describeDraft(draft, savedBody, maxLength);
}

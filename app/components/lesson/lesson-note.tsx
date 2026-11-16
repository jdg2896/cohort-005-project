import { useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { LessonSection } from "~/components/lesson-section";
import { noteDraftStatus } from "~/modules/lesson-notes";
import { CheckCircle2, NotebookPen } from "lucide-react";
import { cn, formatRelativeTime } from "~/lib/utils";
import type { LessonLoaderData } from "./lesson-loader-data";

export function LessonNote({ note }: { note: LessonLoaderData["note"] }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [draft, setDraft] = useState(note?.body ?? "");
  const isSaving = fetcher.state !== "idle";
  const error = fetcher.data?.error;
  const status = noteDraftStatus(draft, note?.body ?? null);

  return (
    <LessonSection
      icon={NotebookPen}
      title="Your notes"
      description="Private to you. Jot things down while you watch."
    >
      <fetcher.Form method="post" className="space-y-2">
        <input type="hidden" name="intent" value="save-note" />
        <Textarea
          name="body"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={5}
          placeholder="What do you want to remember from this lesson?"
          aria-label="Your notes"
          className="min-h-28 resize-y"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="sm"
            disabled={isSaving || !status.canSave}
          >
            {isSaving ? "Saving..." : "Save note"}
          </Button>
          <NoteSaveState
            error={error}
            unsaved={status.unsaved}
            updatedAt={note?.updatedAt ?? null}
          />
          <span
            className={cn(
              "ml-auto text-xs",
              status.tooLong ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {status.length} / {status.maxLength}
          </span>
        </div>
      </fetcher.Form>
    </LessonSection>
  );
}

export function NoteSaveState({
  error,
  unsaved,
  updatedAt,
}: {
  error: string | undefined;
  unsaved: boolean;
  updatedAt: string | null;
}) {
  if (error) return <span className="text-sm text-destructive">{error}</span>;
  if (unsaved) {
    return (
      <span className="text-xs text-muted-foreground">Unsaved changes</span>
    );
  }
  if (!updatedAt) return null;
  return (
    <span
      suppressHydrationWarning
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      <CheckCircle2 className="size-3.5 text-green-600" />
      Saved {formatRelativeTime(updatedAt)}
    </span>
  );
}

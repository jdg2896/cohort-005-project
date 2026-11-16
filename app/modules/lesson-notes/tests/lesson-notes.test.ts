import { describe, it, expect } from "vitest";
import { MAX_NOTE_LENGTH } from "~/lib/notes";
import { noteDraftStatus } from "../index";

describe("noteDraftStatus", () => {
  it("cannot save an empty box when there is no note yet", () => {
    expect(noteDraftStatus("", null)).toEqual({
      length: 0,
      maxLength: MAX_NOTE_LENGTH,
      tooLong: false,
      empty: true,
      unsaved: false,
      canSave: false,
    });
  });

  it("treats whitespace-only text as empty", () => {
    const status = noteDraftStatus("   \n ", null);
    expect(status.empty).toBe(true);
    expect(status.length).toBe(0);
    expect(status.canSave).toBe(false);
  });

  it("can save new text when there is no note yet", () => {
    const status = noteDraftStatus("Generics need a constraint", null);
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(true);
    expect(status.length).toBe(26);
  });

  it("has nothing to save when the text matches the saved note", () => {
    const status = noteDraftStatus("Same note", "Same note");
    expect(status.unsaved).toBe(false);
    expect(status.canSave).toBe(false);
  });

  it("ignores surrounding whitespace when comparing with the saved note", () => {
    expect(noteDraftStatus("  Same note\n", "Same note").unsaved).toBe(false);
    expect(noteDraftStatus("Same note", "Same note\n").unsaved).toBe(false);
  });

  it("can save an edit to the saved note", () => {
    const status = noteDraftStatus("Edited note", "Original note");
    expect(status.unsaved).toBe(true);
    expect(status.canSave).toBe(true);
  });

  it("counts the trimmed text, which is what the server stores", () => {
    expect(noteDraftStatus("  abc  ", null).length).toBe(3);
  });

  it("allows a note of exactly the maximum length", () => {
    const status = noteDraftStatus("a".repeat(10), null, 10);
    expect(status.tooLong).toBe(false);
    expect(status.canSave).toBe(true);
  });

  it("refuses a note one character over the maximum", () => {
    const status = noteDraftStatus("a".repeat(11), null, 10);
    expect(status.tooLong).toBe(true);
    expect(status.canSave).toBe(false);
    expect(status.maxLength).toBe(10);
  });

  it("uses MAX_NOTE_LENGTH by default", () => {
    expect(noteDraftStatus("a".repeat(MAX_NOTE_LENGTH + 1), null).tooLong).toBe(
      true
    );
  });
});

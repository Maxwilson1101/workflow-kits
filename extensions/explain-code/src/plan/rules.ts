import type { Diagnostic, Walkthrough } from "../types.ts";

const isText = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

const paragraphs = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0 && value.every(isText);

export function validateStructure(plan: Walkthrough, count: number): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const at = (path: string, message: string) => diagnostics.push({ path, message });

  if (!isText(plan.title)) at("plan.title", "expected nonempty text");
  if (!paragraphs(plan.intro)) at("plan.intro", "expected nonempty paragraphs");
  if (!Array.isArray(plan.sections) || plan.sections.length === 0) {
    at("plan.sections", "expected a nonempty array");
    return diagnostics;
  }

  let previousEnd = 0;
  plan.sections.forEach((section, index) => {
    const where = `plan.sections[${index}]`;
    if (!Number.isInteger(section.start) || !Number.isInteger(section.end))
      at(where, "expected integer line numbers");
    else if (section.start < 1 || section.end > count || section.start > section.end)
      at(where, `invalid range ${section.start}–${section.end}; source has ${count} lines`);
    else if (section.start !== previousEnd + 1)
      at(where, `expected start ${previousEnd + 1}, found ${section.start}`);
    if (!isText(section.title)) at(`${where}.title`, "expected nonempty text");
    if (!paragraphs(section.intro)) at(`${where}.intro`, "expected nonempty paragraphs");
    if (!Array.isArray(section.notes)) {
      at(`${where}.notes`, "expected an array");
      return;
    }
    let noteEnd = section.start - 1;
    section.notes.forEach((note, noteIndex) => {
      const place = `${where}.notes[${noteIndex}]`;
      if (!Number.isInteger(note.start) || !Number.isInteger(note.end))
        at(place, "expected integer line numbers");
      else if (note.start < section.start || note.end > section.end || note.start > note.end)
        at(place, `invalid range ${note.start}–${note.end} inside ${section.start}–${section.end}`);
      else if (note.start <= noteEnd) at(place, "notes must be ordered and cannot overlap");
      if (!isText(note.title)) at(`${place}.title`, "expected nonempty text");
      if (!paragraphs(note.paragraphs)) at(`${place}.paragraphs`, "expected nonempty paragraphs");
      noteEnd = note.end;
    });
    previousEnd = section.end;
  });

  if (previousEnd !== count) at("plan.sections", `expected coverage to end at ${count}`);
  return diagnostics;
}

import assert from "node:assert/strict";
import { basename } from "node:path";
import type { Walkthrough } from "../types.ts";
import { articleLabel, filenameLabel, noteId, noteLabel, sectionId } from "../render/contract.ts";
import type { PageSnapshot, Prose } from "./page.ts";

export interface Expected {
  sourcePath: string;
  plan: Walkthrough;
  lines: readonly string[];
  language: string;
}

const plain = (text: string): string => text.replace(/`/g, "");
const codes = (text: string): string[] => text.split("`").filter((_, index) => index % 2 === 1);

export function expectedLines(input: Expected): number[] {
  return input.plan.sections.flatMap((section) =>
    Array.from({ length: section.end - section.start + 1 }, (_, offset) => section.start + offset),
  );
}

function assertProse(actual: Prose, expected: string, where: string): void {
  assert.equal(actual.text, plain(expected), `${where}: text differs`);
  assert.deepEqual(actual.codes, codes(expected), `${where}: inline code differs`);
}

export function assertContent(snapshot: PageSnapshot, input: Expected): void {
  const { plan, lines, language, sourcePath } = input;
  assert.equal(snapshot.title, plan.title, "page heading differs");
  assert.equal(snapshot.documentTitle, plan.title, "page title differs");
  assert.equal(
    snapshot.noteCount,
    plan.sections.reduce((total, section) => total + section.notes.length, 0),
    "explanation count differs",
  );
  assert.equal(snapshot.articleLabel, articleLabel, "article label differs");
  assert.equal(
    snapshot.filename,
    filenameLabel(basename(sourcePath), lines.length),
    "filename line differs",
  );
  assert.equal(snapshot.language, language, "declared language differs");
  assert.equal(snapshot.scripts, 1, "expected exactly one script");
  assert.equal(snapshot.resources, 0, "page references external resources");
  assert.deepEqual(snapshot.handlers, [], "page uses inline event handler attributes");
  assert.equal(new Set(snapshot.ids).size, snapshot.ids.length, "duplicate element ids");
  assert.equal(snapshot.intro.length, plan.intro.length, "intro paragraph count differs");
  plan.intro.forEach((text, index) => assertProse(snapshot.intro[index]!, text, `intro[${index}]`));
  assert.equal(snapshot.sections.length, plan.sections.length, "section count differs");
  plan.sections.forEach((section, index) => {
    const actual = snapshot.sections[index]!;
    const where = `sections[${index}]`;
    assert.equal(actual.id, sectionId(section.start), `${where}: aria-labelledby differs`);
    assert.equal(actual.heading, section.title, `${where}: heading differs`);
    assert.equal(
      actual.intro.length,
      section.intro.length,
      `${where}: intro paragraph count differs`,
    );
    section.intro.forEach((text, paragraph) =>
      assertProse(actual.intro[paragraph]!, text, `${where}.intro[${paragraph}]`),
    );
    assert.deepEqual(
      actual.lines.map((line) => line.number),
      Array.from(
        { length: section.end - section.start + 1 },
        (_, offset) => section.start + offset,
      ),
      `${where}: source line coverage or order differs`,
    );
    actual.lines.forEach((line) => {
      assert.equal(
        line.source,
        lines[line.number - 1] ?? "",
        `${where}: source differs on line ${line.number}`,
      );
    });
    assert.equal(
      actual.lines.filter((line) => line.button !== null).length,
      section.notes.length,
      `${where}: note button count differs`,
    );
    section.notes.forEach((note) => {
      const place = `${where}: note on line ${note.end}`;
      const row = actual.lines.find((line) => line.number === note.end);
      assert.ok(row?.button, `${place}: missing note button`);
      const button = row.button!;
      assert.equal(button.start, String(note.start), `${place}: button start differs`);
      assert.equal(button.end, String(note.end), `${place}: button end differs`);
      assert.equal(button.expanded, "false", `${place}: button must start collapsed`);
      assert.equal(button.title, note.title, `${place}: button title differs`);
      assert.equal(
        button.label,
        noteLabel(note.title, note.start, note.end),
        `${place}: button label differs`,
      );
      assert.ok(row.note, `${place}: explanation must follow the end line`);
      const element = row.note!;
      assert.equal(element.id, noteId(note.start, note.end), `${place}: explanation id differs`);
      assert.equal(button.controls, element.id, `${place}: aria-controls differs`);
      assert.equal(element.hidden, true, `${place}: explanation must start collapsed`);
      assert.equal(element.heading, note.title, `${place}: explanation heading differs`);
      assert.equal(
        element.paragraphs.length,
        note.paragraphs.length,
        `${place}: paragraph count differs`,
      );
      note.paragraphs.forEach((text, paragraph) =>
        assertProse(element.paragraphs[paragraph]!, text, `${place}: paragraphs[${paragraph}]`),
      );
    });
  });
  if (language !== "plain") {
    const spans = snapshot.sections.reduce(
      (total, section) => total + section.lines.reduce((sum, line) => sum + line.syntaxSpans, 0),
      0,
    );
    assert.ok(spans > 0, "no static syntax highlighting spans found");
  }
}

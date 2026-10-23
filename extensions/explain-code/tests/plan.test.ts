import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlan, readSource } from "../src/plan/parse.ts";
import type { Walkthrough } from "../src/types.ts";

const fixtures = join(import.meta.dir, "fixtures");
const sourcePath = join(fixtures, "sample.py");
const lines = readSource(sourcePath);
const count = lines.length;
const valid = JSON.parse(readFileSync(join(fixtures, "sample.plan.json"), "utf8")) as Walkthrough;
const text = (plan: unknown): string => JSON.stringify(plan);
const clone = (): Walkthrough => JSON.parse(JSON.stringify(valid));
const paths = (plan: unknown): string[] =>
  readPlan(text(plan), count).diagnostics.map((diagnostic) => diagnostic.path);
const messages = (plan: unknown): string[] =>
  readPlan(text(plan), count).diagnostics.map((diagnostic) => diagnostic.message);

describe("source reading", () => {
  test("keeps every line and strips only the final newline", () => {
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("def positives(values):");
    expect(lines[5]).toBe("    return result");
  });

  test("rejects invalid UTF-8 and NUL instead of corrupting source", () => {
    const workspace = mkdtempSync(join(tmpdir(), "explain-code-plan-"));
    try {
      const path = join(workspace, "bad.txt");
      writeFileSync(path, new Uint8Array([0xff]));
      expect(() => readSource(path)).toThrow();
      writeFileSync(path, "a\0b");
      expect(() => readSource(path)).toThrow("NUL");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("plan reading", () => {
  test("accepts the reference plan without repairs", () => {
    const result = readPlan(text(valid), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.plan?.title).toBe("正数筛选");
  });

  test("rejects invalid syntax, comments, and empty answers", () => {
    expect(readPlan('{"title": "正数筛选",}', count).diagnostics[0]?.message).toContain(
      "invalid JSON syntax",
    );
    expect(readPlan("// comment\n{}", count).diagnostics[0]?.message).toContain(
      "invalid JSON syntax",
    );
    expect(readPlan("   ", count).diagnostics[0]?.message).toBe("expected a JSON object");
  });

  test("strips a single code fence", () => {
    const fenced = `\`\`\`json\n${text(valid)}\n\`\`\``;
    expect(readPlan(fenced, count).plan?.title).toBe("正数筛选");
  });

  test("rejects duplicate keys", () => {
    const duplicate = text(valid).replace(
      '"title":"正数筛选"',
      '"title":"正数筛选","title":"重复"',
    );
    expect(readPlan(duplicate, count).diagnostics[0]?.message).toBe("duplicate key");
  });

  test("drops unknown fields instead of failing", () => {
    const extra = { ...clone(), extra: true, __proto__name: "x", excerpt: true };
    const result = readPlan(text(extra), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan).toBeDefined();
    expect(result.repaired.join("\n")).toContain("extra: removed an unknown field");
  });

  test("rejects a plan without usable text", () => {
    const missing = clone() as Partial<Walkthrough>;
    delete missing.title;
    expect(readPlan(text(missing), count).diagnostics[0]?.message).toContain("expected nonempty");
    expect(paths({ ...clone(), sections: [] })).toContain("plan.sections");
    const empty = clone();
    empty.intro = [];
    expect(paths(empty)).toContain("plan.intro");
  });
});

describe("mechanical repair", () => {
  test("clamps out-of-range numbers and swaps reversed ranges", () => {
    const plan = clone();
    plan.sections[0]!.start = 0;
    plan.sections[0]!.end = 99;
    const result = readPlan(text(plan), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.sections[0]).toMatchObject({ start: 1, end: count });

    const reversed = clone();
    reversed.sections[0]!.notes[0] = { start: 2, end: 1, title: "反序", paragraphs: ["文字"] };
    const swapped = readPlan(text(reversed), count);
    expect(swapped.diagnostics).toEqual([]);
    expect(swapped.plan?.sections[0]?.notes[0]).toMatchObject({ start: 1, end: 2 });
  });

  test("extends the previous section to close a coverage gap", () => {
    const plan = clone();
    plan.sections[0]!.end = 4;
    const result = readPlan(text(plan), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.sections[0]?.end).toBe(count);
    expect(result.repaired.join("\n")).toContain("end extended");
  });

  test("moves the first section back to line 1", () => {
    const plan = clone();
    plan.sections[0]!.start = 3;
    plan.sections[0]!.notes = plan.sections[0]!.notes.filter((note) => note.start >= 3);
    const result = readPlan(text(plan), count);
    expect(result.plan?.sections[0]?.start).toBe(1);
  });

  test("resolves overlapping sections", () => {
    const plan = clone();
    const extra = JSON.parse(JSON.stringify(plan.sections[0]!)) as Walkthrough["sections"][0];
    extra.title = "重复";
    plan.sections.push(extra);
    const result = readPlan(text(plan), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.sections).toHaveLength(1);
  });

  test("keeps notes inside their section and un-overlaps them", () => {
    const plan = clone();
    plan.sections[0]!.notes[1] = { start: 1, end: 3, title: "重叠", paragraphs: ["文字"] };
    const result = readPlan(text(plan), count);
    expect(result.diagnostics).toEqual([]);
    const notes = result.plan!.sections[0]!.notes;
    expect(notes.map((note) => note.start)).toEqual([1, 2, 4, 6]);
  });

  test("drops incomplete notes and sections", () => {
    const plan = clone();
    plan.sections[0]!.notes.push({ start: 6, end: 6, title: "", paragraphs: [] });
    const result = readPlan(text(plan), count);
    expect(result.diagnostics).toEqual([]);
    expect(result.plan?.sections[0]?.notes).toHaveLength(4);
    expect(result.repaired.join("\n")).toContain("dropped an incomplete note");
  });

  test("is idempotent", () => {
    const plan = clone();
    plan.sections[0]!.end = 4;
    plan.sections[0]!.notes[2] = { start: 4, end: 6, title: "跨节", paragraphs: ["文字"] };
    const first = readPlan(text(plan), count);
    const second = readPlan(JSON.stringify(first.plan), count);
    expect(second.repaired).toEqual([]);
    expect(second.plan).toEqual(first.plan);
  });

  test("rejects a plan that no repair can make complete", () => {
    const missing = readPlan(text({ title: "标题", intro: ["文字"] }), count);
    expect(missing.diagnostics.map((diagnostic) => diagnostic.path)).toEqual(["plan.sections"]);
    expect(messages({ title: "标题", intro: ["文字"] }).join()).toContain(
      "expected a nonempty array",
    );
  });
});

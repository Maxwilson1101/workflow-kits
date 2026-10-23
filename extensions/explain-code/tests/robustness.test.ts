import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generationPrompt, refinementPrompt } from "../src/prompts.ts";
import { readSource } from "../src/plan/parse.ts";
import { renderDocument } from "../src/render/document.ts";
import { highlightLines, languageFor } from "../src/render/highlight.ts";
import type { PreparedSource, Walkthrough } from "../src/types.ts";

const fixture = join(import.meta.dir, "fixtures", "sample.py");
const plan = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "sample.plan.json"), "utf8"),
) as Walkthrough;
const source: PreparedSource = {
  path: fixture,
  filename: "sample.py",
  lines: readSource(fixture),
  language: "python",
};

describe("prompt boundaries", () => {
  test("keeps the guideline out of the generation prompt", () => {
    const generation = generationPrompt(source);
    expect(generation).toContain('<source file="sample.py" lines="6">');
    expect(generation).not.toContain("<writing-guideline>");
  });

  test("carries the guideline and the draft into refinement only", () => {
    const refinement = refinementPrompt(source, plan, "PRIVATE_GUIDELINE");
    expect(refinement).toContain("<writing-guideline>\nPRIVATE_GUIDELINE\n</writing-guideline>");
    expect(refinement).toContain("<plan>");
    expect(refinement).toContain('<source file="sample.py" lines="6">');
    expect(generationPrompt(source)).not.toContain("PRIVATE_GUIDELINE");
  });

  test("uses a single user message worth of context", () => {
    for (const prompt of [generationPrompt(source), refinementPrompt(source, plan, "指南")]) {
      expect(prompt).not.toContain("Problems found");
      expect(prompt.split("<source").length).toBe(2);
    }
  });
});

describe("rendering boundaries", () => {
  test("preserves carriage returns for unrecognised languages", async () => {
    expect(await highlightLines(["a\r", "b\r"], "plain")).toEqual(["a&#13;", "b&#13;"]);
  });

  test("rejects missing highlighted lines instead of silently emitting empty code", () => {
    expect(() =>
      renderDocument({
        plan,
        lines: readSource(fixture),
        highlighted: [],
        sourcePath: fixture,
        language: "python",
      }),
    ).toThrow("line count");
  });

  test("escapes prose and keeps inline code", () => {
    const lines = readSource(fixture);
    expect(
      renderDocument({
        plan: { ...plan, intro: ["使用 `<div>` 与 a < b"] },
        lines,
        highlighted: lines.map(() => ""),
        sourcePath: fixture,
        language: languageFor(fixture),
      }),
    ).toContain("使用 <code>&lt;div&gt;</code> 与 a &lt; b");
  });
});

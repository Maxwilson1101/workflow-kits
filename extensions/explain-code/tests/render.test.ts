import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderInline, renderParagraphs } from "../src/render/inline.ts";
import { highlightLines, languageFor, supportedLanguages } from "../src/render/highlight.ts";
import { renderDocument } from "../src/render/document.ts";
import type { Walkthrough } from "../src/types.ts";
import { readSource } from "../src/plan/parse.ts";

const fixtures = join(import.meta.dir, "fixtures");
const sourcePath = join(fixtures, "sample.py");
const lines = readSource(sourcePath);
const plan = JSON.parse(readFileSync(join(fixtures, "sample.plan.json"), "utf8")) as Walkthrough;

const render = async (): Promise<string> => {
  const highlighted = await highlightLines(lines, languageFor(sourcePath));
  return renderDocument({
    plan,
    lines,
    highlighted,
    sourcePath,
    language: languageFor(sourcePath),
  });
};

describe("inline rendering", () => {
  test("escapes text and keeps inline code", () => {
    expect(renderInline("读取 `values` 后返回。")).toBe("读取 <code>values</code> 后返回。");
    expect(renderInline("尖括号 `<div>` 与 & 符号。")).toBe(
      "尖括号 <code>&lt;div&gt;</code> 与 &amp; 符号。",
    );
  });

  test("renders paragraph classes", () => {
    expect(renderParagraphs(["第一段。", "第二段。"], "intro")).toBe(
      '<p class="intro">第一段。</p>\n<p class="intro">第二段。</p>',
    );
  });
});

describe("document rendering", () => {
  test("renders one line per source line in order", async () => {
    const html = await render();
    const numbers = [...html.matchAll(/<div class="line" data-line="(\d+)">/g)].map((match) =>
      Number(match[1]),
    );
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("places each note on its final line", async () => {
    const html = await render();
    for (const note of plan.sections[0]!.notes) {
      const row = html.split(`<div class="line" data-line="${note.end}">`)[1] ?? "";
      expect(row).toContain(`data-start="${note.start}"`);
      expect(row).toContain(`aria-controls="note-${note.start}-${note.end}"`);
      expect(row.split('class="explanation"')[0]).not.toContain("hidden>");
    }
    expect(html.match(/class="note-toggle"/g)).toHaveLength(4);
    expect(html.match(/class="explanation"/g)).toHaveLength(4);
  });

  test("hides explanations by default and inlines assets", async () => {
    const html = await render();
    expect(html.match(/id="note-/g)).toHaveLength(4);
    expect(html).toContain('<div class="explanation" id="note-3-5" hidden>');
    expect(html).not.toContain("{{");
    expect(html).toContain("<style>");
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(/https?:\/\//.test(html)).toBe(false);
    expect(html).toContain("<!doctype html>");
  });
});

describe("language detection", () => {
  test("maps known extensions", () => {
    expect(languageFor("a.tla")).toBe("tlaplus");
    expect(languageFor("a.qnt")).toBe("quint");
    expect(languageFor("a.py")).toBe("python");
    expect(languageFor("a.rs")).toBe("rust");
    expect(languageFor("a.c")).toBe("c");
    expect(languageFor("a.h")).toBe("c");
    expect(languageFor("a.cpp")).toBe("cpp");
    expect(languageFor("a.java")).toBe("java");
    expect(languageFor("a.ts")).toBe("typescript");
    expect(languageFor("a.js")).toBe("javascript");
    expect(languageFor("a.JSX")).toBe("jsx");
    expect(languageFor("a.sh")).toBe("shellscript");
    expect(languageFor("a.txt")).toBe("plain");
    expect(languageFor("Makefile")).toBe("plain");
  });

  test("reports every supported language", () => {
    expect(supportedLanguages()).toContain("tlaplus");
    expect(supportedLanguages()).toContain("plain");
  });
});

describe("highlighting", () => {
  const cases = [
    "example.tla",
    "example.qnt",
    "example.rs",
    "example.c",
    "example.cpp",
    "example.java",
    "example.ts",
    "example.jsx",
    "example.sh",
    "example.json",
    "example.css",
    "example.html",
    "sample.py",
    "example.txt",
  ];

  const strip = (html: string): string =>
    html
      .replace(/<[^>]*>/g, "")
      .replace(/&#13;/g, "\r")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");

  for (const name of cases) {
    test(`preserves ${name} token text`, async () => {
      const path = join(fixtures, name);
      const source = readSource(path);
      const language = languageFor(path);
      const html = await highlightLines(source, language);
      expect(html).toHaveLength(source.length);
      html.forEach((line, index) => {
        expect(strip(line)).toBe(source[index]!);
      });
      if (language !== "plain") {
        expect(html.join("")).toContain('style="color:');
      } else {
        expect(html.join("")).not.toContain("<span");
      }
    });
  }

  test("tokenizes the whole file so multiline context is preserved", async () => {
    const html = await highlightLines(["const text = `first", "second`;", "value"], "javascript");
    expect(html[0]).toEndWith('<span style="color:#536f37">first</span>');
    expect(html[1]).toStartWith('<span style="color:#536f37">second</span>');
    expect(strip(html[1]!)).toBe("second`;");
  });

  test("keeps carriage returns in CRLF sources", async () => {
    const html = await highlightLines(["let a = 1;\r", "let b = 2;\r"], "javascript");
    expect(strip(html[0]!)).toBe("let a = 1;\r");
    expect(html[0]).toContain("&#13;");
  });

  test("escapes plain text", async () => {
    const html = await highlightLines(["a < b & c"], "plain");
    expect(html[0]).toBe("a &lt; b &amp; c");
  });

  test("rejects languages that were never registered", async () => {
    await expect(highlightLines(["x"], "not-a-language")).rejects.toThrow("unsupported language");
  });
});

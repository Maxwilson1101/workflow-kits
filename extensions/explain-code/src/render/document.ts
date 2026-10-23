import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Note, Walkthrough } from "../types.ts";
import {
  articleLabel,
  filenameLabel,
  noteId,
  noteLabel,
  sectionId,
  scrollLabel,
} from "./contract.ts";
import { escapeAttribute, escapeHtml, renderParagraphs } from "./inline.ts";

const styles = readFileSync(new URL("../assets/styles.css", import.meta.url), "utf8").trim();
const script = readFileSync(new URL("../assets/annotation.js", import.meta.url), "utf8").trim();

export interface RenderInput {
  plan: Walkthrough;
  lines: readonly string[];
  highlighted: readonly string[];
  sourcePath: string;
  language: string;
}

function lineMarkup(number: number, note: Note | undefined, source: string): string {
  const rows = [
    note === undefined
      ? ""
      : `<button type="button" class="note-toggle" aria-label="${escapeAttribute(
          noteLabel(note.title, note.start, note.end),
        )}" aria-expanded="false" aria-controls="${noteId(note.start, note.end)}" data-start="${note.start}" data-end="${note.end}" title="${escapeAttribute(note.title)}"><span aria-hidden="true">▸</span></button>`,
    `<span class="line-number" aria-hidden="true">${number}</span>`,
    `<pre class="source"><code>${source}</code></pre>`,
  ];
  const line = `<div class="line" data-line="${number}">${rows.filter(Boolean).join("")}</div>`;
  if (note === undefined) return line;
  return `${line}<div class="explanation" id="${noteId(note.start, note.end)}" hidden>\n<h3>${escapeHtml(note.title)}</h3>\n${renderParagraphs(note.paragraphs)}\n</div>`;
}

export function renderDocument(input: RenderInput): string {
  const { plan, lines, highlighted, sourcePath, language } = input;
  if (highlighted.length !== lines.length)
    throw new Error("highlighted line count differs from source");
  const filename = basename(sourcePath);
  const title = escapeHtml(plan.title);
  const content = [
    `<header><div class="filename">${escapeHtml(filenameLabel(filename, lines.length))}</div><h1>${title}</h1></header>`,
    `<article aria-label="${escapeAttribute(articleLabel)}" data-language="${escapeAttribute(language)}">`,
    renderParagraphs(plan.intro, "intro"),
  ];
  for (const section of plan.sections) {
    content.push(
      `<section aria-labelledby="${sectionId(section.start)}">`,
      `<h2 id="${sectionId(section.start)}">${escapeHtml(section.title)}</h2>`,
      renderParagraphs(section.intro, "intro"),
      '<div class="code-component">',
      `<div class="code-scroll" role="region" tabindex="0" aria-label="${escapeAttribute(
        scrollLabel(filename, section.start, section.end),
      )}"><div class="code-flow">`,
    );
    const notes = new Map(section.notes.map((note) => [note.end, note]));
    for (let number = section.start; number <= section.end; number += 1) {
      content.push(lineMarkup(number, notes.get(number), highlighted[number - 1]!));
    }
    content.push("</div></div></div></section>");
  }
  content.push("</article>");
  return [
    "<!doctype html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${title}</title>`,
    `<style>${styles}</style>`,
    "</head>",
    "<body>",
    `<main>${content.join("\n")}</main>`,
    `<script>${script}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

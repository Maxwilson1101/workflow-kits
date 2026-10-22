#!/usr/bin/env -S node
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const MARK = "\u0000";
const CJK = "\\u4e00-\\u9fff";
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return NAMED[entity] ?? entity;
  });
}

function prose(body) {
  return decode(body.replace(/<code>[\s\S]*?<\/code>/g, MARK).replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function show(paragraph) {
  return paragraph.replaceAll(MARK, "`…`");
}

function attribute(tag, name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function hasNoteText(body) {
  const title = /<h3[^>]*>([\s\S]*?)<\/h3>/.exec(body);
  const text = /<p[^>]*>([\s\S]*?)<\/p>/.exec(body);
  return Boolean(title && prose(title[1])) && Boolean(text && prose(text[1]));
}

const args = process.argv.slice(2);
let page;
let source;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--source") source = args[++index];
  else if (!page) page = args[index];
}
if (!page) {
  console.error("usage: ./check.mjs <page.html> --source <file>");
  process.exit(2);
}

const html = readFileSync(page, "utf8");
const issues = [];
const fail = (gate, detail) => issues.push({ gate, detail });

const lines = [...html.matchAll(/<div class="line" data-line="(\d+)">([\s\S]*?)<\/div>\n/g)].map(
  (match) => {
    const body = match[2];
    const code = /<pre[^>]*class="source"[^>]*>\s*<code>([\s\S]*?)<\/code><\/pre>/.exec(body);
    if (!code) fail("lines", `line ${match[1]} has no source block`);
    return {
      number: Number(match[1]),
      body,
      text: code ? decode(code[1].replace(/<[^>]+>/g, "")) : "",
    };
  },
);

if (lines.length === 0) fail("lines", "no code lines found");
const numbers = lines.map((line) => line.number);
if (!numbers.every((number, index) => index === 0 || number > numbers[index - 1]))
  fail("lines", `data-line values are not strictly increasing: ${numbers.join(", ")}`);

if (!source) fail("fidelity", "no --source file given");
else {
  const expected = readFileSync(source, "utf8").replace(/\n$/, "").split("\n");
  for (const line of lines) {
    const actual = expected[line.number - 1];
    if (actual === undefined)
      fail("fidelity", `line ${line.number} is outside ${basename(source)}`);
    else if (actual !== line.text)
      fail("fidelity", `line ${line.number} differs from ${basename(source)}`);
  }
}

const toggles = [...html.matchAll(/<button\b[^>]*class="note-toggle"[^>]*>/g)].map(
  (match) => match[0],
);
const explanations = [
  ...html.matchAll(/<div class="explanation" id="([^"]+)"[^>]*>([\s\S]*?)<\/div>/g),
].map((match) => ({ id: match[1], body: match[2] }));
const ids = explanations.map((note) => note.id);
if (new Set(ids).size !== ids.length) fail("annotations", "duplicate explanation id");
if (toggles.length !== explanations.length)
  fail("annotations", `${toggles.length} toggles but ${explanations.length} explanations`);

for (const toggle of toggles) {
  const target = attribute(toggle, "aria-controls");
  const start = Number(attribute(toggle, "data-start"));
  const end = Number(attribute(toggle, "data-end"));
  const owner = lines.find((line) => line.body.includes(toggle));
  if (!target || !ids.includes(target))
    fail("annotations", `toggle points at missing note "${target}"`);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end)
    fail("annotations", `toggle ${target} has invalid range ${start}–${end}`);
  if (!owner) fail("annotations", `toggle ${target} is not on a code line`);
  else if (owner.number !== start)
    fail("annotations", `toggle ${target} sits on line ${owner.number}, not ${start}`);
  if (!numbers.includes(end))
    fail("annotations", `toggle ${target} ends on line ${end}, which is not shown`);
}

for (const note of explanations)
  if (!hasNoteText(note.body)) fail("annotations", `note ${note.id} has no title or text`);

const headings = [...html.matchAll(/<h([23])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((match) =>
  prose(match[2]),
);
if (!/<main\b/.test(html)) fail("headings", "missing <main>");
if ((html.match(/<h1\b/g) ?? []).length !== 1) fail("headings", "expected exactly one <h1>");
for (const heading of headings) {
  if (!heading) fail("headings", "empty heading");
  else if (!new RegExp(`[${CJK}]`).test(heading))
    fail("headings", `heading is not Chinese: ${heading}`);
  if (/[，。、；：！？,.;:]$/.test(heading))
    fail("headings", `heading ends with punctuation: ${heading}`);
}

const paragraphs = [...html.matchAll(/<(h[123]|p)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((match) =>
  prose(match[2]),
);

const spacingRules = [
  [new RegExp(`[${CJK}][A-Za-z0-9]`), "missing space before Latin text"],
  [new RegExp(`[A-Za-z0-9][${CJK}]`), "missing space after Latin text"],
  [new RegExp(`[${CJK}]${MARK}`), "missing space before inline code"],
  [new RegExp(`${MARK}[${CJK}]`), "missing space after inline code"],
  [/\s[，。、；：！？）】》]/, "space before Chinese punctuation"],
  [/[，。、；：！？]\s/, "space after Chinese punctuation"],
  [/[（《【]\s/, "space after Chinese bracket"],
  [/\s[（《【]/, "space before Chinese bracket"],
];

for (const paragraph of paragraphs) {
  if (!new RegExp(`[${CJK}]`).test(paragraph))
    fail("prose", `paragraph is not Chinese: ${show(paragraph).slice(0, 40)}`);
  for (const [rule, message] of spacingRules) {
    const match = rule.exec(paragraph);
    if (!match) continue;
    const from = Math.max(0, match.index - 12);
    fail("spacing", `${message}: "${show(paragraph.slice(from, match.index + 14))}"`);
  }
}

const offlineRules = [
  [/<link\b/i, "external link element"],
  [/@import\b/, "CSS @import"],
  [/\bsrc="(?:https?:)?\/\//i, "external src"],
  [/url\((?:'|")?(?:https?:)?\/\//i, "external url()"],
];
for (const [rule, message] of offlineRules) if (rule.test(html)) fail("offline", message);

const gates = ["lines", "fidelity", "annotations", "headings", "prose", "spacing", "offline"];
for (const gate of gates) {
  const found = issues.filter((issue) => issue.gate === gate);
  console.log(`${gate.padEnd(12)}${found.length ? `FAIL ${found.length}` : "ok"}`);
  for (const issue of found) console.log(`  ${issue.detail}`);
}
console.log(
  `\n${lines.length} lines, ${toggles.length} notes, ${headings.length} headings, ${paragraphs.length} paragraphs`,
);
process.exit(issues.length === 0 ? 0 : 1);

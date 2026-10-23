import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArtifact } from "../src/e2e/check.ts";
import { highlightLines, languageFor } from "../src/render/highlight.ts";
import { renderDocument } from "../src/render/document.ts";
import type { Walkthrough } from "../src/types.ts";
import { readPlan, readSource } from "../src/plan/parse.ts";

const fixtures = join(import.meta.dir, "fixtures");
const sourcePath = join(fixtures, "sample.py");
const lines = readSource(sourcePath);
const plan = JSON.parse(readFileSync(join(fixtures, "sample.plan.json"), "utf8")) as Walkthrough;

let workspace: string;
let htmlPath: string;
let html: string;

beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), "explain-code-artifact-"));
  const highlighted = await highlightLines(lines, languageFor(sourcePath));
  html = renderDocument({
    plan,
    lines,
    highlighted,
    sourcePath,
    language: languageFor(sourcePath),
  });
  htmlPath = join(workspace, "sample.html");
  writeFileSync(htmlPath, html, "utf8");
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function expectRejection(
  mutate: (markup: string) => string,
  expected: string,
): Promise<void> {
  const broken = join(workspace, `broken-${Math.abs(expected.length)}-${Date.now()}.html`);
  writeFileSync(broken, mutate(html), "utf8");
  let failure: unknown;
  try {
    await validateArtifact({ htmlPath: broken, sourcePath, plan, lines, language: "python" });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain(expected);
}

describe("artifact validation", () => {
  test("accepts the reference artifact", async () => {
    await validateArtifact({ htmlPath, sourcePath, plan, lines, language: "python" });
  }, 120_000);

  test("rejects a changed source line", async () => {
    await expectRejection(
      (markup) => markup.replace(" result</span></code>", " resu7t</span></code>"),
      "source differs on line",
    );
  }, 120_000);

  test("rejects a button that starts expanded", async () => {
    await expectRejection(
      (markup) =>
        markup.replace(
          'aria-expanded="false" aria-controls="note-3-5"',
          'aria-expanded="true" aria-controls="note-3-5"',
        ),
      "button must start collapsed",
    );
  }, 120_000);

  test("rejects a detached explanation", async () => {
    await expectRejection(
      (markup) =>
        markup.replace(
          '<div class="explanation" id="note-3-5" hidden>',
          '<div class="note-ghost" id="note-3-5" hidden>',
        ),
      "explanation count differs",
    );
  }, 120_000);

  test("rejects an expanded explanation by default", async () => {
    await expectRejection(
      (markup) =>
        markup.replace(
          '<div class="explanation" id="note-3-5" hidden>',
          '<div class="explanation" id="note-3-5">',
        ),
      "explanation must start collapsed",
    );
  }, 120_000);

  test("rejects changed explanation text", async () => {
    await expectRejection((markup) => markup.replace("只有", "仅有"), "text differs");
  }, 120_000);

  test("rejects external resources", async () => {
    await expectRejection(
      (markup) =>
        markup.replace(
          "<body>",
          '<body><link rel="stylesheet" href="https://example.com/style.css">',
        ),
      "external resources",
    );
  }, 120_000);

  test("rejects duplicate ids", async () => {
    await expectRejection(
      (markup) => markup.replace("<h1>", '<h1 id="section-1">'),
      "duplicate element ids",
    );
  }, 120_000);

  test("rejects a page whose interactions are broken", async () => {
    await expectRejection(
      (markup) => markup.replace('button.setAttribute("aria-expanded", String(expanded));', ""),
      "click did not expand",
    );
  }, 120_000);
});

describe("artifact boundaries", () => {
  test("rejects an incorrect browser tab title", async () => {
    await expectRejection(
      (markup) => markup.replace(/<title>.*?<\/title>/, "<title>错误标题</title>"),
      "page title differs",
    );
  }, 120_000);

  test("rejects extra explanations outside source sections", async () => {
    await expectRejection(
      (markup) =>
        markup.replace("</main>", '<div class="explanation" hidden>额外说明</div></main>'),
      "explanation count differs",
    );
  }, 120_000);

  test("blocks requests before they reach a server", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++;
        return new Response("unexpected request");
      },
    });
    try {
      await expectRejection(
        (markup) =>
          markup.replace(
            "<script>",
            `<script>fetch(${JSON.stringify(server.url.href)}).catch(() => {});`,
          ),
        "external requests",
      );
      expect(requests).toBe(0);
    } finally {
      server.stop(true);
    }
  }, 120_000);

  test("rejects highlighting outside the selected range", async () => {
    await expectRejection(
      (markup) =>
        markup.replace(
          "const active =",
          'document.querySelector(".line[data-line=\\\"6\\\"]").classList.add("is-highlighted"); const active =',
        ),
      "unrelated lines",
    );
  }, 120_000);

  test("preserves unknown-language CRLF text in the browser", async () => {
    const source = ["first\r", "second\r"];
    const simple: Walkthrough = {
      title: "纯文本",
      intro: ["保留原始字符。"],
      sections: [{ start: 1, end: 2, title: "原文", intro: ["展示两行内容。"], notes: [] }],
    };
    const path = join(workspace, "crlf.html");
    writeFileSync(
      path,
      renderDocument({
        plan: simple,
        lines: source,
        highlighted: await highlightLines(source, "plain"),
        sourcePath: "crlf.txt",
        language: "plain",
      }),
    );
    await validateArtifact({
      htmlPath: path,
      sourcePath: "crlf.txt",
      plan: simple,
      lines: source,
      language: "plain",
    });
  }, 120_000);

  test("rejects a cancelled validation before launching the browser", async () => {
    await expect(
      validateArtifact({
        htmlPath,
        sourcePath,
        plan,
        lines,
        language: "python",
        signal: AbortSignal.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
  });
});

describe("layout contract", () => {
  test("keeps long source lines inside the scrolling container", async () => {
    const longLine = `const value = "${"x".repeat(400)}";`;
    const longSource = join(workspace, "long.ts");
    writeFileSync(longSource, `${longLine}\n`, "utf8");
    const longPlan: Walkthrough = {
      title: "长行示例",
      intro: ["源码行很长，页面不应横向溢出。"],
      sections: [
        {
          start: 1,
          end: 1,
          title: "长字符串",
          intro: ["单个语句在窄屏下横向滚动。"],
          notes: [
            {
              start: 1,
              end: 1,
              title: "字符串字面量",
              paragraphs: ["`value` 保存一段很长的字符串。"],
            },
          ],
        },
      ],
    };
    const source = readSource(longSource);
    expect(readPlan(JSON.stringify(longPlan), source.length).diagnostics).toEqual([]);
    const highlighted = await highlightLines(source, "typescript");
    const path = join(workspace, "long.html");
    writeFileSync(
      path,
      renderDocument({
        plan: longPlan,
        lines: source,
        highlighted,
        sourcePath: longSource,
        language: "typescript",
      }),
      "utf8",
    );
    await validateArtifact({
      htmlPath: path,
      sourcePath: longSource,
      plan: longPlan,
      lines: source,
      language: "typescript",
    });
  }, 120_000);
});

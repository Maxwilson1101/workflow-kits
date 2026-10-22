import { describe, expect, test } from "bun:test";
import { parsePage } from "../src/parse.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const url = "https://example.com/docs/start";

describe("page parsing", () => {
  test("preserves headings, fenced code, tables and absolute links", () => {
    const result = parsePage(
      bytes(`
      <html><head><title>Reference</title><style>hidden-style</style></head>
      <body><nav>outside-navigation</nav><main>
        <h1>API</h1><p><a href="../guide">Guide</a><img src="/image.png" alt="Diagram"></p>
        <pre><code class="language-ts">const n = 1;</code></pre>
        <table><thead><tr><th>Name</th><th>Type</th></tr></thead>
        <tbody><tr><td>id</td><td>string</td></tr></tbody></table>
        <script>hidden-script</script><noscript>hidden-noscript</noscript>
      </main></body></html>`),
      "text/html; charset=utf-8",
      url,
    );
    expect(result.title).toBe("Reference");
    expect(result.content).toContain("# API");
    expect(result.content).toContain("[Guide](https://example.com/guide)");
    expect(result.content).toContain("![Diagram](https://example.com/image.png)");
    expect(result.content).toContain("```ts");
    expect(result.content).toContain("const n = 1;");
    expect(result.content).toMatch(/\|\s*Name\s*\|\s*Type\s*\|/);
    expect(result.content).not.toContain("outside-navigation");
    expect(result.content).not.toContain("hidden-");
  });

  test("falls back to article, then body, without requiring a full HTML document", () => {
    expect(
      parsePage(bytes("<article><p>Article text</p></article>"), "text/html", url).content,
    ).toContain("Article text");
    expect(parsePage(bytes("<p>Body text</p>"), "text/html", url).content).toContain("Body text");
  });

  test("resolves base URLs and removes unsafe link schemes", () => {
    const result = parsePage(
      bytes(
        '<html><head><base href="/reference/"></head><body><a href="next">Next</a><a href="javascript:alert(1)">Unsafe</a></body></html>',
      ),
      "text/html",
      url,
    );
    expect(result.content).toContain("https://example.com/reference/next");
    expect(result.content).not.toContain("javascript:");
    expect(result.content).toContain("Unsafe");
  });

  for (const type of ["text/plain", "text/markdown", "text/x-markdown"]) {
    test(`preserves ${type} directly`, () => {
      const content = "# Text\n\nOriginal content.\n";
      expect(parsePage(bytes(content), type, url).content).toBe(content);
    });
  }

  test("decodes declared non-UTF-8 character sets", () => {
    const result = parsePage(
      new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
      "text/plain; charset=windows-1252",
      url,
    );
    expect(result.content).toBe("café");
  });

  test("rejects binary or unspecified content types and empty pages", () => {
    for (const type of ["application/pdf", "image/png", "application/octet-stream", ""]) {
      expect(() => parsePage(bytes("data"), type, url)).toThrow("content type");
    }
    expect(() => parsePage(bytes("<script>only JS</script>"), "text/html", url)).toThrow(
      "readable content",
    );
  });
});

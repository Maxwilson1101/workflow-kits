import { TextDecoder } from "node:util";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ParsedPage {
  title: string;
  content: string;
}

export function parsePage(body: Uint8Array, contentType: string, finalUrl: string): ParsedPage {
  const type = contentType.split(";", 1)[0]!.trim().toLowerCase();
  if (
    ![
      "text/html",
      "application/xhtml+xml",
      "text/plain",
      "text/markdown",
      "text/x-markdown",
    ].includes(type)
  ) {
    throw new Error(`Unsupported web content type: ${type || "missing"}.`);
  }
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] ?? "utf-8";
  const source = new TextDecoder(charset).decode(body);
  if (!["text/html", "application/xhtml+xml"].includes(type)) {
    if (!source.trim()) throw new Error("Page contains no readable content.");
    return { title: finalUrl, content: source };
  }

  const html = /<(?:html|head|body)(?:\s|>)/i.test(source)
    ? source
    : `<html><head></head><body>${source}</body></html>`;
  const { document } = parseHTML(html);
  const title =
    document.querySelector("title")?.textContent?.trim() ||
    document.querySelector("h1")?.textContent?.trim() ||
    finalUrl;
  let base = finalUrl;
  const baseHref = document.querySelector("base[href]")?.getAttribute("href");
  if (baseHref) {
    try {
      const candidate = new URL(baseHref, finalUrl);
      if (["http:", "https:"].includes(candidate.protocol)) base = candidate.href;
    } catch {}
  }
  for (const node of document.querySelectorAll(
    "script, style, noscript, template, iframe, object, embed, base, svg",
  )) {
    node.remove();
  }
  for (const node of document.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.toLowerCase().startsWith("on") || attribute.name === "srcset") {
        node.removeAttribute(attribute.name);
      }
    }
    for (const attribute of ["href", "src"]) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      try {
        const absolute = new URL(value, base);
        const allowed =
          attribute === "href" ? ["http:", "https:", "mailto:", "tel:"] : ["http:", "https:"];
        if (!allowed.includes(absolute.protocol) || absolute.username || absolute.password) {
          node.removeAttribute(attribute);
        } else {
          node.setAttribute(attribute, absolute.href);
        }
      } catch {
        node.removeAttribute(attribute);
      }
    }
  }

  const root = document.querySelector("main") ?? document.querySelector("article") ?? document.body;
  const converter = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  converter.use(gfm);
  const content = converter.turndown(root.innerHTML).trim();
  if (!content)
    throw new Error(
      "Page contains no readable content; it may require JavaScript or authentication.",
    );
  return { title, content };
}

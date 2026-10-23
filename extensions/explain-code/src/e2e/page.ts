interface BrowserAttributes {
  length: number;
  [index: number]: { name: string; value: string };
}

interface BrowserClassList {
  contains(name: string): boolean;
}

interface BrowserElement {
  id: string;
  scrollWidth: number;
  textContent: string | null;
  attributes: BrowserAttributes;
  classList: BrowserClassList;
  nextElementSibling: BrowserElement | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
  blur(): void;
}

interface BrowserDocument {
  activeElement: BrowserElement | null;
  documentElement: BrowserElement;
  scripts: { length: number };
  querySelector(selector: string): BrowserElement | null;
  querySelectorAll(selector: string): BrowserElement[];
}

declare const document: BrowserDocument;
declare const window: { innerWidth: number };
declare function getComputedStyle(element: BrowserElement): { overflowX: string };

export interface Prose {
  text: string;
  codes: string[];
}

export interface ButtonSnapshot {
  start: string | null;
  end: string | null;
  controls: string | null;
  expanded: string | null;
  label: string | null;
  title: string | null;
}

export interface NoteSnapshot {
  id: string | null;
  hidden: boolean;
  heading: string;
  paragraphs: Prose[];
}

export interface LineSnapshot {
  number: number;
  source: string;
  syntaxSpans: number;
  button: ButtonSnapshot | null;
  note: NoteSnapshot | null;
}

export interface SectionSnapshot {
  id: string | null;
  heading: string;
  intro: Prose[];
  lines: LineSnapshot[];
}

export interface PageSnapshot {
  title: string;
  documentTitle: string;
  noteCount: number;
  filename: string;
  language: string | null;
  articleLabel: string | null;
  intro: Prose[];
  scripts: number;
  ids: string[];
  resources: number;
  handlers: string[];
  sections: SectionSnapshot[];
}

export interface StaticSnapshot {
  numbers: number[];
  sources: string[];
  spans: number;
  collapsedNotes: boolean[];
}

export interface LayoutSnapshot {
  documentOverflow: number;
  scrollerOverflowX: string[];
  highlightedInRange: number;
  highlightedTotal: number;
}

export function readPage(): PageSnapshot {
  const prose = (element: BrowserElement): Prose => ({
    text: element.textContent ?? "",
    codes: [...element.querySelectorAll("code")].map((code) => code.textContent ?? ""),
  });
  const children = (root: BrowserElement | null, selector: string): Prose[] =>
    root ? [...root.querySelectorAll(`:scope > ${selector}`)].map(prose) : [];
  const article = document.querySelector("article");
  return {
    title: document.querySelector("h1")?.textContent ?? "",
    documentTitle: document.querySelector("title")?.textContent ?? "",
    noteCount: document.querySelectorAll(".explanation").length,
    filename: document.querySelector(".filename")?.textContent ?? "",
    language: article?.getAttribute("data-language") ?? null,
    articleLabel: article?.getAttribute("aria-label") ?? null,
    intro: children(article, "p.intro"),
    scripts: document.scripts.length,
    ids: [...document.querySelectorAll("[id]")].map((element) => element.id),
    resources: document.querySelectorAll("link, img, iframe, object, embed, video, audio, source")
      .length,
    handlers: [...document.querySelectorAll("*")].flatMap((element) => {
      const names: string[] = [];
      for (let index = 0; index < element.attributes.length; index += 1) {
        names.push(element.attributes[index]!.name);
      }
      return names.filter((name) => name.startsWith("on"));
    }),
    sections: [...document.querySelectorAll("article section")].map((section) => ({
      id: section.getAttribute("aria-labelledby"),
      heading: section.querySelector("h2")?.textContent ?? "",
      intro: children(section, "p.intro"),
      lines: [...section.querySelectorAll(".line")].map((row) => {
        const source = row.querySelector("pre.source");
        const button = row.querySelector(".note-toggle");
        const sibling = row.nextElementSibling;
        const note = sibling?.classList.contains("explanation") === true ? sibling : null;
        return {
          number: Number(row.getAttribute("data-line")),
          source: source?.textContent ?? "",
          syntaxSpans: source ? source.querySelectorAll('span[style*="color"]').length : 0,
          button: button
            ? {
                start: button.getAttribute("data-start"),
                end: button.getAttribute("data-end"),
                controls: button.getAttribute("aria-controls"),
                expanded: button.getAttribute("aria-expanded"),
                label: button.getAttribute("aria-label"),
                title: button.getAttribute("title"),
              }
            : null,
          note: note
            ? {
                id: note.getAttribute("id"),
                hidden: note.hasAttribute("hidden"),
                heading: note.querySelector("h3")?.textContent ?? "",
                paragraphs: children(note, "p"),
              }
            : null,
        };
      }),
    })),
  };
}

export function readLayout(range: number[]): LayoutSnapshot {
  const highlighted = [...document.querySelectorAll(".line.is-highlighted")].map((row) =>
    Number(row.getAttribute("data-line")),
  );
  return {
    documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
    scrollerOverflowX: [...document.querySelectorAll(".code-scroll")].map(
      (element) => getComputedStyle(element).overflowX,
    ),
    highlightedInRange: highlighted.filter((number) => number >= range[0]! && number <= range[1]!)
      .length,
    highlightedTotal: highlighted.length,
  };
}

export function readStatic(): StaticSnapshot {
  return {
    numbers: [...document.querySelectorAll(".line")].map((row) =>
      Number(row.getAttribute("data-line")),
    ),
    sources: [...document.querySelectorAll("pre.source")].map(
      (element) => element.textContent ?? "",
    ),
    spans: document.querySelectorAll('pre.source span[style*="color"]').length,
    collapsedNotes: [...document.querySelectorAll(".explanation")].map((element) =>
      element.hasAttribute("hidden"),
    ),
  };
}

export function blurActive(): void {
  document.activeElement?.blur();
}

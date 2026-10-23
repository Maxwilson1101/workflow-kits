import { readFileSync } from "node:fs";
import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
  type ThemeRegistration,
} from "shiki";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { escapeHtml } from "./inline.ts";

export const THEME_NAME = "walkthrough-light";
export const PLAIN_LANGUAGE = "plain";

const theme: ThemeRegistration = {
  name: THEME_NAME,
  type: "light",
  colors: { "editor.background": "#f0f0e9", "editor.foreground": "#303630" },
  settings: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#747d70" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#825c7b" } },
    { scope: ["string"], settings: { foreground: "#536f37" } },
    {
      scope: ["constant.numeric", "constant.language", "variable.other.constant"],
      settings: { foreground: "#985a35" },
    },
    {
      scope: ["entity.name.function", "support.function", "entity.name.tag"],
      settings: { foreground: "#316c82" },
    },
    {
      scope: ["entity.name.type", "support.type", "support.class"],
      settings: { foreground: "#725b32" },
    },
    { scope: ["punctuation", "keyword.operator"], settings: { foreground: "#687067" } },
    {
      scope: ["variable.other.property", "entity.other.attribute-name"],
      settings: { foreground: "#41665d" },
    },
  ],
};

const fontSize: readonly (readonly [number, string])[] = [
  [1, "font-style:italic"],
  [2, "font-weight:700"],
  [4, "text-decoration:underline"],
];

const extensions: Readonly<Record<string, string>> = {
  ".tla": "tlaplus",
  ".qnt": "quint",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".pyi": "python",
  ".json": "json",
  ".sh": "shellscript",
  ".bash": "shellscript",
  ".zsh": "shellscript",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".java": "java",
};

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

const bundled: Readonly<Record<string, LanguageLoader>> = {
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  python: () => import("@shikijs/langs/python"),
  json: () => import("@shikijs/langs/json"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  xml: () => import("@shikijs/langs/xml"),
  rust: () => import("@shikijs/langs/rust"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  java: () => import("@shikijs/langs/java"),
};

function readGrammar(name: string): LanguageRegistration {
  return JSON.parse(
    readFileSync(new URL(`../assets/grammars/${name}.json`, import.meta.url), "utf8"),
  );
}

const grammars: LanguageRegistration[] = [
  { ...readGrammar("tlaplus"), name: "tlaplus" },
  { ...readGrammar("pluscal"), name: "pluscal" },
  { ...readGrammar("quint"), name: "quint" },
];

let highlighterPromise: Promise<HighlighterCore> | undefined;

function highlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    langs: grammars,
    themes: [theme],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
  return highlighterPromise;
}

export function languageFor(path: string): string {
  const name = path.slice(path.lastIndexOf(".")).toLowerCase();
  return extensions[name] ?? PLAIN_LANGUAGE;
}

export function supportedLanguages(): string[] {
  return [...Object.values(extensions), PLAIN_LANGUAGE].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
}

async function loaded(core: HighlighterCore, language: string): Promise<void> {
  if (core.getLoadedLanguages().includes(language)) return;
  const loader = bundled[language];
  if (!loader) throw new Error(`unsupported language: ${language}`);
  await core.loadLanguage(await loader());
}

function renderToken(token: ThemedToken): string {
  const color = token.color ?? theme.colors?.["editor.foreground"];
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(color)) {
    throw new Error(`highlight: invalid token color ${JSON.stringify(color)}`);
  }
  const style = token.fontStyle ?? 0;
  if (!Number.isInteger(style) || style < 0 || style > 7) {
    throw new Error(`highlight: unsupported font style ${style}`);
  }
  const declarations = [
    `color:${color.toLowerCase()}`,
    ...fontSize.filter(([bit]) => style & bit).map(([, css]) => css),
  ];
  const value = escapeHtml(token.content);
  return `<span style="${declarations.join(";")}">${value}</span>`;
}

export async function highlightLines(
  lines: readonly string[],
  language: string,
): Promise<string[]> {
  if (language === PLAIN_LANGUAGE) return lines.map(escapeHtml);
  const core = await highlighter();
  await loaded(core, language);
  const normalized = lines
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .join("\n");
  const rows = core.codeToTokensBase(normalized, { lang: language, theme: THEME_NAME });
  if (rows.length !== lines.length) {
    throw new Error(`highlight: tokenized ${rows.length} lines instead of ${lines.length}`);
  }
  return rows.map((row, index) => {
    const html = row.map(renderToken).join("");
    const source = lines[index] ?? "";
    const restored = row
      .map((token) => token.content)
      .join("")
      .concat(source.endsWith("\r") ? "\r" : "");
    if (restored !== source) throw new Error(`highlight: token text differs on line ${index + 1}`);
    return source.endsWith("\r") ? `${html}<span style="color:#303630">&#13;</span>` : html;
  });
}

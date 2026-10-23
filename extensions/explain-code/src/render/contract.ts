export const SELECTORS = {
  article: "article",
  section: "article section",
  heading: "h2",
  filename: ".filename",
  line: ".line",
  source: "pre.source",
  toggle: ".note-toggle",
  explanation: ".explanation",
  scroller: ".code-scroll",
} as const;

export const noteId = (start: number, end: number): string => `note-${start}-${end}`;

export const sectionId = (start: number): string => `section-${start}`;

export const rangeLabel = (start: number, end: number): string =>
  start === end ? `第 ${start} 行` : `第 ${start} 至 ${end} 行`;

export const noteLabel = (title: string, start: number, end: number): string =>
  `${title}，${rangeLabel(start, end)}`;

export const filenameLabel = (filename: string, count: number): string =>
  `${filename} · ${count} 行`;

export const scrollLabel = (filename: string, start: number, end: number): string =>
  `${filename}，${rangeLabel(start, end)}`;

export const articleLabel = "源码与行内讲解";

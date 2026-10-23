export interface Note {
  start: number;
  end: number;
  title: string;
  paragraphs: string[];
}

export interface Section {
  start: number;
  end: number;
  title: string;
  intro: string[];
  notes: Note[];
}

export interface Walkthrough {
  title: string;
  intro: string[];
  sections: Section[];
}

export interface Diagnostic {
  path: string;
  message: string;
}

export interface PreparedSource {
  path: string;
  filename: string;
  lines: readonly string[];
  language: string;
}

export class InvalidPlan extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("\n"));
  }
}

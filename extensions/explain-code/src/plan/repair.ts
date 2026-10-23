import type { Diagnostic, Note, Section, Walkthrough } from "../types.ts";

type Record_ = Record<string, unknown>;

export interface Coerced {
  plan?: Walkthrough;
  repaired: string[];
  missing: Diagnostic[];
}

const isRecord = (value: unknown): value is Record_ =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : undefined;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

function lineRange(start: unknown, end: unknown, count: number): [number, number] | undefined {
  if (typeof start !== "number" || !Number.isFinite(start)) return undefined;
  if (typeof end !== "number" || !Number.isFinite(end)) return undefined;
  const low = clamp(Math.round(start), 1, count);
  const high = clamp(Math.round(end), 1, count);
  return low <= high ? [low, high] : [high, low];
}

function notes(value: unknown, section: readonly [number, number], repaired: string[]): Note[] {
  if (!Array.isArray(value)) {
    repaired.push("notes: dropped a value that is not an array");
    return [];
  }
  const kept: Note[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      repaired.push(`notes[${index}]: dropped a value that is not an object`);
      return;
    }
    const range = lineRange(entry.start, entry.end, Number.MAX_SAFE_INTEGER);
    const title = text(entry.title);
    const paragraphs = texts(entry.paragraphs);
    if (!range || !title || !paragraphs || paragraphs.length === 0) {
      repaired.push(`notes[${index}]: dropped an incomplete note`);
      return;
    }
    const start = clamp(range[0], section[0], section[1]);
    const end = clamp(range[1], section[0], section[1]);
    if (start !== range[0] || end !== range[1])
      repaired.push(`notes[${index}]: clamped ${range[0]}–${range[1]} to ${start}–${end}`);
    kept.push({ start, end, title, paragraphs });
  });
  kept.sort((left, right) => left.start - right.start);
  const ordered: Note[] = [];
  for (const note of kept) {
    const previous = ordered[ordered.length - 1];
    if (previous && note.start <= previous.end) {
      const start = previous.end + 1;
      if (start > note.end) {
        repaired.push(`note ${note.start}–${note.end}: dropped after overlap repair`);
        continue;
      }
      repaired.push(`note ${note.start}–${note.end}: start moved to ${start}`);
      note.start = start;
    }
    ordered.push(note);
  }
  return ordered;
}

function sections(value: unknown, count: number, repaired: string[]): Section[] {
  if (!Array.isArray(value)) {
    repaired.push("sections: dropped a value that is not an array");
    return [];
  }
  const kept: Section[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      repaired.push(`sections[${index}]: dropped a value that is not an object`);
      return;
    }
    const range = lineRange(entry.start, entry.end, count);
    const title = text(entry.title);
    const intro = texts(entry.intro);
    if (!range || !title || !intro || intro.length === 0) {
      repaired.push(`sections[${index}]: dropped an incomplete section`);
      return;
    }
    if (range[0] !== entry.start || range[1] !== entry.end)
      repaired.push(
        `sections[${index}]: clamped ${String(entry.start)}–${String(entry.end)} to ${range[0]}–${range[1]}`,
      );
    kept.push({
      start: range[0],
      end: range[1],
      title,
      intro,
      notes: notes(entry.notes, range, repaired),
    });
  });
  kept.sort((left, right) => left.start - right.start);
  const ordered: Section[] = [];
  for (const section of kept) {
    const previous = ordered[ordered.length - 1];
    if (previous && section.start <= previous.end) {
      const start = previous.end + 1;
      if (start > section.end) {
        repaired.push(`section ${section.start}–${section.end}: dropped after overlap repair`);
        continue;
      }
      repaired.push(`section ${section.start}–${section.end}: start moved to ${start}`);
      section.start = start;
      section.notes = section.notes
        .filter((note) => note.start >= start)
        .map((note) => ({ ...note, start: Math.max(note.start, start) }));
    }
    ordered.push(section);
  }
  ordered.forEach((section, index) => {
    if (index === 0 && section.start > 1) {
      repaired.push(`section 1: start moved from ${section.start} to 1`);
      section.start = 1;
    }
    const previous = ordered[index - 1];
    if (previous && section.start > previous.end + 1) {
      repaired.push(
        `section ${previous.start}: end extended from ${previous.end} to ${section.start - 1}`,
      );
      previous.end = section.start - 1;
    }
  });
  const last = ordered[ordered.length - 1];
  if (last && last.end < count) {
    repaired.push(`section ${last.start}: end extended from ${last.end} to ${count}`);
    last.end = count;
  }
  return ordered;
}

export function coercePlan(value: unknown, count: number): Coerced {
  const missing: Diagnostic[] = [];
  if (!isRecord(value))
    return { repaired: [], missing: [{ path: "plan", message: "expected a JSON object" }] };
  const repaired: string[] = [];
  const title = text(value.title);
  const intro = texts(value.intro);
  const body = sections(value.sections, count, repaired);
  if (value.excerpt !== undefined) repaired.push("excerpt: removed");
  for (const key of Object.keys(value))
    if (!["title", "intro", "sections", "excerpt"].includes(key))
      repaired.push(`${key}: removed an unknown field`);
  if (!title) missing.push({ path: "plan.title", message: "expected nonempty text" });
  if (!intro || intro.length === 0)
    missing.push({ path: "plan.intro", message: "expected nonempty paragraphs" });
  if (body.length === 0)
    missing.push({ path: "plan.sections", message: "expected a nonempty array" });
  if (!title || !intro || intro.length === 0 || body.length === 0) return { repaired, missing };
  return { plan: { title, intro, sections: body }, repaired, missing };
}

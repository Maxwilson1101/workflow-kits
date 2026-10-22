import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Request } from "./client.ts";

export function validateId(id: string) {
  if (
    typeof id !== "string" ||
    !/^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})(?:v[1-9]\d*)?$/.test(id)
  ) {
    throw new Error(
      "id must be an arXiv identifier, optionally including a version; not a URL or path.",
    );
  }
  return id;
}

export interface SearchInput {
  q: string;
  start?: number;
  limit?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid arXiv Atom response.");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid arXiv metadata.");
  return value.replace(/\s+/g, " ").trim();
}

export async function searchArxiv(input: SearchInput, request: Request, signal?: AbortSignal) {
  if (typeof input.q !== "string" || !input.q.trim() || input.q.length > 2000)
    throw new Error("q must contain 1–2000 characters.");
  const start = input.start ?? 0;
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(start) || start < 0 || start > 30000)
    throw new Error("start must be between 0 and 30000.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("limit must be between 1 and 100.");
  signal?.throwIfAborted();
  const params = new URLSearchParams({
    search_query: input.q.trim(),
    start: String(start),
    max_results: String(limit),
  });
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(
    await request(`https://export.arxiv.org/api/query?${params}`, signal),
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new Error("Invalid arXiv XML response.");
  const parser = new XMLParser({
    removeNSPrefix: true,
    parseTagValue: false,
    isArray: (name: string) => name === "entry" || name === "author",
  });
  const data = object(object(parser.parse(xml)).feed);
  const entries = data.entry ?? [];
  if (!Array.isArray(entries) || entries.length > limit) throw new Error("Invalid arXiv entries.");
  const papers = entries.map((item: unknown) => {
    const entry = object(item);
    const url = new URL(text(entry.id));
    if (url.pathname === "/api/errors") throw new Error(`arXiv API error: ${text(entry.summary)}`);
    if (url.hostname !== "arxiv.org" || !url.pathname.startsWith("/abs/"))
      throw new Error("Invalid arXiv article URL.");
    const id = validateId(url.pathname.slice(5));
    if (!Array.isArray(entry.author) || !entry.author.length)
      throw new Error("Invalid arXiv authors.");
    return {
      id,
      title: text(entry.title),
      authors: entry.author.map((author: unknown) => text(object(author).name)),
      summary: text(entry.summary),
      published: text(entry.published),
      updated: text(entry.updated),
    };
  });
  const rawTotal = text(data.totalResults);
  const total = Number(rawTotal);
  if (!/^\d+$/.test(rawTotal) || !Number.isSafeInteger(total))
    throw new Error("Invalid arXiv result count.");
  return { total, start, papers };
}

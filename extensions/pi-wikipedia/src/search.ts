import { parse } from "node-html-parser";
import { object, text, type Request } from "./client.ts";

export interface SearchInput {
  q: string;
  limit?: number;
}

export async function searchWikipedia(input: SearchInput, request: Request, signal?: AbortSignal) {
  if (typeof input.q !== "string" || !input.q.trim() || input.q.length > 500) {
    throw new Error("q must contain 1–500 characters.");
  }
  const limit = input.limit ?? 5;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be between 1 and 100.");
  }
  signal?.throwIfAborted();
  const query = new URLSearchParams({ q: input.q.trim(), limit: String(limit) });
  const data = object(await request(`/search/page?${query}`, signal));
  if (!Array.isArray(data.pages) || data.pages.length > limit) {
    throw new Error("Invalid Wikipedia search results.");
  }
  return {
    pages: data.pages.map((item) => {
      const page = object(item);
      return {
        title: text(page.key, "page key"),
        description: page.description === null ? null : text(page.description, "description"),
        excerpt: parse(text(page.excerpt, "excerpt")).textContent,
      };
    }),
  };
}

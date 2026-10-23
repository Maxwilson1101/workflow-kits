import { readFileSync } from "node:fs";
import { parseTree, type Node, type ParseError } from "jsonc-parser";
import type { Diagnostic, Walkthrough } from "../types.ts";
import { coercePlan } from "./repair.ts";
import { validateStructure } from "./rules.ts";

export interface ParsedPlan {
  plan?: Walkthrough;
  repaired: string[];
  diagnostics: Diagnostic[];
}

export function readSource(path: string): string[] {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    readFileSync(path),
  );
  if (text.includes("\0")) throw new Error("source contains a NUL character");
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n");
}

function toValue(node: Node): unknown {
  switch (node.type) {
    case "object": {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.children ?? []) {
        const key = property.children?.[0];
        const value = property.children?.[1];
        if (!key || !value) continue;
        result[String(key.value)] = toValue(value);
      }
      return result;
    }
    case "array":
      return (node.children ?? []).map(toValue);
    default:
      return node.value;
  }
}

function duplicates(node: Node, path: string, found: Diagnostic[]): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0];
      const value = property.children?.[1];
      if (!key || !value) continue;
      const name = String(key.value);
      if (seen.has(name)) found.push({ path: `${path}.${name}`, message: "duplicate key" });
      seen.add(name);
      duplicates(value, `${path}.${name}`, found);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((child, index) => duplicates(child, `${path}[${index}]`, found));
  }
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const body = trimmed.slice(trimmed.indexOf("\n") + 1);
  return body.endsWith("```") ? body.slice(0, body.lastIndexOf("```")).trim() : body.trim();
}

function syntax(errors: readonly ParseError[], text: string): Diagnostic[] {
  return errors.map((error) => ({
    path: "plan",
    message: `invalid JSON syntax (code ${error.error}) near ${JSON.stringify(text.slice(error.offset, error.offset + 20))}`,
  }));
}

const rejected = (message: string): ParsedPlan => ({
  repaired: [],
  diagnostics: [{ path: "plan", message }],
});

export function readPlan(text: string, count: number): ParsedPlan {
  const body = stripFence(text);
  if (body === "") return rejected("expected a JSON object");
  const errors: ParseError[] = [];
  const tree = parseTree(body, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) return { repaired: [], diagnostics: syntax(errors, body) };
  if (!tree || tree.type !== "object") return rejected("expected a JSON object");
  const found: Diagnostic[] = [];
  duplicates(tree, "plan", found);
  if (found.length > 0) return { repaired: [], diagnostics: found };
  const coerced = coercePlan(toValue(tree), count);
  if (!coerced.plan) return { repaired: coerced.repaired, diagnostics: coerced.missing };
  const diagnostics = validateStructure(coerced.plan, count);
  return diagnostics.length > 0
    ? { repaired: coerced.repaired, diagnostics }
    : { plan: coerced.plan, repaired: coerced.repaired, diagnostics: [] };
}

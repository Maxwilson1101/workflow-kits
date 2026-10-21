import { expect, spyOn, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import register from "../index.ts";
import * as threadModule from "../src/threads.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

function registered() {
  const tools: Tool[] = [];
  register({ registerTool: (tool: Tool) => tools.push(tool) } as unknown as ExtensionAPI);
  return tools;
}

test("registers six typed tools with appropriate read and write hints", () => {
  const tools = registered();
  expect(tools.map((tool) => tool.name)).toEqual([
    "thread_list",
    "thread_read",
    "thread_create",
    "thread_revise",
    "thread_append_update",
    "thread_close",
  ]);
  for (const tool of tools) {
    expect(tool.outputSchema).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(["thread_list", "thread_read"].includes(tool.name));
    expect(tool.annotations?.idempotentHint).toBe(
      !["thread_create", "thread_append_update"].includes(tool.name),
    );
    expect(JSON.stringify(tool.outputSchema)).not.toContain('"url"');
  }
});

test("schemas accept the public inputs and reject undeclared fields", () => {
  const tools = registered();
  const list = tools.find((tool) => tool.name === "thread_list")!;
  const read = tools.find((tool) => tool.name === "thread_read")!;
  expect(Check(list.parameters, {})).toBe(true);
  expect(Check(list.parameters, { state: "all", cursor: "next" })).toBe(true);
  expect(Check(list.parameters, { state: "invalid" })).toBe(false);
  expect(Check(list.parameters, { cursor: "" })).toBe(false);
  expect(Check(list.parameters, { url: "https://example.com" })).toBe(false);
  expect(Check(read.parameters, { number: 7 })).toBe(true);
  expect(Check(read.parameters, { number: 0 })).toBe(false);
  expect(Check(read.parameters, { number: 1.5 })).toBe(false);
});

for (const entry of [
  { name: "thread_list", input: { state: "closed" }, value: { threads: [], nextCursor: null } },
  {
    name: "thread_read",
    input: { number: 7 },
    value: { number: 7, title: "Thread", state: "open", body: "Body", updates: [] },
  },
  {
    name: "thread_create",
    input: { title: "Title", body: "Body" },
    value: { number: 7, state: "open" },
  },
  {
    name: "thread_revise",
    input: { number: 7, body: "Body" },
    value: { number: 7, state: "open" },
  },
  { name: "thread_append_update", input: { number: 7, body: "Body" }, value: { number: 7 } },
  { name: "thread_close", input: { number: 7 }, value: { number: 7, state: "closed" } },
]) {
  const { name, input, value } = entry;
  test(`${name} forwards cwd and cancellation and returns schema-compatible content`, async () => {
    const signal = new AbortController().signal;
    const calls: unknown[][] = [];
    const execute = async (...args: unknown[]) => {
      calls.push(args);
      return value;
    };
    const create = spyOn(threadModule, "createThreads").mockImplementation((options) => {
      expect(options.cwd).toBe("/project");
      return {
        list: execute,
        read: execute,
        create: execute,
        revise: execute,
        appendUpdate: execute,
        close: execute,
      } as unknown as ReturnType<typeof threadModule.createThreads>;
    });
    try {
      const tool = registered().find((tool) => tool.name === name)!;
      const output = await tool.execute("test", input, signal, undefined, {
        cwd: "/project",
      } as Parameters<typeof tool.execute>[4]);
      expect(calls).toEqual([[["thread_read", "thread_close"].includes(name) ? 7 : input, signal]]);
      expect(Check(tool.outputSchema!, output.structuredContent)).toBe(true);
      expect(output.details).toEqual(value);
      expect(output.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
    } finally {
      create.mockRestore();
    }
  });
}

test("write schemas reject empty content and extra confirmation fields", () => {
  const tools = registered();
  for (const name of ["thread_create", "thread_revise", "thread_append_update"]) {
    const tool = tools.find((tool) => tool.name === name)!;
    const target = name === "thread_create" ? { title: "Title" } : { number: 7 };
    expect(Check(tool.parameters, { ...target, body: "Body" })).toBe(true);
    expect(Check(tool.parameters, { ...target, body: "" })).toBe(false);
    expect(Check(tool.parameters, { ...target, body: "Body", url: "https://example.com" })).toBe(
      false,
    );
  }
  const close = tools.find((tool) => tool.name === "thread_close")!;
  expect(Check(close.parameters, { number: 7 })).toBe(true);
  expect(Check(close.parameters, { number: 7, referencesChecked: true })).toBe(false);
  expect(close.description).toContain("other threads reference it");
  expect(close.description).toContain("Revise those bodies if needed");
});

test("tool execution propagates retrieval failures instead of reporting success", async () => {
  const create = spyOn(threadModule, "createThreads").mockImplementation(
    () =>
      ({
        async list() {
          throw new Error("HTTP 403");
        },
      }) as unknown as ReturnType<typeof threadModule.createThreads>,
  );
  try {
    const tool = registered().find((tool) => tool.name === "thread_list")!;
    await expect(
      tool.execute("test", {}, undefined, undefined, { cwd: "/project" } as Parameters<
        typeof tool.execute
      >[4]),
    ).rejects.toThrow("HTTP 403");
  } finally {
    create.mockRestore();
  }
});

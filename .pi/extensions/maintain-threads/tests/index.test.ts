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

test("registers typed read-only tools", () => {
  const tools = registered();
  expect(tools.map((tool) => tool.name)).toEqual(["thread_list", "thread_read"]);
  for (const tool of tools) {
    expect(tool.outputSchema).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
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

for (const name of ["thread_list", "thread_read"]) {
  test(`${name} forwards cwd and cancellation and returns schema-compatible content`, async () => {
    const value =
      name === "thread_list"
        ? { threads: [], nextCursor: null }
        : { number: 7, title: "Thread", state: "open", body: "Body", updates: [] };
    const signal = new AbortController().signal;
    const calls: unknown[][] = [];
    const execute = async (...args: unknown[]) => {
      calls.push(args);
      return value;
    };
    const create = spyOn(threadModule, "createThreads").mockImplementation((options) => {
      expect(options.cwd).toBe("/project");
      return { list: execute, read: execute } as unknown as ReturnType<
        typeof threadModule.createThreads
      >;
    });
    try {
      const tool = registered().find((tool) => tool.name === name)!;
      const input = name === "thread_list" ? { state: "closed" } : { number: 7 };
      const output = await tool.execute("test", input, signal, undefined, {
        cwd: "/project",
      } as Parameters<typeof tool.execute>[4]);
      expect(calls).toEqual([[name === "thread_list" ? input : 7, signal]]);
      expect(Check(tool.outputSchema!, output.structuredContent)).toBe(true);
      expect(output.details).toEqual(value);
      expect(output.content).toEqual([{ type: "text", text: JSON.stringify(value) }]);
    } finally {
      create.mockRestore();
    }
  });
}

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

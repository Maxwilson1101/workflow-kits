import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

interface Harness {
  run(args: string): Promise<void>;
  notifications: { message: string; type: string }[];
  status: (string | undefined)[];
  prompts: string[];
}

function harness(context: { cwd?: string; answer?: string; hasModel?: boolean } = {}): Harness {
  const notifications: { message: string; type: string }[] = [];
  const status: (string | undefined)[] = [];
  const prompts: string[] = [];
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const api = {
    on: () => {},
    registerCommand: (name: string, definition: { handler: typeof handler }) => {
      expect(name).toBe("explain-code");
      handler = definition.handler;
    },
  } as unknown as ExtensionAPI;
  register(api);
  const model = { provider: "test", id: "test-model" };
  const ctx = {
    cwd: context.cwd ?? "/workspace",
    hasUI: true,
    mode: "print",
    model: context.hasModel === false ? undefined : model,
    modelRegistry: {
      getAvailable: () => (context.hasModel === false ? [] : [model]),
      complete: async (
        _model: unknown,
        request: { messages: { content: { text: string }[] }[] },
      ) => {
        prompts.push(request.messages[0]!.content[0]!.text);
        return { content: [{ type: "text", text: context.answer ?? "not json" }] };
      },
    },
    ui: {
      notify: (message: string, type: string) => notifications.push({ message, type }),
      setStatus: (_key: string, text?: string) => status.push(text),
    },
    signal: undefined,
  } as unknown as ExtensionCommandContext;
  return {
    run: async (args) => {
      expect(handler).toBeDefined();
      await handler!(args, ctx);
    },
    notifications,
    status,
    prompts,
  };
}

describe("command entry", () => {
  test("registers only the explain-code command", () => {
    const registered: string[] = [];
    register({
      on: () => {},
      registerCommand: (name: string) => registered.push(name),
    } as unknown as ExtensionAPI);
    expect(registered).toEqual(["explain-code"]);
  });

  test("prints usage without a path", async () => {
    const run = harness();
    await run.run("   ");
    expect(run.notifications).toEqual([
      { message: "usage: /explain-code <source-file>", type: "warning" },
    ]);
    expect(run.prompts).toEqual([]);
  });

  test("rejects missing files and directories before calling the model", async () => {
    const run = harness({ cwd: "/tmp" });
    await run.run("definitely-missing.py");
    expect(run.notifications[0]?.type).toBe("error");
    expect(run.notifications[0]?.message).toContain("not a readable file");
    await run.run(".");
    expect(run.notifications[1]?.message).toContain("not a readable file");
    expect(run.prompts).toEqual([]);
  });

  test("reports a missing model", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "explain-code-command-"));
    try {
      writeFileSync(join(workspace, "a.py"), "print(1)\n", "utf8");
      const run = harness({ cwd: workspace, hasModel: false });
      await run.run("a.py");
      expect(run.notifications).toEqual([{ message: "no model is available", type: "error" }]);
      expect(run.prompts).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("reports failures, clears status, and allows a retry", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "explain-code-command-"));
    try {
      writeFileSync(join(workspace, "a.py"), "print(1)\n", "utf8");
      const run = harness({ cwd: workspace, answer: "not json" });
      await run.run("a.py");
      expect(run.notifications[0]?.type).toBe("error");
      expect(run.notifications[0]?.message).toContain("explain-code failed:");
      expect(run.notifications[0]?.message).toContain("invalid JSON syntax");
      expect(run.prompts).toHaveLength(1);
      expect(run.status.at(-1)).toBeUndefined();
      await run.run("a.py");
      expect(run.prompts).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("strips a leading @ before checking the path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "explain-code-command-"));
    try {
      writeFileSync(join(workspace, "a b.py"), "print(1)\n", "utf8");
      const run = harness({ cwd: workspace, answer: "not json" });
      await run.run("@a b.py");
      expect(run.notifications[0]?.message).toContain("invalid JSON syntax");
      await run.run('@"a b.py"');
      expect(run.notifications[1]?.message).toContain("invalid JSON syntax");
      await run.run("@");
      expect(run.notifications[2]).toEqual({
        message: "usage: /explain-code <source-file>",
        type: "warning",
      });
      expect(run.prompts).toHaveLength(2);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test("accepts a quoted path", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "explain-code-command-"));
    try {
      writeFileSync(join(workspace, "a b.py"), "print(1)\n", "utf8");
      const run = harness({ cwd: workspace, answer: "not json" });
      await run.run('"a b.py"');
      expect(run.notifications[0]?.message).toContain("invalid JSON syntax");
      expect(run.notifications[0]?.message).not.toContain("not a readable file");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

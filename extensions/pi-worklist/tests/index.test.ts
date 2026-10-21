import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";
import { createEditor, createUI } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function registeredTool(externalEditor?: string) {
  const tools: Parameters<ExtensionAPI["registerTool"]>[0][] = [];
  register({
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.push(tool),
    getSettings: () => ({ externalEditor }),
  } as unknown as ExtensionAPI);
  expect(tools).toHaveLength(1);
  return tools[0]!;
}

function execute(
  ctx: ExtensionContext,
  command?: string,
  content = "# Worklist\n\nKeep defaults.",
  signal?: AbortSignal,
) {
  const tool = registeredTool(command);
  return tool.execute(
    "review",
    { content },
    signal,
    undefined,
    ctx as Parameters<typeof tool.execute>[4],
  );
}

describe("review_worklist", () => {
  test("registers sequential review with workflow instructions", () => {
    const tool = registeredTool();
    expect(tool.name).toBe("review_worklist");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptSnippet).toBeTruthy();
    const instructions = tool.promptGuidelines!.join(" ");
    expect(instructions).toContain("commit");
    expect(instructions).toContain("recap");
    expect(instructions).toContain("Do not");
  });

  test("A approves the original complete worklist", async () => {
    const ui = createUI((component) => component.handleInput!("a"));
    const result = await execute(ui.ctx);
    expect(result.details).toEqual({
      decision: "execute",
      content: "# Worklist\n\nKeep defaults.",
    });
    expect(result.structuredContent as unknown).toEqual(result.details);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(ui.tui.stop).not.toHaveBeenCalled();
  });

  test("B returns the full edited content and approves without a second review", async () => {
    const editor = await createEditor(
      'writeFileSync(path, "# Revised worklist\\n\\nKeep defaults and add a switch.\\n");',
    );
    roots.push(editor.root);
    const ui = createUI((component) => component.handleInput!("b"));
    const result = await execute(ui.ctx, editor.command);
    expect(result.details).toEqual({
      decision: "execute",
      content: "# Revised worklist\n\nKeep defaults and add a switch.\n",
    });
    expect(ui.custom).toHaveBeenCalledTimes(2);
    expect(ui.tui.stop).toHaveBeenCalledTimes(1);
    expect(ui.tui.start).toHaveBeenCalledTimes(1);
  });

  test("C returns to discussion without opening an editor", async () => {
    const ui = createUI((component) => component.handleInput!("c"));
    const result = await execute(ui.ctx);
    expect(result.details).toEqual({ decision: "discuss" });
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(ui.tui.stop).not.toHaveBeenCalled();
  });

  test("Escape cancels without approval", async () => {
    const ui = createUI((component) => component.handleInput!("\x1b"));
    expect((await execute(ui.ctx)).details).toMatchObject({ decision: "cancel" });
  });

  for (const mode of ["rpc", "json", "print"] as const) {
    test(`${mode} never opens UI or approves`, async () => {
      const ui = createUI();
      ui.ctx.mode = mode;
      expect((await execute(ui.ctx)).details).toMatchObject({ decision: "cancel" });
      expect(ui.custom).not.toHaveBeenCalled();
    });
  }

  test("empty worklists are not approved", async () => {
    const ui = createUI();
    expect((await execute(ui.ctx, undefined, " \n")).details).toMatchObject({ decision: "cancel" });
    expect(ui.custom).not.toHaveBeenCalled();
  });

  test("an already aborted request never opens UI", async () => {
    const ui = createUI();
    expect(
      (await execute(ui.ctx, undefined, undefined, AbortSignal.abort())).details,
    ).toMatchObject({ decision: "cancel" });
    expect(ui.custom).not.toHaveBeenCalled();
  });

  for (const source of ['writeFileSync(path, " \\n");', "process.exit(1);"]) {
    test(`B does not approve unsuccessful editing: ${source}`, async () => {
      const editor = await createEditor(source);
      roots.push(editor.root);
      const ui = createUI((component) => component.handleInput!("b"));
      expect((await execute(ui.ctx, editor.command)).details).toMatchObject({ decision: "cancel" });
      expect(ui.tui.start).toHaveBeenCalledTimes(1);
    });
  }

  test("editor startup errors do not approve", async () => {
    const ui = createUI((component) => component.handleInput!("b"));
    expect((await execute(ui.ctx, "pi-worklist-missing-editor")).details).toMatchObject({
      decision: "cancel",
    });
    expect(ui.tui.start).toHaveBeenCalledTimes(1);
  });
});

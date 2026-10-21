import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type {
  EntryRenderer,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import register from "../index.ts";
import { createEditor, createUI, testTheme } from "./helpers.ts";

const roots: string[] = [];
const previewType = "worklist-preview";

type WorklistTool = Parameters<ExtensionAPI["registerTool"]>[0];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface PreviewEntry {
  customType: string;
  data?: { content: string };
}

function registered(externalEditor?: string) {
  const tools: WorklistTool[] = [];
  const appended: PreviewEntry[] = [];
  const entryRenderers = new Map<string, EntryRenderer<unknown>>();
  register({
    registerTool: (tool: WorklistTool) => tools.push(tool),
    registerEntryRenderer: (customType: string, renderer: EntryRenderer<unknown>) =>
      entryRenderers.set(customType, renderer),
    appendEntry: (customType: string, data?: unknown) =>
      appended.push({ customType, data: data as { content: string } }),
    getSettings: () => ({ externalEditor, outputPad: 1 }),
  } as unknown as ExtensionAPI);
  expect(tools).toHaveLength(1);
  return { tool: tools[0]!, appended, entryRenderers };
}

function harness(externalEditor?: string) {
  const { tool, appended, entryRenderers } = registered(externalEditor);
  return {
    tool,
    appended,
    entryRenderers,
    run(
      ctx: ExtensionContext,
      command?: string,
      content = "# Worklist\n\nKeep defaults.",
      signal?: AbortSignal,
    ) {
      return tool.execute(
        "review",
        { content },
        signal,
        undefined,
        ctx as Parameters<typeof tool.execute>[4],
      );
    },
  };
}

describe("review_worklist", () => {
  test("registers sequential review with workflow instructions", () => {
    const { tool } = registered();
    expect(tool.name).toBe("review_worklist");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptSnippet).toBeTruthy();
    const instructions = tool.promptGuidelines!.join(" ");
    expect(instructions).toContain("commit");
    expect(instructions).toContain("recap");
    expect(instructions).toContain("Do not");
  });

  test("Execute approves the original complete worklist", async () => {
    const review = harness();
    const ui = createUI({ choice: "Execute through commit" });
    const result = await review.run(ui.ctx);
    expect(result.details).toEqual({
      decision: "execute",
      content: "# Worklist\n\nKeep defaults.",
    });
    expect(result.structuredContent as unknown).toEqual(result.details);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }]);
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.tui.stop).not.toHaveBeenCalled();
    expect(review.appended).toEqual([
      { customType: previewType, data: { content: "# Worklist\n\nKeep defaults." } },
    ]);
  });

  test("the preview is in the transcript before the question is asked", async () => {
    const review = harness();
    const ui = createUI({
      choice: "Discuss again",
      onSelect: () => expect(review.appended).toHaveLength(1),
    });
    expect((await review.run(ui.ctx)).details).toEqual({ decision: "discuss" });
  });

  test("the preview entry renders the worklist markdown", () => {
    const { entryRenderers } = registered();
    const renderer = entryRenderers.get(previewType)!;
    const entry = {
      customType: previewType,
      data: { content: "# Worklist\n\n1. Keep defaults\n2. Add a switch" },
    };
    const component = renderer(
      entry as Parameters<typeof renderer>[0],
      { expanded: false },
      testTheme,
    )!;
    const rendered = component
      .render(60)
      .map((line) => line.replace(/\u001B\[[0-9;]*m/g, ""))
      .join("\n");
    expect(rendered).toContain("Worklist");
    expect(rendered).toContain("1. Keep defaults");
    expect(rendered).toContain("2. Add a switch");
    expect(component.render(60).every((line) => visibleWidth(line) <= 60)).toBe(true);
  });

  test("Edit returns the full edited content and approves without a second review", async () => {
    const editor = await createEditor(
      'writeFileSync(path, "# Revised worklist\\n\\nKeep defaults and add a switch.\\n");',
    );
    roots.push(editor.root);
    const review = harness(editor.command);
    const ui = createUI({ choice: "Edit, then execute through commit" });
    const result = await review.run(ui.ctx);
    expect(result.details).toEqual({
      decision: "execute",
      content: "# Revised worklist\n\nKeep defaults and add a switch.\n",
    });
    expect(ui.custom).toHaveBeenCalledTimes(1);
    expect(ui.tui.stop).toHaveBeenCalledTimes(1);
    expect(ui.tui.start).toHaveBeenCalledTimes(1);
  });

  test("Discuss returns to discussion without opening an editor", async () => {
    const review = harness();
    const ui = createUI({ choice: "Discuss again" });
    const result = await review.run(ui.ctx);
    expect(result.details).toEqual({ decision: "discuss" });
    expect(ui.custom).not.toHaveBeenCalled();
    expect(ui.tui.stop).not.toHaveBeenCalled();
  });

  test("Escape cancels without approval", async () => {
    const review = harness();
    const ui = createUI();
    expect((await review.run(ui.ctx)).details).toMatchObject({ decision: "cancel" });
    expect(review.appended).toHaveLength(1);
  });

  for (const mode of ["rpc", "json", "print"] as const) {
    test(`${mode} never appends, opens UI, or approves`, async () => {
      const review = harness();
      const ui = createUI({ choice: "Execute through commit" });
      ui.ctx.mode = mode;
      expect((await review.run(ui.ctx)).details).toMatchObject({ decision: "cancel" });
      expect(ui.custom).not.toHaveBeenCalled();
      expect(ui.select).not.toHaveBeenCalled();
      expect(review.appended).toHaveLength(0);
    });
  }

  test("empty worklists are not shown or approved", async () => {
    const review = harness();
    const ui = createUI({ choice: "Execute through commit" });
    expect((await review.run(ui.ctx, undefined, " \n")).details).toMatchObject({
      decision: "cancel",
    });
    expect(ui.select).not.toHaveBeenCalled();
    expect(review.appended).toHaveLength(0);
  });

  test("an already aborted request never shows a preview", async () => {
    const review = harness();
    const ui = createUI({ choice: "Execute through commit" });
    expect(
      (await review.run(ui.ctx, undefined, undefined, AbortSignal.abort())).details,
    ).toMatchObject({ decision: "cancel" });
    expect(ui.select).not.toHaveBeenCalled();
    expect(review.appended).toHaveLength(0);
  });

  for (const source of ['writeFileSync(path, " \\n");', "process.exit(1);"]) {
    test(`Edit does not approve unsuccessful editing: ${source}`, async () => {
      const editor = await createEditor(source);
      roots.push(editor.root);
      const review = harness(editor.command);
      const ui = createUI({ choice: "Edit, then execute through commit" });
      expect((await review.run(ui.ctx)).details).toMatchObject({ decision: "cancel" });
      expect(ui.tui.start).toHaveBeenCalledTimes(1);
    });
  }

  test("editor startup errors do not approve", async () => {
    const review = harness("pi-worklist-missing-editor");
    const ui = createUI({ choice: "Edit, then execute through commit" });
    expect((await review.run(ui.ctx)).details).toMatchObject({ decision: "cancel" });
    expect(ui.tui.start).toHaveBeenCalledTimes(1);
  });
});

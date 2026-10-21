import { afterEach, describe, expect, test } from "bun:test";
import { access, readFile, realpath, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import { editWorklist, resolveEditorCommand } from "../src/editor.ts";
import { createEditor, createUI } from "./helpers.ts";

const roots: string[] = [];
const originalVisual = process.env.VISUAL;
const originalEditor = process.env.EDITOR;

afterEach(async () => {
  if (originalVisual === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = originalVisual;
  if (originalEditor === undefined) delete process.env.EDITOR;
  else process.env.EDITOR = originalEditor;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("editor command", () => {
  test("prefers Pi settings, then VISUAL, then EDITOR, then the platform default", () => {
    process.env.VISUAL = "visual --wait";
    process.env.EDITOR = "editor";
    expect(resolveEditorCommand("configured --wait")).toBe("configured --wait");
    expect(resolveEditorCommand(" ")).toBe("visual --wait");
    delete process.env.VISUAL;
    expect(resolveEditorCommand()).toBe("editor");
    delete process.env.EDITOR;
    expect(resolveEditorCommand()).toBe(process.platform === "win32" ? "notepad" : "nano");
  });
});

describe("external editing", () => {
  for (const [name, source, expected] of [
    ["edited", 'writeFileSync(path, "# Revised\\n");', "# Revised\n"],
    ["unchanged", "", "# Original\n"],
    ["empty", 'writeFileSync(path, " \\n");', undefined],
    ["failed", "process.exit(1);", undefined],
    ["BOM", 'writeFileSync(path, "\\uFEFF# Revised\\n");', "# Revised\n"],
  ] as const) {
    test(`${name} editing restores the terminal and removes the temporary directory`, async () => {
      const editor = await createEditor(source);
      roots.push(editor.root);
      const ui = createUI();
      ui.ctx.cwd = editor.root;
      const result = await editWorklist(ui.ctx, "# Original\n", editor.command);
      expect(result).toBe(expected);
      const record = JSON.parse(await readFile(editor.record, "utf8"));
      expect(record.content).toBe("# Original\n");
      expect(record.path).toEndWith(".md");
      expect(record.cwd).toBe(await realpath(editor.root));
      await expect(access(dirname(record.path))).rejects.toThrow();
      expect(ui.tui.stop).toHaveBeenCalledTimes(1);
      expect(ui.tui.start).toHaveBeenCalledTimes(1);
      expect(ui.tui.requestRender).toHaveBeenCalledWith(true);
    });
  }

  test("aborting before editing does not launch a process or stop the terminal", async () => {
    const ui = createUI();
    expect(
      await editWorklist(ui.ctx, "# Original", "exit 99", AbortSignal.abort()),
    ).toBeUndefined();
    expect(ui.tui.stop).not.toHaveBeenCalled();
  });

  test("aborting a running editor restores the terminal and cleans up", async () => {
    const editor = await createEditor("setInterval(() => {}, 1000);");
    roots.push(editor.root);
    const ui = createUI();
    const controller = new AbortController();
    const result = editWorklist(ui.ctx, "# Original", editor.command, controller.signal);
    let ready = false;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          await access(editor.record);
          ready = true;
          break;
        } catch {
          await delay(10);
        }
      }
    } finally {
      controller.abort();
    }
    expect(await result).toBeUndefined();
    expect(ready).toBe(true);
    const record = JSON.parse(await readFile(editor.record, "utf8"));
    await expect(access(dirname(record.path))).rejects.toThrow();
    expect(ui.tui.start).toHaveBeenCalledTimes(1);
  });
});

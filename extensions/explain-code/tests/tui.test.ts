import { describe, expect, test } from "bun:test";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createState, openCommand, ProgressPanel, withProgress } from "../src/tui.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  inverse: (text: string) => text,
  strikethrough: (text: string) => text,
  style: (text: string) => text,
} as unknown as Theme;

const keybindings = { matches: () => false } as unknown as KeybindingsManager;

function panel(width = 80) {
  const state = createState({
    filename: "parse.ts",
    lines: 130,
    language: "typescript",
    model: "deepseek/deepseek-flash",
  });
  let cancelled = 0;
  const component = new ProgressPanel({
    tui: { requestRender: () => {} },
    theme,
    keybindings,
    state,
    cancel: () => {
      cancelled += 1;
    },
  });
  return { state, component, lines: component.render(width), cancelled: () => cancelled };
}

describe("progress panel", () => {
  test("lists every stage with a header", () => {
    const { lines } = panel();
    const text = lines.join("\n");
    expect(text).toContain("◆ explain-code");
    expect(text).toContain("parse.ts · 130 行 · typescript");
    expect(text).toContain("deepseek/deepseek-flash");
    for (const label of ["生成讲解", "润色文字", "渲染 HTML", "浏览器验收", "发布产物"])
      expect(text).toContain(label);
    expect(text).toContain("esc 取消");
  });

  test("marks pending, active, and finished stages", () => {
    const { state, component } = panel();
    state.steps[0]!.state = "done";
    state.steps[0]!.startedAt = Date.now() - 5_000;
    state.steps[0]!.endedAt = Date.now();
    state.steps[1]!.state = "active";
    state.steps[1]!.startedAt = Date.now() - 1_000;
    state.steps[1]!.detail = "21 节 · 24 条讲解";
    const text = component.render(80).join("\n");
    expect(text).toContain("✓");
    expect(text).toContain("○");
    expect(text).toContain("21 节 · 24 条讲解");
    expect(text).toMatch(/5\.0s/);
  });

  test("keeps every line inside the width", () => {
    const { state, component } = panel(32);
    state.steps[1]!.state = "active";
    state.steps[1]!.detail = "很长的细节说明会被截断";
    state.notes.push("21 节 · 24 条讲解 · 机械修复 3 处");
    for (const width of [12, 32, 48, 100]) {
      for (const line of component.render(width))
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  test("renders accumulated notes", () => {
    const { state, component } = panel();
    state.notes.push("3 处机械修复");
    expect(component.render(80).join("\n")).toContain("3 处机械修复");
  });

  test("cancels on escape and shows the cancelling state", () => {
    const { component, cancelled, state } = panel();
    component.handleInput("x");
    expect(cancelled()).toBe(0);
    component.handleInput("\u001b");
    expect(cancelled()).toBe(1);
    expect(state.cancelled).toBe(true);
    expect(component.render(80).join("\n")).toContain("正在取消");
    component.dispose();
  });
});

describe("progress screen wiring", () => {
  const meta = { filename: "parse.ts", lines: 130, language: "typescript", model: "m" };

  function fakeContext() {
    const captured: { component?: ProgressPanel; done: number } = { done: 0 };
    const ctx = {
      mode: "tui",
      hasUI: true,
      ui: {
        setStatus: () => {},
        custom: (factory: Function) =>
          new Promise<void>((resolve) => {
            captured.component = factory({ requestRender: () => {} }, theme, keybindings, () => {
              captured.done += 1;
              resolve();
            }) as ProgressPanel;
          }),
      },
    } as unknown as ExtensionCommandContext;
    return { ctx, captured };
  }

  test("settles the screen when the work finishes", async () => {
    const { ctx, captured } = fakeContext();
    const result = await withProgress(
      ctx,
      meta,
      () => {},
      async (progress) => {
        progress.stage("generation");
        progress.detail("1 节");
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(captured.done).toBe(1);
    expect(captured.component).toBeDefined();
  });

  test("forwards escape to the cancel callback", async () => {
    const { ctx, captured } = fakeContext();
    let reasons: Error[] = [];
    await withProgress(
      ctx,
      meta,
      (reason) => reasons.push(reason),
      async () => {
        captured.component!.handleInput("\u001b");
        return "ok";
      },
    );
    expect(reasons.map((reason) => reason.message)).toEqual(["cancelled"]);
  });
});

describe("opening the artifact", () => {
  test("selects the platform opener", () => {
    expect(openCommand("darwin", "/tmp/a.html")).toEqual({
      command: "open",
      args: ["/tmp/a.html"],
    });
    expect(openCommand("linux", "/tmp/a.html")).toEqual({
      command: "xdg-open",
      args: ["/tmp/a.html"],
    });
    expect(openCommand("win32", "/tmp/a.html")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", "/tmp/a.html"],
    });
  });
});

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showReview } from "../src/review.ts";
import { createUI } from "./helpers.ts";

describe("review preview", () => {
  for (const [key, decision] of [
    ["a", "execute"],
    ["b", "edit"],
    ["c", "discuss"],
    ["\x1b", "cancel"],
    ["\x03", "cancel"],
  ] as const) {
    test(`${JSON.stringify(key)} selects ${decision}`, async () => {
      const ui = createUI((component) => {
        const rendered = component.render(80).join("\n");
        expect(rendered).toContain("Original worklist");
        expect(rendered).toContain("A.");
        expect(rendered).toContain("B.");
        expect(rendered).toContain("C.");
        component.handleInput!(key);
      });
      expect(await showReview(ui.ctx, "# Original worklist")).toBe(decision);
    });
  }

  test("long previews scroll without truncating content or hiding the actions", async () => {
    const content = Array.from({ length: 150 }, (_, index) => `Paragraph ${index}.`).join("\n\n");
    const ui = createUI((component) => {
      const start = component.render(80);
      expect(start.length).toBeLessThanOrEqual(ui.tui.terminal.rows);
      expect(start.join("\n")).toContain("Paragraph 0.");
      expect(start.join("\n")).not.toContain("Paragraph 149.");
      component.handleInput!("\x1b[6~");
      expect(component.render(80).join("\n")).not.toContain("Paragraph 0.");
      component.handleInput!("\x1b[F");
      const end = component.render(80).join("\n");
      expect(end).toContain("Paragraph 149.");
      expect(end).toContain("A.");
      component.handleInput!("\x1b[H");
      expect(component.render(80).join("\n")).toContain("Paragraph 0.");
      component.handleInput!("c");
    });
    expect(await showReview(ui.ctx, content)).toBe("discuss");
  });

  test("narrow and resized previews stay within terminal width", async () => {
    const content = "# Worklist\n\n```diff\n+" + "long content ".repeat(50) + "\n```";
    const ui = createUI((component) => {
      for (const width of [80, 35, 12]) {
        component.invalidate();
        const lines = component.render(width);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      component.handleInput!("\x1b");
    });
    expect(await showReview(ui.ctx, content)).toBe("cancel");
  });

  test("an abort dismisses the preview without approval", async () => {
    const controller = new AbortController();
    const ui = createUI(() => controller.abort());
    expect(await showReview(ui.ctx, "# Worklist", controller.signal)).toBe("cancel");
  });

  test("a pre-aborted preview never opens", async () => {
    const ui = createUI();
    expect(await showReview(ui.ctx, "# Worklist", AbortSignal.abort())).toBe("cancel");
    expect(ui.custom).not.toHaveBeenCalled();
  });
});

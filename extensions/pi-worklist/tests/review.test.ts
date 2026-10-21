import { describe, expect, test } from "bun:test";
import { showReview } from "../src/review.ts";
import { createUI } from "./helpers.ts";

const labels = ["Execute through commit", "Edit, then execute through commit", "Discuss again"];

describe("review question", () => {
  for (const [label, choice] of [
    ["Execute through commit", "execute"],
    ["Edit, then execute through commit", "edit"],
    ["Discuss again", "discuss"],
  ] as const) {
    test(`${label} selects ${choice}`, async () => {
      const ui = createUI({ choice: label });
      expect(await showReview(ui.ctx)).toBe(choice);
      expect(ui.select.mock.calls[0]![0]).toBe("Review worklist");
      expect(ui.select.mock.calls[0]![1]).toEqual(labels);
    });
  }

  test("a dismissed selection cancels", async () => {
    expect(await showReview(createUI().ctx)).toBe("cancel");
  });

  test("an unknown selection cancels", async () => {
    expect(await showReview(createUI({ choice: "something else" }).ctx)).toBe("cancel");
  });

  test("the abort signal reaches the dialog", async () => {
    const controller = new AbortController();
    const ui = createUI();
    expect(await showReview(ui.ctx, controller.signal)).toBe("cancel");
    expect(ui.select.mock.calls[0]![2]).toEqual({ signal: controller.signal });
  });
});

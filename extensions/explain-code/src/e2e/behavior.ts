import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { Walkthrough } from "../types.ts";
import type { Expected } from "./content.ts";
import { blurActive, readLayout } from "./page.ts";

export async function assertInteractions(page: Page, input: Pick<Expected, "plan">): Promise<void> {
  const buttons = page.locator(".note-toggle");
  const expected = noteCount(input.plan);
  assert.equal(await buttons.count(), expected, "note button count differs");
  for (let index = 0; index < expected; index += 1) {
    const button = buttons.nth(index);
    const note = page.locator(`#${await button.getAttribute("aria-controls")}`);
    const start = Number(await button.getAttribute("data-start"));
    const end = Number(await button.getAttribute("data-end"));
    const size = end - start + 1;
    const place = `note ${index} (lines ${start}-${end})`;
    await button.click();
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "true",
      `${place}: click did not expand`,
    );
    assert.ok(await note.isVisible(), `${place}: explanation is not visible after expanding`);
    assert.equal(
      (await page.evaluate(readLayout, [start, end])).highlightedTotal,
      size,
      `${place}: unrelated lines are highlighted`,
    );
    assert.equal(
      (await page.evaluate(readLayout, [start, end])).highlightedInRange,
      size,
      `${place}: range is not highlighted`,
    );
    await button.click();
    await page.mouse.move(0, 0);
    await page.evaluate(blurActive);
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "false",
      `${place}: second click did not collapse`,
    );
    assert.ok(!(await note.isVisible()), `${place}: explanation is still visible after collapsing`);
    assert.equal(
      (await page.evaluate(readLayout, [start, end])).highlightedTotal,
      0,
      `${place}: highlight remains after collapsing`,
    );
    await button.focus();
    await page.keyboard.press("Enter");
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "true",
      `${place}: keyboard did not expand`,
    );
    assert.ok(await note.isVisible(), `${place}: explanation is not visible after keyboard expand`);
    await page.keyboard.press("Enter");
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "false",
      `${place}: keyboard did not collapse`,
    );
    await page.evaluate(blurActive);
    assert.equal(
      (await page.evaluate(readLayout, [start, end])).highlightedTotal,
      0,
      `${place}: highlight remains after blur`,
    );
  }
}

export function noteCount(plan: Walkthrough): number {
  return plan.sections.reduce((total, section) => total + section.notes.length, 0);
}

export async function assertLayout(page: Page, input: Pick<Expected, "plan">): Promise<void> {
  for (const button of await page.locator(".note-toggle").all())
    await button.dispatchEvent("click");
  const first = input.plan.sections[0]!;
  const range: [number, number] = [first.start, first.end];
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const state = await page.evaluate(readLayout, range);
    assert.ok(state.documentOverflow <= 1, `page overflows horizontally at ${viewport.width}px`);
    assert.ok(
      state.scrollerOverflowX.every((overflow) => overflow === "auto" || overflow === "scroll"),
      `code container does not scroll horizontally at ${viewport.width}px`,
    );
  }
}

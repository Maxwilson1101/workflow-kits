import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { assertContent, expectedLines, type Expected } from "./content.ts";
import { assertInteractions, assertLayout } from "./behavior.ts";
import { readPage, readStatic } from "./page.ts";

export interface ArtifactInput extends Expected {
  htmlPath: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function blockRequests(
  context: BrowserContext,
  input: ArtifactInput,
  problems: string[],
): Promise<void> {
  await context.route("**/*", async (route) => {
    if (route.request().url() === pathToFileURL(input.htmlPath).href) await route.continue();
    else {
      problems.push(`external request: ${route.request().url()}`);
      await route.abort();
    }
  });
  await context.routeWebSocket("**/*", (socket) => {
    problems.push(`external websocket: ${socket.url()}`);
    socket.close();
  });
}

async function assertWithoutJavaScript(browser: Browser, input: ArtifactInput): Promise<void> {
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  const problems: string[] = [];
  try {
    await blockRequests(context, input, problems);
    const page = await context.newPage();
    await page.goto(pathToFileURL(input.htmlPath).href);
    const state = await page.evaluate(readStatic);
    assert.deepEqual(problems, [], "page requested external resources without JavaScript");
    const expected = expectedLines(input);
    assert.deepEqual(state.numbers, expected, "source line coverage differs without JavaScript");
    state.sources.forEach((source, index) => {
      assert.equal(
        source,
        input.lines[expected[index]! - 1] ?? "",
        `source differs on line ${expected[index]} without JavaScript`,
      );
    });
    if (input.language !== "plain") {
      assert.ok(state.spans > 0, "static highlighting is missing without JavaScript");
    }
    assert.deepEqual(
      state.collapsedNotes,
      input.plan.sections.flatMap((section) => section.notes).map(() => true),
      "explanations must start collapsed without JavaScript",
    );
  } finally {
    await context.close();
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function inspect(browser: Browser, input: ArtifactInput): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    serviceWorkers: "block",
  });
  const problems: string[] = [];
  await blockRequests(context, input, problems);
  const page: Page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("file:") && !url.startsWith("data:"))
      problems.push(`external request: ${url}`);
  });
  await page.goto(pathToFileURL(input.htmlPath).href);
  await page.waitForLoadState("load");
  assertContent(await page.evaluate(readPage), input);
  assert.deepEqual(problems, [], "page reported errors or external requests");
  await assertInteractions(page, input);
  await assertLayout(page, input);
  assert.deepEqual(problems, [], "page reported errors or external requests");
  await assertWithoutJavaScript(browser, input);
}

export async function validateArtifact(input: ArtifactInput): Promise<void> {
  input.signal?.throwIfAborted();
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: input.timeoutMs ?? 30_000 });
  } catch (error) {
    throw new Error(
      `playwright could not launch Chromium (${(error as Error).message}); run "bun run --filter pi-explain-code setup:browser"`,
    );
  }
  const abort = () => {
    void browser.close().catch(() => {});
  };
  input.signal?.addEventListener("abort", abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    await withTimeout(inspect(browser, input), input.timeoutMs ?? 120_000, "artifact validation");
  } finally {
    input.signal?.removeEventListener("abort", abort);
    await browser.close();
  }
}

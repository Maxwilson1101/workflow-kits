import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { validateArtifact } from "./src/e2e/check.ts";
import { readPlan, readSource } from "./src/plan/parse.ts";
import { generationPrompt, refinementPrompt } from "./src/prompts.ts";
import { renderDocument } from "./src/render/document.ts";
import { highlightLines, languageFor } from "./src/render/highlight.ts";
import { notify, openPath, withProgress, type Progress } from "./src/tui.ts";
import type { PreparedSource, Walkthrough } from "./src/types.ts";

const USAGE = "usage: /explain-code <source-file>";
const DEADLINE_MS = 10 * 60_000;

interface Outcome {
  htmlPath: string;
}

function targetPath(args: string): string {
  let target = args.trim();
  if (target.startsWith("@")) target = target.slice(1).trim();
  if (/^".*"$/.test(target) || /^'.*'$/.test(target)) target = target.slice(1, -1);
  return target.trim();
}

function slugFor(path: string): string {
  const name = basename(path).replace(/\.[^./\\]*$/, "");
  const slug = name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return slug === "" ? "walkthrough" : slug;
}

function describe(plan: Walkthrough): string {
  const notes = plan.sections.reduce((total, section) => total + section.notes.length, 0);
  return `${plan.sections.length} 节 · ${notes} 条讲解`;
}

async function ask(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const message = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
      ],
    },
    { cacheRetention: "short", signal },
  );
  const reason = message.stopReason;
  if (reason === "error" || reason === "aborted" || reason === "length")
    throw new Error(message.errorMessage ?? `model request ${reason}`);
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function accept(answer: string, source: PreparedSource, stage: string): Walkthrough {
  const result = readPlan(answer, source.lines.length);
  if (result.plan) return result.plan;
  const detail = result.diagnostics
    .map((diagnostic) => `- ${diagnostic.path}: ${diagnostic.message}`)
    .join("\n");
  throw new Error(`${stage} produced an unusable plan\n${detail}`);
}

async function explain(
  source: PreparedSource,
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  signal: AbortSignal,
  progress: Progress,
): Promise<Outcome> {
  const sourcePath = source.path;
  const outputDir = join(tmpdir(), "explain-code");
  const slug = slugFor(sourcePath);
  for (const name of [`${slug}.html`, `${slug}.json`])
    if (resolve(outputDir, name) === resolve(sourcePath))
      throw new Error(`refusing to overwrite the source file ${sourcePath}`);

  progress.stage("generation");
  const draft = accept(
    await ask(ctx, model, generationPrompt(source), signal),
    source,
    "generation",
  );
  progress.detail(describe(draft));

  progress.stage("refinement");
  const guideline = readFileSync(
    new URL("./src/assets/writing-guideline.zh.md", import.meta.url),
    "utf8",
  );
  const refined = accept(
    await ask(ctx, model, refinementPrompt(source, draft, guideline), signal),
    source,
    "refinement",
  );
  progress.detail(describe(refined));

  progress.stage("rendering");
  const highlighted = await highlightLines(source.lines, source.language);
  const html = renderDocument({
    plan: refined,
    lines: source.lines,
    highlighted,
    sourcePath,
    language: source.language,
  });

  progress.stage("validation");
  mkdirSync(outputDir, { recursive: true });
  const staging = mkdtempSync(join(outputDir, "staging-"));
  const publishedDir = join(outputDir, `${slug}-${randomUUID()}`);
  try {
    const stagedHtml = join(staging, `${slug}.html`);
    writeFileSync(stagedHtml, html, "utf8");
    await validateArtifact({
      htmlPath: stagedHtml,
      sourcePath,
      plan: refined,
      lines: source.lines,
      language: source.language,
      signal,
    });
    writeFileSync(join(staging, `${slug}.json`), `${JSON.stringify(refined, null, 2)}\n`, "utf8");
    progress.stage("publishing");
    renameSync(staging, publishedDir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return { htmlPath: join(publishedDir, `${slug}.html`) };
}

export default function (pi: ExtensionAPI) {
  let running: AbortController | undefined;
  pi.on("session_shutdown", () => running?.abort(new Error("session closed")));
  pi.registerCommand("explain-code", {
    description: "Generate a standalone HTML walkthrough for a source file",
    handler: async (args, ctx) => {
      const target = targetPath(args);
      if (!target) {
        notify(ctx, USAGE, "warning");
        return;
      }
      if (running) {
        notify(ctx, "explain-code is already running", "warning");
        return;
      }
      const sourcePath = resolve(ctx.cwd, target);
      if (statSync(sourcePath, { throwIfNoEntry: false })?.isFile() !== true) {
        notify(ctx, `not a readable file: ${sourcePath}`, "error");
        return;
      }
      const model = (ctx.model ?? ctx.modelRegistry.getAvailable()[0]) as Model<Api> | undefined;
      if (!model) {
        notify(ctx, "no model is available", "error");
        return;
      }

      const controller = new AbortController();
      running = controller;
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(DEADLINE_MS),
        ...(ctx.signal ? [ctx.signal] : []),
      ]);
      try {
        const lines = readSource(sourcePath);
        const source: PreparedSource = {
          path: sourcePath,
          filename: basename(sourcePath),
          lines,
          language: languageFor(sourcePath),
        };
        const meta = {
          filename: source.filename,
          lines: lines.length,
          language: source.language,
          model: `${model.provider}/${model.id}`,
        };
        const outcome = await withProgress(
          ctx,
          meta,
          (reason) => controller.abort(reason),
          (progress) => explain(source, ctx, model, signal, progress),
        );
        openPath(outcome.htmlPath, (message) => notify(ctx, message, "error"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (controller.signal.aborted && !message.includes("session closed"))
          notify(ctx, `explain-code 已取消: ${message}`, "warning");
        else notify(ctx, `explain-code failed: ${message}`, "error");
      } finally {
        running = undefined;
      }
    },
  });
}

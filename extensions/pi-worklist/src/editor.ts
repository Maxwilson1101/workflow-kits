import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function resolveEditorCommand(configured?: string): string {
  return (
    [configured, process.env.VISUAL, process.env.EDITOR].find((value) => value?.trim()) ??
    (process.platform === "win32" ? "notepad" : "nano")
  );
}

function runEditor(
  command: string,
  path: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child =
      process.platform === "win32"
        ? spawn(command, [`"${path}"`], { cwd, stdio: "inherit", shell: true, signal })
        : spawn("/bin/sh", ["-c", `exec ${command} "$1"`, "pi-worklist", path], {
            cwd,
            stdio: "inherit",
            signal,
          });
    let failure: Error | undefined;
    child.on("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      if (signal?.aborted) resolve(false);
      else if (failure) reject(failure);
      else resolve(code === 0);
    });
  });
}

export async function editWorklist(
  ctx: ExtensionContext,
  content: string,
  command: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (signal?.aborted) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "pi-worklist-"));
  const path = join(directory, "worklist.md");
  try {
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    if (signal?.aborted) return undefined;
    return await ctx.ui.custom<string | undefined>(async (tui, _theme, _keys, done) => {
      let revised: string | undefined;
      tui.stop();
      try {
        const completed = await runEditor(command, path, ctx.cwd, signal);
        if (completed && !signal?.aborted) {
          const text = (await readFile(path, "utf8")).replace(/^\uFEFF/, "");
          if (text.trim()) revised = text;
        }
      } finally {
        tui.start();
        tui.requestRender(true);
      }
      done(signal?.aborted ? undefined : revised);
      return { render: () => [], invalidate() {} };
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

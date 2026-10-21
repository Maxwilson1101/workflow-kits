import { mock } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTheme,
  type ExtensionUIDialogOptions,
  type KeybindingsManager,
  type ExtensionContext,
  type ExtensionUIContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Component, type TUI } from "@earendil-works/pi-tui";

initTheme("dark", false);

export interface UIConfig {
  choice?: string;
  onSelect?: (title: string, optionList: string[]) => void;
}

export const testTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;

export function createUI(config: UIConfig = {}) {
  const tui = {
    terminal: { rows: 24, columns: 80 },
    stop: mock(() => {}),
    start: mock(() => {}),
    requestRender: mock((_force?: boolean) => {}),
  };
  const notify = mock((_message: string, _type?: string) => {});
  const select = mock(
    async (_title: string, _optionList: string[], _opts?: ExtensionUIDialogOptions) => {
      config.onSelect?.(_title, _optionList);
      return config.choice;
    },
  );
  const custom = mock(
    (factory: Parameters<ExtensionUIContext["custom"]>[0]) =>
      new Promise<unknown>((resolve, reject) => {
        let component: (Component & { dispose?(): void }) | undefined;
        let finished = false;
        const done = (result: unknown) => {
          if (finished) return;
          finished = true;
          component?.dispose?.();
          resolve(result);
        };
        Promise.resolve()
          .then(() =>
            factory(tui as unknown as TUI, testTheme, getKeybindings() as KeybindingsManager, done),
          )
          .then((value) => {
            component = value;
            if (finished) component.dispose?.();
          })
          .catch(reject);
      }),
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: process.cwd(),
    ui: { custom, notify, select, theme: testTheme },
  } as unknown as ExtensionContext;
  return { ctx, tui, custom, notify, select };
}

export async function createEditor(source: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-worklist-test-"));
  const script = join(root, "editor with spaces.mjs");
  const record = join(root, "record.json");
  await writeFile(
    script,
    `
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ path, content: readFileSync(path, "utf8"), cwd: process.cwd() }));
${source}
`,
  );
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return { root, record, command: `${quote(process.execPath)} ${quote(script)}` };
}

import { spawn } from "node:child_process";
import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

const STATUS_KEY = "explain-code";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 120;

export type Stage = "generation" | "refinement" | "rendering" | "validation" | "publishing";

const STAGES: readonly { key: Stage; label: string }[] = [
  { key: "generation", label: "生成讲解" },
  { key: "refinement", label: "润色文字" },
  { key: "rendering", label: "渲染 HTML" },
  { key: "validation", label: "浏览器验收" },
  { key: "publishing", label: "发布产物" },
];

export interface Meta {
  filename: string;
  lines: number;
  language: string;
  model: string;
}

interface Step {
  key: Stage;
  label: string;
  state: "pending" | "active" | "done";
  detail: string;
  startedAt?: number;
  endedAt?: number;
}

export interface ProgressState {
  meta: Meta;
  steps: Step[];
  notes: string[];
  startedAt: number;
  cancelled: boolean;
}

export interface Progress {
  stage(key: Stage): void;
  detail(text: string): void;
  note(text: string): void;
}

export function createState(meta: Meta): ProgressState {
  return {
    meta,
    steps: STAGES.map((stage) => ({ ...stage, state: "pending", detail: "" })),
    notes: [],
    startedAt: Date.now(),
    cancelled: false,
  };
}

function progressFor(state: ProgressState): Progress {
  const active = () => state.steps.find((step) => step.state === "active");
  return {
    stage: (key) => {
      const now = Date.now();
      for (const step of state.steps) {
        if (step.state === "active") {
          step.state = "done";
          step.endedAt = now;
        }
      }
      const next = state.steps.find((step) => step.key === key);
      if (!next) return;
      next.state = "active";
      next.startedAt = now;
    },
    detail: (text) => {
      const step = active();
      if (step) step.detail = text;
    },
    note: (text) => {
      if (!state.notes.includes(text)) state.notes.push(text);
    },
  };
}

function seconds(from: number, to: number): string {
  const value = Math.max(to - from, 0) / 1000;
  if (value < 60) return `${value.toFixed(1)}s`;
  const minutes = Math.floor(value / 60);
  return `${minutes}m ${Math.round(value - minutes * 60)}s`;
}

export interface PanelOptions {
  tui: Pick<TUI, "requestRender">;
  theme: Theme;
  keybindings: KeybindingsManager;
  state: ProgressState;
  cancel: () => void;
}

export class ProgressPanel implements Component {
  private frame = 0;
  private readonly timer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly options: PanelOptions) {
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.options.tui.requestRender();
    }, FRAME_MS);
  }

  get cancelled(): boolean {
    return this.options.state.cancelled;
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
  }

  handleInput(data: string): void {
    if (!matchesKey(data, "escape")) return;
    this.options.state.cancelled = true;
    this.options.cancel();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme, state } = this.options;
    const now = Date.now();
    const labelWidth = Math.max(...state.steps.map((step) => visibleWidth(step.label)));
    const mark = state.cancelled
      ? theme.fg("warning", "■")
      : theme.fg("accent", FRAMES[this.frame] ?? FRAMES[0]!);
    const lines = [
      `${theme.fg("accent", "◆ explain-code")} ${theme.fg("dim", "·")} ${state.meta.filename} ${theme.fg("dim", "·")} ${state.meta.lines} 行 ${theme.fg("dim", "·")} ${state.meta.language}`,
      theme.fg("muted", `  ${state.meta.model}`),
      "",
    ];
    for (const step of state.steps) {
      const elapsed = step.startedAt
        ? seconds(step.startedAt, step.endedAt ?? now).padStart(6)
        : " ".repeat(6);
      const glyph =
        step.state === "done"
          ? theme.fg("success", "✓")
          : step.state === "active"
            ? mark
            : theme.fg("dim", "○");
      const label = step.label.padEnd(labelWidth);
      const name =
        step.state === "pending"
          ? theme.fg("dim", label)
          : step.state === "active"
            ? theme.fg("text", label)
            : theme.fg("muted", label);
      const detail = step.detail ? `  ${theme.fg("dim", step.detail)}` : "";
      lines.push(`  ${glyph} ${name}  ${theme.fg("muted", elapsed)}${detail}`);
    }
    if (state.notes.length > 0) {
      lines.push("", ...state.notes.map((note) => theme.fg("text", `  ${note}`)));
    }
    lines.push(
      "",
      theme.fg(
        "dim",
        `  ${state.cancelled ? "正在取消" : "esc 取消"} · 已用 ${seconds(state.startedAt, now)}`,
      ),
    );
    return lines.map((line) => truncateToWidth(line, width));
  }
}

export function notify(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(text, type);
  else console.error(text);
}

function fallbackProgress(ctx: ExtensionCommandContext): Progress {
  const status = (text: string) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
    else console.error(text);
  };
  let label = "";
  return {
    stage: (key) => {
      label = STAGES.find((stage) => stage.key === key)?.label ?? key;
      status(`explain-code · ${label}`);
    },
    detail: (text) => status(`explain-code · ${label} · ${text}`),
    note: () => {},
  };
}

export async function withProgress<T>(
  ctx: ExtensionCommandContext,
  meta: Meta,
  cancel: (reason: Error) => void,
  work: (progress: Progress) => Promise<T>,
): Promise<T> {
  if (ctx.mode !== "tui") {
    try {
      return await work(fallbackProgress(ctx));
    } finally {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }

  const state = createState(meta);
  let settle: (() => void) | undefined;
  let settled = false;
  const finish = () => {
    settled = true;
    settle?.();
  };
  const screen = ctx.ui.custom<void>((tui, theme, keybindings, done) => {
    const panel = new ProgressPanel({
      tui,
      theme,
      keybindings,
      state,
      cancel: () => cancel(new Error("cancelled")),
    });
    settle = () => {
      panel.dispose();
      done();
    };
    if (settled) settle();
    return panel;
  });
  try {
    return await work(progressFor(state));
  } finally {
    finish();
    await screen.catch(() => {});
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

export function openCommand(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [target] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", target] };
  return { command: "xdg-open", args: [target] };
}

export function openPath(target: string, failed: (message: string) => void): void {
  const { command, args } = openCommand(process.platform, target);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error) => failed(`could not open ${target}: ${error.message}`));
  child.unref();
}

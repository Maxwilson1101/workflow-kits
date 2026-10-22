import { readFileSync } from "node:fs";
import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export default function previewExtension(pi: ExtensionAPI) {
  const prompt = readFileSync(new URL("./prompt.md", import.meta.url), "utf8").trim();
  let pending = false;

  pi.on("session_start", () => {
    pending = false;
  });

  pi.registerMessageRenderer<{ args: string }>("preview-request", (message, _options, theme) => {
    const args = message.details?.args ?? "";
    return new Text(theme.fg("accent", "/preview") + (args ? ` ${args}` : ""), 0, 0);
  });

  pi.registerCommand("preview", {
    description: "预览关键改动并确认是否实施",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("请在交互模式中使用 /preview", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等待当前任务结束后再使用 /preview", "warning");
        return;
      }
      pending = true;
      const requirements = args.trim();
      pi.sendMessage(
        {
          customType: "preview-request",
          content: requirements ? `${prompt}\n\nAdditional requirements:\n${requirements}` : prompt,
          display: true,
          details: { args: requirements },
        },
        { triggerTurn: true },
      );
    },
  });

  pi.registerTool({
    name: "preview_confirm",
    label: "Confirm preview",
    description:
      "After presenting the implementation preview requested by /preview, ask the user whether to implement it. Never use this tool before presenting the preview or outside a /preview request.",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _params, signal, _onUpdate, ctx) {
      function result(approved: boolean, text: string) {
        return {
          content: [{ type: "text" as const, text }],
          details: { approved },
        };
      }
      if (!pending || ctx.mode !== "tui" || signal?.aborted) {
        return result(
          false,
          "Implementation is not authorized. Wait for the user's next instruction.",
        );
      }
      pending = false;

      const approved = await ctx.ui.custom<boolean>((tui, theme, _kb, done) => {
        const container = new Container();
        const border = () => new DynamicBorder((text) => theme.fg("accent", text));
        const list = new SelectList(
          [
            { value: "implement", label: "立即实施" },
            { value: "cancel", label: "取消，继续讨论" },
          ],
          2,
          {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", text),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          },
        );
        list.onSelect = (item) => done(item.value === "implement");
        list.onCancel = () => done(false);
        container.addChild(border());
        container.addChild(new Text(theme.bold("是否实施以上改动？")));
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ 选择 · Enter 确认 · Esc 取消")));
        container.addChild(border());

        const abort = () => done(false);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();

        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput(data) {
            list.handleInput(data);
            tui.requestRender();
          },
          dispose() {
            signal?.removeEventListener("abort", abort);
          },
        };
      });

      return approved && !signal?.aborted
        ? result(true, "The user approved the preview. Implement only the previewed changes.")
        : result(
            false,
            "The user cancelled. Do not modify files. Acknowledge briefly and wait for the user's next instruction.",
          );
    },
  });
}

import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export type ReviewChoice = "execute" | "edit" | "discuss" | "cancel";

export async function showReview(
  ctx: ExtensionContext,
  content: string,
  signal?: AbortSignal,
): Promise<ReviewChoice> {
  if (signal?.aborted) return "cancel";

  return ctx.ui.custom<ReviewChoice>((tui, theme, keys, done) => {
    const markdown = new Markdown(content, 0, 0, getMarkdownTheme(), undefined, {
      preserveOrderedListMarkers: true,
      preserveBackslashEscapes: true,
      renderLatex: false,
    });
    let offset = 0;
    let height = 1;
    let finished = false;
    const finish = (choice: ReviewChoice) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      done(choice);
    };
    const abort = () => finish("cancel");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    return {
      render(width) {
        const lines = markdown.render(width);
        height = Math.max(1, tui.terminal.rows - 9);
        offset = Math.max(0, Math.min(offset, Math.max(0, lines.length - height)));
        return [
          theme.fg("accent", theme.bold("Review worklist")),
          "",
          ...lines.slice(offset, offset + height),
          theme.fg(
            "dim",
            `${offset + 1}-${Math.min(offset + height, lines.length)} / ${lines.length} · Up/Down, PgUp/PgDn, Home/End`,
          ),
          theme.fg("accent", "A. Execute through commit"),
          theme.fg("accent", "B. Edit, then execute through commit"),
          theme.fg("accent", "C. Discuss again"),
          theme.fg("dim", "Esc / Ctrl+C: cancel without executing"),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data) {
        if (keys.matches(data, "tui.select.cancel") || matchesKey(data, Key.ctrl("c"))) {
          finish("cancel");
          return;
        }
        for (const [key, choice] of [
          ["a", "execute"],
          ["b", "edit"],
          ["c", "discuss"],
        ] as const) {
          if (matchesKey(data, key) || matchesKey(data, Key.shift(key))) {
            finish(choice);
            return;
          }
        }
        if (keys.matches(data, "tui.editor.cursorUp")) offset--;
        else if (keys.matches(data, "tui.editor.cursorDown")) offset++;
        else if (keys.matches(data, "tui.editor.pageUp")) offset -= height;
        else if (keys.matches(data, "tui.editor.pageDown")) offset += height;
        else if (matchesKey(data, Key.home)) offset = 0;
        else if (matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
        else return;
        tui.requestRender();
      },
      invalidate() {
        markdown.invalidate();
      },
      dispose() {
        signal?.removeEventListener("abort", abort);
      },
    };
  });
}

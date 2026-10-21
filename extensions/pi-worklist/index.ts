import { defineTool, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { editWorklist, resolveEditorCommand } from "./src/editor.ts";
import { showReview } from "./src/review.ts";

type ReviewResult =
  | { decision: "execute"; content: string }
  | { decision: "discuss" }
  | { decision: "cancel"; reason: string };

function reviewResult(result: ReviewResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    structuredContent: result,
  };
}

const worklistParameters = Type.Object(
  { content: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

interface WorklistPreview {
  content: string;
}

const previewEntry = "worklist-preview";

export default function (pi: ExtensionAPI) {
  pi.registerEntryRenderer<WorklistPreview>(
    previewEntry,
    (entry) =>
      new Markdown(
        entry.data?.content ?? "",
        pi.getSettings().outputPad ?? 1,
        0,
        getMarkdownTheme(),
        undefined,
        {
          preserveOrderedListMarkers: true,
          preserveBackslashEscapes: true,
          renderLatex: false,
        },
      ),
  );

  pi.registerTool(
    defineTool<typeof worklistParameters, ReviewResult>({
      name: "review_worklist",
      label: "Review worklist",
      description:
        "Present a proposed worklist for user review before implementation. " +
        "The user may approve it, edit and approve it, or return to discussion. " +
        "Only an execute decision authorizes implementation through local commits.",
      promptSnippet:
        "Present an editable worklist and obtain approval to execute through local commits.",
      promptGuidelines: [
        "When the user asks to see or review the worklist, inspect relevant context and call review_worklist before implementation. Do not start mutations alongside the review call.",
        "Prepare one Markdown worklist containing key proposed code diffs, a summary of documentation changes, and the intended commit description. Include all decision-relevant changes, not every mechanical edit. State when a section does not apply.",
        "An execute result authorizes work according to its complete content, including user revisions. Do not request another routine confirmation or regenerate the worklist; implement, verify, create focused local commits, then recap the changes, verification, commit IDs, and remaining issues.",
        "Preserve unrelated user changes and commit only task-related work. Follow repository instructions. Do not push unless separately authorized. Report blockers or material scope conflicts rather than concealing failures to produce a commit.",
        "A discuss result means return to conversation to clarify what is wrong. Do not implement or generate another worklist until the user requests it. A cancel result grants no execution approval; stop and await the user.",
      ],
      parameters: worklistParameters,
      outputSchema: Type.Union([
        Type.Object({ decision: Type.Literal("execute"), content: Type.String() }),
        Type.Object({ decision: Type.Literal("discuss") }),
        Type.Object({ decision: Type.Literal("cancel"), reason: Type.String() }),
      ]),
      executionMode: "sequential",
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (ctx.mode !== "tui") {
          return reviewResult({
            decision: "cancel",
            reason: "Worklist review requires interactive TUI mode.",
          });
        }
        if (signal?.aborted || !params.content.trim()) {
          return reviewResult({
            decision: "cancel",
            reason: "Review aborted or worklist is empty.",
          });
        }
        try {
          pi.appendEntry<WorklistPreview>(previewEntry, { content: params.content });
          const choice = await showReview(ctx, signal);
          if (signal?.aborted || choice === "cancel") {
            return reviewResult({ decision: "cancel", reason: "Review cancelled." });
          }
          if (choice === "discuss") return reviewResult({ decision: "discuss" });
          if (choice === "execute")
            return reviewResult({ decision: "execute", content: params.content });

          const content = await editWorklist(
            ctx,
            params.content,
            resolveEditorCommand(pi.getSettings().externalEditor),
            signal,
          );
          if (content === undefined || signal?.aborted) {
            const reason =
              "Editing was cancelled, failed, or produced an empty worklist. No execution was approved.";
            ctx.ui.notify(reason, "warning");
            return reviewResult({ decision: "cancel", reason });
          }
          return reviewResult({ decision: "execute", content });
        } catch (error) {
          const reason = `Worklist review failed: ${error instanceof Error ? error.message : String(error)}. No execution was approved.`;
          ctx.ui.notify(reason, "error");
          return reviewResult({ decision: "cancel", reason });
        }
      },
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold("Review worklist")), 0, 0);
      },
      renderResult(result, options, theme) {
        const review = result.details;
        if (review?.decision === "execute") {
          return options.expanded
            ? new Markdown(review.content, 0, 0, getMarkdownTheme())
            : new Text(theme.fg("success", "Approved: execute through local commits."), 0, 0);
        }
        return new Text(
          review?.decision === "discuss"
            ? "Return to discussion. No execution approved."
            : (review?.reason ?? "No execution approved."),
          0,
          0,
        );
      },
    }),
  );
}

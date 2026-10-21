import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ReviewChoice = "execute" | "edit" | "discuss" | "cancel";

const options = [
  { label: "Execute through commit", choice: "execute" },
  { label: "Edit, then execute through commit", choice: "edit" },
  { label: "Discuss again", choice: "discuss" },
] as const;

export async function showReview(
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<ReviewChoice> {
  const selected = await ctx.ui.select(
    "Review worklist",
    options.map((option) => option.label),
    { signal },
  );
  return options.find((option) => option.label === selected)?.choice ?? "cancel";
}

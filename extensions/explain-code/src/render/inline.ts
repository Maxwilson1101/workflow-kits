export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

export function escapeAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

export function renderInline(text: string): string {
  return text
    .split("`")
    .map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : escapeHtml(part)))
    .join("");
}

export function renderParagraphs(paragraphs: readonly string[], className?: string): string {
  const attribute = className ? ` class="${className}"` : "";
  return paragraphs.map((text) => `<p${attribute}>${renderInline(text)}</p>`).join("\n");
}

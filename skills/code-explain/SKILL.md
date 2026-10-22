---
name: code-explain
description: Generate a minimal, standalone HTML page that explains source code through syntax highlighting and expandable inline annotations. Use when asked to turn a code snippet or file into an interactive code walkthrough or explanation page.
---

# Code Explain

Create one self-contained HTML file from the supplied code. Support any programming language; write explanations in the user's language.

## Compose

- Read the source and identify its purpose, semantic sections, and important state changes. If no code or source location is available, ask for it; invent an example only when requested.
- Preserve source text, indentation, order, and line numbers. For an excerpt, retain its original line numbers and make its scope clear.
- Group contiguous lines by meaning. Explain intent and non-obvious behavior rather than paraphrasing every statement.
- Give each section a short heading and concise explanation. Include an intermediate value or output only when it helps; label assumed inputs and illustrative results. Never imply code was executed unless it was.

## Render

Read [components](references/components.md) for the HTML, CSS, and JavaScript pattern; adapt the content and repeat sections as needed.

- Keep the complete code visible. Clicking a section reveals its explanation immediately below it, highlights the section, and closes any other explanation. Clicking it again closes it.
- Initially expand the first section containing core logic, rather than setup or sample data. Keep markup and accessibility state consistent.
- Use a warm light background, restrained syntax colors, monospace code, continuous line numbers, and generous outer whitespace. Keep explanations visually subordinate to code.
- Include only a short page title, source filename when known, code, and explanations. Do not add navigation, toolbars, instruction text, decorative cards, or unrelated controls.
- Preserve native button keyboard behavior and visible focus. Keep long lines horizontally scrollable inside their code region; let explanations wrap on narrow screens.
- Pre-mark syntax tokens with spans. Escape source text as HTML before adding markup, including literal HTML and script tags; do not interpolate source into executable JavaScript.
- Inline all CSS and the small interaction script. Use system fonts and no framework, CDN, external assets, network requests, runtime highlighter, or build step. The file must work when opened directly offline.

## Deliver

Write to the requested path, or `code-explained.html` by default. Return a link to the file with a brief description. No browser session, generated test page, or automated validation is required. Do not claim checks that were not performed.

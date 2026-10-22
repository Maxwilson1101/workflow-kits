---
name: code-explain
description:
  Create standalone HTML code walkthroughs with inline Chinese explanations. Use
  when asked to explain a source file.
---

# Code Explain

## 1. Understand the source

Read the supplied source. Inspect related code as needed to understand
responsibilities, control flow, state changes, and dependencies. Distinguish
verified behavior from inferred intent, and label assumptions or illustrative
results. Only claim execution or checks actually performed.

## 2. Plan the walkthrough

Focus on responsibilities, design intent, and significant behavior.

- Follow source order, with one section per top-level function. Start with a
  brief introduction, then show the complete function. Describe inputs, outputs,
  and special behavior where they help understanding.
- Keep nested functions in their enclosing function's section without
  duplicating code. For long functions, place collapsed explanations at key
  lines; keep the function body continuous within one code component.
- Preserve source text, indentation, order, and original line numbers. Mark
  excerpts clearly; do not simplify the code.

## 3. Write the file

Adapt [the template](assets/annotated-code.html), replacing its example with the
source and explanations. Keep its layout and interactions in one self-contained
HTML file that works offline. Escape source text before adding syntax spans;
never embed it in executable JavaScript.

Write to `/tmp/<slug>.html`. Draft explanations in Chinese. Make this pass
complete; wording is revised next.

## 4. Revise the wording

Revise only after the file exists. Read
[the writing guide](references/writing-guideline.zh.md), then apply it to the
written page. Preserve technical meaning; leave the source code unchanged.

Change only `<h2>`, `<h3>`, `<p>` and the reply text. Source lines, line
numbers, annotation anchors and template structure stay as written.

Judge wordiness, run-on sentences and style against the guide's examples. Then
run the gate from this skill's directory and fix every failure:

```sh
./scripts/check.mjs /tmp/<slug>.html --source <source_file>
```

The gate covers Chinese spacing, heading shape, source fidelity line by line,
annotation anchors and offline packaging. Rerun it until it passes; do not
report a page that fails it.

Return the link with a brief description.

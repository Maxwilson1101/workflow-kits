# Inline explanation components

Combine these fragments into one HTML document. Repeat the section pattern for each semantic block; replace example content and pre-mark tokens for the source language. All markup is authored ahead of time; JavaScript only changes disclosure state.

## Structure

Each button's `aria-controls` must match its explanation's unique `id`. The initial open section has `is-active`, `aria-expanded="true"`, and no `hidden` attribute on its explanation; all others use the opposite state. Number blank source lines too; explanations do not consume line numbers. Escape source text (`&`, `<`, `>`) before wrapping tokens.

```html
<main>
  <h1>Sum a sequence</h1>
  <article aria-label="Source code and explanations">
    <div class="filename">sum.py</div>
    <section class="code-section is-active">
      <button
        type="button"
        class="code-trigger"
        aria-label="Sum the values, lines 1 to 2"
        aria-expanded="true"
        aria-controls="explanation-sum"
      >
        <span class="code-lines">
          <span class="code-line"
            ><span class="line-number" aria-hidden="true">1</span
            ><code
              >values = [<span class="tok-number">2</span>, <span class="tok-number">3</span>]</code
            ></span
          >
          <span class="code-line"
            ><span class="line-number" aria-hidden="true">2</span
            ><code>total = <span class="tok-function">sum</span>(values)</code></span
          >
        </span>
        <span class="chevron" aria-hidden="true">›</span>
      </button>
      <div id="explanation-sum" class="explanation">
        <h2>Accumulate the values</h2>
        <p><code>sum</code> adds the sequence's elements, producing one total.</p>
        <div class="result"><span>Result</span><code>5</code></div>
      </div>
    </section>
  </article>
</main>
```

Omit `.filename` when no filename is known. Omit `.result` when a concrete value does not aid understanding. The example is a component pattern, not content to retain in generated pages.

## Styles

```css
:root {
  color: #353831;
  background: #faf9f6;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  --accent: #ae593b;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
main {
  max-width: 904px;
  margin: auto;
  padding: 64px 32px;
}
h1 {
  margin: 0 0 32px;
  font-size: 32px;
  font-weight: 600;
}
article {
  padding: 16px 0;
  border-block: 1px solid #deded5;
}
.filename {
  padding: 0 20px 18px;
  font: 12px var(--mono);
  color: #64685c;
}
.code-section + .code-section {
  margin-top: 12px;
}
.code-trigger {
  position: relative;
  display: flex;
  width: 100%;
  margin: 0;
  padding: 6px 30px 6px 0;
  border: 0;
  border-left: 2px solid transparent;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.code-trigger:hover {
  background: #efeee8;
}
.code-trigger:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.is-active .code-trigger {
  background: #f0eee5;
  border-left-color: var(--accent);
}
.code-lines {
  display: block;
  width: 100%;
  min-width: 0;
  overflow-x: auto;
}
.code-line {
  display: flex;
  min-width: max-content;
  min-height: 25px;
}
.line-number {
  flex: 0 0 48px;
  padding-right: 16px;
  text-align: right;
  font: 11px/25px var(--mono);
  color: #85897d;
  user-select: none;
}
.code-line code {
  padding-right: 8px;
  white-space: pre;
  font: 13px/25px var(--mono);
  user-select: text;
  -webkit-user-select: text;
}
.tok-string {
  color: #63805b;
}
.tok-keyword {
  color: #956385;
}
.tok-number,
.tok-boolean {
  color: #a76035;
}
.tok-function {
  color: #51758a;
}
.tok-comment {
  color: #777b70;
}
.chevron {
  position: absolute;
  top: 7px;
  right: 12px;
  color: #777b70;
}
.is-active .chevron {
  transform: rotate(90deg);
  color: var(--accent);
}
.explanation {
  padding: 18px 26px 20px 48px;
  border-left: 2px solid var(--accent);
  background: #f5f1e9;
}
.explanation[hidden] {
  display: none;
}
h2 {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: #8d5138;
}
.explanation p {
  margin: 8px 0;
  color: #696b60;
  font-size: 13px;
  line-height: 1.9;
}
.explanation code {
  font: 12px/1.7 var(--mono);
  overflow-wrap: anywhere;
}
.result {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 15px;
  align-items: baseline;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid #e4dfd3;
  font-size: 11px;
  color: #696b60;
}
@media (max-width: 640px) {
  main {
    padding: 32px 16px;
  }
  h1 {
    font-size: 26px;
  }
  .line-number {
    flex-basis: 36px;
    padding-right: 10px;
  }
  .code-line code {
    font-size: 12px;
  }
  .explanation {
    padding: 16px 14px 18px 36px;
  }
}
```

## Interaction

Native buttons handle Tab, Enter, and Space without custom keyboard listeners. This script keeps the highlight, disclosure, and accessibility state in sync. A pointer selection within source text does not toggle the explanation; keyboard activation still works.

```js
(() => {
  const buttons = [...document.querySelectorAll(".code-trigger")];

  function setExpanded(button, expanded) {
    button.setAttribute("aria-expanded", String(expanded));
    button.closest(".code-section").classList.toggle("is-active", expanded);
    document.getElementById(button.getAttribute("aria-controls")).hidden = !expanded;
  }

  buttons.forEach((button) => {
    button.addEventListener("click", (event) => {
      const selection = window.getSelection();
      if (
        event.detail > 0 &&
        selection &&
        !selection.isCollapsed &&
        (button.contains(selection.anchorNode) || button.contains(selection.focusNode))
      ) {
        return;
      }
      const shouldOpen = button.getAttribute("aria-expanded") !== "true";
      buttons.forEach((item) => setExpanded(item, item === button && shouldOpen));
    });
  });
})();
```

(() => {
  document.querySelectorAll(".note-toggle").forEach((button) => {
    const note = document.getElementById(button.getAttribute("aria-controls"));
    const block = button.closest(".code-component");
    const rows = [...block.querySelectorAll(".line")].filter(
      (row) =>
        Number(row.dataset.line) >= Number(button.dataset.start) &&
        Number(row.dataset.line) <= Number(button.dataset.end),
    );
    const updateHighlight = () => {
      const active = button.getAttribute("aria-expanded") === "true";
      const preview = button.matches(":hover, :focus-visible");
      rows.forEach((row) => row.classList.toggle("is-highlighted", active || preview));
    };
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      note.hidden = !expanded;
      updateHighlight();
    });
    ["mouseenter", "mouseleave", "focus", "blur"].forEach((event) =>
      button.addEventListener(event, updateHighlight),
    );
  });
})();

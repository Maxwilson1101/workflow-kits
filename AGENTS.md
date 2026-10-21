# Repository Guidelines

Discuss the purpose, scope, expected behavior, and trade-offs before proposing
concrete changes.

Before implementation, preview the importance changes for review and revision.
Summarize the key changes of documents. Show the important code changes in diff.

Apply TDD to extensions changes only.

## Documentation

- Write `.zh.md` files in Chinese and all other files in English.
- Hard-wrap Markdown at around 80 columns.

## Code Style

- Follow KISS and YAGNI.
- Group cohesive logic; keep layouts clear and avoid fragmentation.
- No comments. Keep code simple, direct, and self-explanatory.

## Commands

Use `bun run` package scripts instead of invoking tools directly.

- `bun run format [paths...]`: format files; omit paths for the whole repo.
- `bun run typecheck`: type-check the repo.
- `bun run test`: run all workspace tests.
- `bun run --filter <package> test`: run one workspace's tests.

## Git

- Keep commits focused and atomic.
- Use English commit subjects: `area: description`.
- Prefer a relevant, consistent area such as extensions, skills, docs, tests,
  ci, or repo.
- Use a concise, imperative description of the change.

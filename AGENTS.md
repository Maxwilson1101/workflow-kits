# Repository Guidelines

## Documentation

- Write content under `docs/` in Chinese; use `.zh.md` for Markdown files.
- Use English outside `docs/`, including agent configs, skills, and prompts.
- Hard-wrap Markdown at around 80 columns.

## Code Style

- Follow KISS and YAGNI.
- Group cohesive logic; keep layouts clear and avoid fragmentation.
- Mirror `src` organization in `tests`.

## Commands

Use `bun run` package scripts instead of invoking tools directly.

- `bun run format [paths...]`: format files; omit paths for the whole repo.
- `bun run typecheck`: type-check the repo.
- `bun run test`: run all workspace tests.
- `bun run --filter <package> test`: run one workspace's tests.

## Git

- Use English commit subjects: `area: description`.
- Established areas: `docs`.
- Commit different idea documents separately.

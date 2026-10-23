# Workflow kits

Workflow kits 是一个组织日常工作流小组件的 monorepo，包括 pi configs、dot
files、cli utilities，以及可复用的内部 package。

目前正在快速迭代，target scope 随时可能变更。

## 目录结构

| 路径              | 内容                        |
| ----------------- | --------------------------- |
| `extensions/`     | Pi 扩展，每个扩展独立可加载 |
| `.pi/extensions/` | 项目内的小型扩展            |

## 组件退役

以下联网组件已退役：

- `pi-web-fetch`：抓取网页并缓存 Markdown。
- `pi-wikipedia`：搜索并保存 Wikipedia 条目。
- `pi-arxiv`：搜索 arXiv 元数据并下载 PDF。
- `@workflow-kits/http`：共享代理与传输实现。

检索与抓取职责迁移到独立的本机 search/fetch system service。代理、TTL、限流、
重试和缓存由 service 负责，Pi 侧不再维护这些运行时策略。

- 设计讨论：https://github.com/Maxwilson1101/workflow-kits/discussions/14
- 迁移跟踪：https://github.com/Maxwilson1101/workflow-kits/issues/15

## 开发

```sh
bun install
bun run format
bun run typecheck
bun run test
bun run --filter <package> test
```

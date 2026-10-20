# pi-maintain-threads

为 agent 提供维护 threads 工具，支持获取上下文，以及创建、更新和关闭维护
threads。工具通过 `gh api` 调用 GitHub REST API，操作 issues 与评论，承接可重复
的获取、整理和写入操作。

是否值得记录、是否属于同一事项、如何理解关联，以及是否应结束跟进，仍由 agent
结合语境判断。

## 术语

| 术语      | 含义                                                                |
| --------- | ------------------------------------------------------------------- |
| Thread    | 围绕一个维护事项组织的记录，包含标题、正文及后续 updates。          |
| Update    | 追加到 thread 的记录，用于保留观察、进展与判断变化。                |
| Reference | Thread 之间的引用，用于说明背景来源、历史经验或后续跟进等具体关系。 |
| Close     | 关闭 thread，表示该事项不再独立跟进，但保留已有记录。               |

## 主要功能

工具使用当前项目对应的仓库，通过 `number` 定位 thread。

以下使用 TypeScript 类型简写描述接口，实现时使用等价的 TypeBox schema。`number`
为正整数，输入中的标题、正文和 cursor 不得为空，输入对象不接受未声明的字段。

多个工具使用以下返回类型：

```ts
type ThreadState = "open" | "closed";

type ThreadResult = {
  number: number;
  state: ThreadState;
};
```

### 列出与读取

#### `thread_list`

列出 thread，支持按开放、关闭或全部状态获取，默认获取全部状态。返回标题和正文摘
录，帮助辨认事项；摘录不代表最新状态。

```ts
type Input = {
  state?: ThreadState | "all";
  cursor?: string;
};

type Output = {
  threads: {
    number: number;
    title: string;
    state: ThreadState;
    excerpt: string;
  }[];
  nextCursor: string | null;
};
```

将返回的 `nextCursor` 传入下一次调用的 `cursor`，可以继续获取。只有 `nextCursor`
为 `null`，才表示已经遍历完当前筛选结果。

`cursor` 是工具封装的续读标记，不是 GitHub REST API 的原生字段。工具根据 REST
分页信息生成该标记，调用方只需原样传回。

已关闭的 thread 仍可能提供判断依据。支持获取全部 thread，不意味着每次维护操作都
必须读取全部内容。

#### `thread_read`

读取指定 thread 的完整正文及 updates，后者按时间顺序排列。工具内部处理分页，
不能静默省略内容并报告读取成功。

```ts
type Input = { number: number };

type Output = {
  number: number;
  title: string;
  state: ThreadState;
  body: string;
  updates: {
    body: string;
    author: string;
    createdAt: string;
  }[];
};
```

### 创建与更新

正文描述事项当前的背景、问题、范围与已明确的方向；update 保留事项的发展过程。
理解或判断发生变化时，可能同时需要修订正文和追加 update。

Reference 在正文或 update 中表达，不设置独立字段或工具。引用应说明具体关系，
不自动表示依赖、父子关系或责任转移。

#### `thread_create`

通过标题和正文创建新的 thread。

```ts
type Input = { title: string; body: string };
type Output = ThreadResult;
```

#### `thread_revise`

完整替换指定 thread 的正文，不追加 update。替换前应读取现有内容，保留仍然有效的
信息。

```ts
type Input = { number: number; body: string };
type Output = ThreadResult;
```

#### `thread_append_update`

向指定 thread 追加 update，不自动修订正文。

```ts
type Input = { number: number; body: string };
type Output = { number: number };
```

### 关闭

#### `thread_close`

关闭指定 thread，不自动修订当前或其他 thread 的正文。

```ts
type Input = { number: number };
type Output = ThreadResult;
```

问题解决、讨论形成结论或决定不再推进，都可能导致关闭，具体取决于 thread 的目标
与剩余工作。关闭不意味着历史经验失效，已有 reference 也不必因此删除。

工具描述中包含以下 guard：

> 关闭 thread 前，检查是否有其他 thread 引用它，以及关闭是否会使相关正文中的
> 描述不再准确；如有需要，修订相关正文。

该 guard 仅提醒 agent 检查，不做程序化阻断，也不增加专用引用检查接口、确认状态
或引用管理机制。

## 范围边界

本阶段不包含：

- 自动分类 thread 或构建关系地图；
- 自动判断并修订受引用关系影响的正文；
- 删除 thread。

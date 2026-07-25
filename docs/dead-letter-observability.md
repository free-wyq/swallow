# 死信队列可观测性设计

> 状态：**已实现**（随死信队列主体落地，见 `orchestrator.ts`，+288 行，`tsc --noEmit` 通过）。本文固化已落地的可观测契约 + 剩余盲区，供外部 agent 消费者与维护者参照。
>
> 相关：死信队列主体设计见 [dead-letter-design.md](./dead-letter-design.md)；orchestrator 既有可观测机制（events 轮转 / 心跳 / ctx 探针）见 memory `orchestrator-sdk.md`。

## 1. 要解决的问题

24h 无人值守，外部 agent 不能盯日志。死信队列是"任务做不下去了"的**异常路径**——外部 agent 必须能不读全量日志就答出四问：

1. **现在在拆任务吗？**（dead_letter 队列非空）
2. **离死循环兜底还有多远？**（dlq_split_count 接近 30 = 滑向死循环）
3. **兜底停了吗？**（dead_letter_exhausted 触发，watch 已停）
4. **哪些 task/goal 做不了？**（failed_tasks 内容，人工介入要看具体）
5. **拆分自己卡死了吗？**（splitTask 挂住，心跳冻结）

**原则**：复用现有三层可观测面（events / state / status+report），**不为死信队列另起一条观测通道、不起常驻进程盯自己**——与 orchestrator 既有可观测原则一致（检测靠外部 agent，orchestrator 不盯自己）。

## 2. 三层可观测面（沿用既有，零新基础设施）

| 层 | 载体 | 回答的问题 | 死信队列落点 |
|---|---|---|---|
| 事件层 | `events.jsonl`（append-only 审计流） | **发生了什么**（转移、拆分、失败、兜底） | 5 个新事件 |
| 状态层 | `state.json`（恢复点快照，原子写） | **当前是什么状态**（队列里有什么、拆了几轮、哪些真失败） | 3 个新字段 |
| 查询层 | `--status` / `--status --json` / `--report` | 把上两层**组织给人或程序读** | DLQ 摘要块 |

死信队列可观测性全部落在这三层，**不新增文件、不新增进程**。

## 3. 事件层（events.jsonl）——发生了什么

5 个新事件，跟现有 `tick_started`/`session_dropped` 同模式（append-only，可 grep，轮转归档）：

| 事件 | 触发 | data | 外部 agent 怎么用 |
|---|---|---|---|
| `task_to_dlq` | tick 爆达限（ctx_overflow）入死信队列 | `{task}` | 统计"多少 task 因 ctx_overflow 进队" |
| `bootstrap_to_dlq` | bootstrap 爆/截断入死信队列 | `{goal, reason, partial_count}` | reason 区分 `ctx_overflow`/`truncate`，partial_count 看截断程度 |
| `task_split` | splitTask 拆出子项 | `{content, child_count, type}` | **反查死循环**：grep 同一 content 反复出现 = 拆了又爆回去的那个项 |
| `task_failed` | splitTask 自爆/拆不出 | `{content, reason: "split_failed"}` | 统计真失败项 |
| `dead_letter_exhausted` | 兜底停（两指标任一达限） | `{failed_count \| split_count, limit}` | 区分是 `failed_count`（横向失败累计）还是 `split_count`（纵向死循环）触发的停 |

**状态 vs 事件分离**：队列当前内容（有哪些待拆项）进 state，事件只记转移（入队/出队/失败）。事件不重复队列快照——避免每 tick 膨胀 events。

## 4. 状态层（state.json）——当前状态

3 个新字段（`StateJson` interface，`DEFAULT_STATE` 补默认，`readStateJson` 的 `{...DEFAULT_STATE, ...obj}` 自动向前兼容旧 state）：

| 字段 | 类型 | 语义 | 外部 agent 读法 |
|---|---|---|---|
| `dead_letter` | `DeadLetterItem[]` | 待拆队列（**暂态**，出队即移除父项） | `length > 0` = 有拆分在进行 |
| `failed_tasks` | `DeadLetterItem[]` | 真失败册（**终态只进不出**，人工核实） | 内容即"做不了的 task/goal 清单" |
| `dlq_split_count` | `number` | splitTask 累计调用次数（单调增） | `dlq_split_count / 30` 比例 = 离死循环兜底多远 |

`DeadLetterItem`（3 字段，见 dead-letter-design §4.1）：`{type: "goal"\|"task", content, ts}`。

## 5. 查询层（--status / --json / --report）

三种消费者，各取所需：

### 5.1 `--status`（人读）

```
死信队列: 2 项待拆 | splitTask 累计 7/30 | 真失败 1/5
  待拆（暂态）:
    [task] 实现用户认证模块（含 JWT 签发、刷新令牌、中间件鉴权） @ 2026-07-25 14:23:01
    [goal] 构建完整电商系统 @ 2026-07-25 14:25:33
  真失败（终态，人工核实）:
    [task] 对接第三方支付沙箱环境 @ 2026-07-25 13:10:45
```

一行摘要（队列长度 + splitTask 累计 + 真失败计数）+ 两段列表（待拆 / 真失败），每项截断 80 字符防刷屏。

### 5.2 `--status --json`（程序读）

`buildStatusSnapshot()` 输出的 JSON 含 `dead_letter` 对象：

```json
{
  "dead_letter": {
    "queue_len": 2,
    "dlq_split_count": 7,
    "dlq_split_limit": 30,
    "failed_count": 1,
    "failed_task_limit": 5,
    "queue": [{"type":"task","content":"实现用户认证模块...","ts":"2026-07-25 14:23:01"}],
    "failed": [{"type":"task","content":"对接第三方支付沙箱环境","ts":"2026-07-25 13:10:45"}]
  }
}
```

外部工具（python/node/jq/任何能读 JSON 的）无需解析人类文本即可消费，跨平台零依赖。

### 5.3 `--report`（运行报告）

事件累计计数 + 队列状态摘要：

```
  task_to_dlq: 3
  bootstrap_to_dlq: 1
  task_split: 7
  task_failed: 1
  dead_letter_exhausted: 0

--- 死信队列 ---
  待拆队列: 2 项 | splitTask 累计 7/30
  真失败册: 1/5（达限停 watch）
  真失败内容（终态，人工核实）:
    [task] 对接第三方支付沙箱环境 @ 2026-07-25 13:10:45
```

## 6. 外部 agent 监控契约

四类信号 + 检测方法（外部 agent 定时 `--status --json` 读即可，不必 grep 事件）：

| 信号 | 检测方法 | 严重度 |
|---|---|---|
| **拆分进行中** | `dead_letter.queue_len > 0`（或最近有 `task_split` 事件） | 信息 |
| **接近死循环** | `dlq_split_count / dlq_split_limit > 0.8`（24/30 预警） | 警告 |
| **兜底停了** | `last_termination.reason === "dead_letter_exhausted"` 或 events 有 `dead_letter_exhausted` | 告警（需人工介入） |
| **拆分卡死** | `last_heartbeat_at` 冻结 > 60min 且 `dead_letter.queue_len > 0` 且 `status=running` | 告警（splitTask 挂住） |

**拆分卡死的判定复用既有 watch 卡死机制**：splitTask 期间不跑 runOneTask → 不触发 onHeartbeat → `last_heartbeat_at` 冻结。外部 agent 对比当前时间超 `ABORT_TIMEOUT_MIN`(60min) + running 判卡死——和 watch 干活卡死同一套判定，不为 splitTask 特判。

## 7. 已知盲区（接受，记一笔）

**① splitTask 期间心跳冻结**：死信出队"不跑 runOneTask"（dead-letter-design §6.3），而心跳靠 runOneTask 的 onHeartbeat 触发。所以 splitTask 单轮期间 `last_heartbeat_at` 不更新——和现有 ctx 探针盲区（探针期间心跳不更新，memory `orchestrator-sdk.md` 已记）同性质。**仍能被发现**：splitTask 单轮应远短于 60min，冻结超阈值仍被卡死判定捕获。不为 splitTask 起专属心跳通道（违背简单原则）。

**② events 轮转归档最旧 task_split**：死循环的反查靠 grep `task_split` 的 content 链看哪个反复出现。`EVENTS_ROTATE_LINES`(5000) 滚动归档，最旧的 `task_split` 可能进 `events.jsonl.1`。`EVENTS_ARCHIVE_KEEP=1` 保留 1 个归档 + 死循环通常近 5000 行内可见——可接受。若需更长回溯：先扫当前 events，再扫归档文件。

**③ 两个兜底终态不区分**：`dead_letter_exhausted` 事件用 `failed_count` vs `split_count` 字段区分哪个指标触发的，但 `last_termination.reason` 都是 `"dead_letter_exhausted"`（不看事件看不出是横向失败还是纵向死循环）。外部 agent 要区分需读事件的 data 字段——可接受（终态已停 watch，区分只是定位用）。

## 8. 不做（边界）

- **不起常驻看门狗 / 不起专属 DLQ 心跳通道**——同 orchestrator 既有原则：检测靠外部 agent，orchestrator 不盯自己（零常驻开销）。
- **不做 metrics export**（Prometheus 等）——文件结构化落盘（state + events + --json）够用，外部 agent 按需读，不绑死单一 metrics 体系。
- **不把死信队列内容写进 events**——状态 vs 事件分离：队列当前内容进 state，事件只记转移。每 tick 快照进 events 会膨胀。
- **不做实时推送**——orchestrator 不发战报/不推送（既有原则），告警由外部 agent 定时读结果自组织。

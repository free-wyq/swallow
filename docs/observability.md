# 可观测性设计

> swallow 的可观测性:让外部 agent 不读全量日志就能回答"系统现在怎样、发生过什么、要不要人工介入"。本文是**整个工程**的可观测契约,死信队列是其中一节(§3.8),不是全部。
>
> 相关:死信队列主体见 [dead-letter-design.md](./dead-letter-design.md);架构与既有机制背景见 memory `orchestrator-sdk.md`。

## 1. 原则

- **复用三层可观测面**(events / state / query),不为某功能另起观测通道、不起常驻进程盯自己。
- **状态 vs 事件分离**:当前状态进 state.json,转移进 events.jsonl(事件不重复快照,避免膨胀)。
- **检测靠外部 agent**:orchestrator 只落盘 + 暴露读出口,告警/判定由外部 agent 定时读结果自组织(零常驻开销)。
- **跨平台零依赖**:`--status --json` 输出单一 JSON,任何能读 JSON 的工具(python/node/awk/jq)可消费,不绑死 jq。

## 2. 三层可观测面

| 层 | 载体 | 回答 | 写入方式 |
|---|---|---|---|
| 事件层 | `events.jsonl`(append-only 审计流,5000 行轮转归档) | 发生了什么(转移/异常) | `appendFileSync` 原子单行(< PIPE_BUF) |
| 状态层 | `state.json`(恢复点快照,write-file-atomic 原子写) | 当前是什么状态 | tick 出口 + 心跳节流 30s |
| 日志层 | `night_run.log`(人类可读逐行操作日志,5000 行轮转归档) | 正在做什么(`log()` 写入) | `appendFileSync` 原子单行 |
| 查询层 | `--status` / `--status --json` / `--report` | 把上几层组织给人或程序读 | 只读,不落新盘 |

## 3. 信号目录(按关注维度)

### 3.1 tick 生命周期与崩溃检测
- `tick_started` / `tick_completed` 配对(同 tick_id),**无配对的 tick_completed = 该 tick 崩溃**(可检测)。
- `loop_count`:轮数计数(state.json schema 字段,不改名——改它丢恢复点)。
- `last_tick_at` / `last_tick_id`:最近一轮时间与 id。

### 3.2 任务进度
- `.task.md` 是进度真相源:`[ ]` 未完成 / `[x]` 完成 / `[~]` 阻塞。remaining/total/done/blocked 实时读。
- `had_any_commit`:全程是否有过真 commit(防假完成守卫——remaining=0 但零 commit = 疑假完成)。

### 3.3 会话健康
- `session_dropped` 事件 + `session_retries` / `SESSION_RETRY_LIMIT(3)`:连续弃会话计数,满 3 标阻塞或入死信队列。
- `status` 字段取值:`running` / `idle` / `completed` / `blocked_suspect` / `ctx_overflow_retry`。
- `suspected_false_completion` 事件:remaining=0 但有 `[~]` 阻塞或零 commit → 疑假完成挂起(不设 last_termination,待人工)。

### 3.4 上下文健康度探针
- `last_input_tokens`(上轮 `usage.input_tokens`)+ `ctx_max_tokens`(`getContextUsage` 实测,GLM 代理报 200000)。
- 下轮入口占比超 `CTX_RECYCLE_RATIO(0.7)` → 发 `/compact deep` 探针:`compact_probe_ok`/`compact_probe_failed` 事件带 `pre`/`post`/`freed`/`compress_ratio`/`trigger_threshold`/`max_tokens`。
- ⚠️ **post 不可作"压缩后真实占用"判据**:post 是本地分词(只算摘要文本),不含 resume 时引擎重载的 system prompt + 工具定义 + 历史结构开销。下轮真实 `usage.input_tokens` 仍涨回 15-20 万。"每轮触发探针"是稳态节律非 bug——会话历史每轮涨,每轮压一次维持可工作状态 = 设计意图。

### 3.5 watch 存活
- `last_heartbeat_at`:`runOneTask` 期间 PostToolUse hook 触发、节流 `HEARTBEAT_FLUSH_MS(30s)` 落盘。外部 agent 对比 `now() - last_heartbeat_at > ABORT_TIMEOUT_MIN(60min)` 且 `status=running` → 判卡死。
- `last_tick_at`:runOneTask 期间冻结(看不出推进),靠心跳区分"卡死 vs 正常推进"。
- `.pid` 文件 + `watchRunning()` 探活(发 `kill(pid, 0)`)。

### 3.6 终止
- `last_termination`:`done`(正常完成)/ `dead_letter_exhausted`(死信兜底停)。防 cron 完成后空转刷屏。
- `bootstrap_completed` 事件。

### 3.7 events + night_run.log 轮转
- `EVENTS_ROTATE_LINES(5000)` / `LOG_ROTATE_LINES(5000)` 滚动归档(rename 原子),各保留 1 个归档(`events.jsonl.1` / `night_run.log.1`)。
- 两者机制同构:`log()` / `appendEvent()` 写入时累计行数,超阈值调 `rotateLog()` / `rotateEvents()` 滚动。防 append-only 长跑涨到几百 MB。
- events 累计计数进 `state.event_counts`(轮转丢明细不丢计数);旧 state 无此字段时 `countEvents` 回退扫文件(向前兼容)。
- `--report` 的 night_run.log 异常 grep 读「当前 + .1 归档」拼接,轮转后不丢历史。

### 3.8 死信队列(lazy 拆)
- state:`dead_letter`(待拆,暂态)/ `failed_tasks`(拆到底做不了,终态)/ `dlq_split_count`(splitTask 累计,防死循环)。
- 事件:`task_to_dlq` / `bootstrap_to_dlq` / `task_split`(带 content+child_count+type)/ `task_failed` / `dead_letter_exhausted`(带 `failed_count` 或 `split_count` 区分横向/纵向)。
- 两兜底:`failed_tasks>=5`(横向,拆不出累计)/ `dlq_split_count>=30`(纵向,死循环)→ watch 停。
- 详见 [dead-letter-design.md](./dead-letter-design.md)。

## 4. 消费出口

### 4.1 `--status`(人读)
多行实时状态:goal / 进度 / loop_count / status / stall / session_retries / **死信队列摘要**(队列长度 + splitTask 累计 + 真失败册内容,每项截断 80 字符)/ last_tick_at / last_heartbeat_at(含阈值提示)/ watch 进程。

### 4.2 `--status --json`(程序读)
`buildStatusSnapshot()` 汇单一 JSON:`status`/`goal`/`tasks`/`loop_count`/`context`/`had_any_commit`/`stall`/`session_retries`/`dead_letter`(含 `queue_len`/`dlq_split_count`/`dlq_split_limit`/`failed_count`/`failed_task_limit`/`queue`/`failed`)/时间戳/watch 进程/events 末尾 8 条。跨平台零依赖。
> ⚠️ 外部脚本解析数字字段时注意:`FORCE_COLOR` 环境下 node `console.log` 会给数字加 ANSI 色(`\x1b[33m`),污染字符串比较。消费方应用 `env -u FORCE_COLOR` 或读 JSON.parse 后取值,不比较原始 stdout 字符串。

### 4.3 `--report`(运行报告)
事件累计计数(含死信 5 事件)+ 死信队列状态摘要 + watch 进程。

## 5. 外部 agent 监控契约

定时 `--status --json` 即可回答,不必 grep 全量日志:

| 信号 | 检测方法 | 严重度 |
|---|---|---|
| 推进中 | `loop_count` 在涨 / 有新 `tick_started` | 信息 |
| 任务卡住 | `stall_count` 接近 `STALL_LIMIT` / `status=blocked_suspect` | 警告 |
| 上下文紧 | `last_input_tokens/ctx_max_tokens > 0.7` / 有 `compact_probe_failed` | 警告 |
| **watch 卡死** | `now - last_heartbeat_at > 60min` 且 `status=running` | 告警 |
| 拆分进行中 | `dead_letter.queue_len > 0` | 信息 |
| 接近死循环 | `dlq_split_count / dlq_split_limit > 0.8` | 警告 |
| 兜底停了 | `last_termination=dead_letter_exhausted` | 告警(人工介入) |
| 疑假完成 | 有 `suspected_false_completion` 事件 | 告警(人工介入) |

## 6. 已知盲区(接受,记一笔)

- **探针/splitTask 期间心跳冻结**:`probeCompactDeep` 与死信出队 `splitTask` 都不跑 `runOneTask` → 不触发 onHeartbeat → `last_heartbeat_at` 不更新。与 §3.4 同性质。单轮应远短于 60min,冻结超阈值仍被卡死判定捕获。不为它们起专属心跳(违背简单原则)。
- **events 轮转归档最旧事件**:反查死循环靠 grep `task_split` 的 content 链看哪个反复出现,最旧可能进 `events.jsonl.1`(KEEP=1 保留)。死循环通常近 5000 行内可见;需更长回溯先扫当前再扫归档。
- **两死信兜底终态同名**:`last_termination.reason` 都是 `dead_letter_exhausted`,区分横向/纵向需读事件 data(`failed_count` vs `split_count`)。

## 7. 不做(边界)

- 不起常驻看门狗 / 不起专属心跳通道(检测靠外部 agent)。
- 不做 metrics export(Prometheus 等)——文件结构化落盘够用,不绑死单一 metrics 体系。
- 不把队列快照写进 events(状态 vs 事件分离,避免每 tick 膨胀)。
- 不做实时推送(orchestrator 不发战报,既有原则)。

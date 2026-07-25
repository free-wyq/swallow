---
name: swallow-scheduler
description: "用于要持续干很久、人不想盯着的活——如「帮我把这个项目从零搭起来」「自动把缺陷表里失败的项全修了」「跑一晚上把这个功能做完」。swallow 自主拆任务、写代码、跑测试、提交，24 小时无人值守。"
---

# Swallow Scheduler

swallow 自驱推进开发任务、把结果结构化落盘，**不发战报、不推送**；外部 agent（你）定时读结果、组织战报、推送到你的频道。

## 铁律（外部 agent 必须遵守）

- 只把任务目标（goal）交给脚本，脚本自己拆任务。
- 禁止编辑 `.task.md`。
- 禁止自己拆任务——无论从哪里抠任务都不行。

推进靠 `--watch` 长进程，崩了重启续跑（重启后从 `state.json` 恢复点继续，不丢进度、不重复打勾）。

推进靠 `--watch` 长进程，崩了重启续跑（重启后从 `state.json` 恢复点继续，不丢进度、不重复打勾）。

> 没装好先看 [install.md](../install.md)（装好 → 注册进你的 skills 目录 → 配密钥）。本文只讲怎么用、怎么看状态、怎么发战报。

## 用法

```bash
swallow --cwd <项目> "目标"       # 拉起推进（--watch 自驱）
swallow --cwd <项目> --status     # 实时状态（人看）
swallow --cwd <项目> --status --json   # 结构化 JSON（程序读，跨平台零依赖）
swallow --cwd <项目> --report     # 运行报告
swallow --cwd <项目> --stop        # 临时停（写 .stop 哨兵）
swallow --cwd <项目> --resume     # 恢复（删 .stop）
```

⚠️ 目标项目绝不能是 swallow 仓库自身——会污染 git 历史。
⚠️ 停 swallow 用 `--stop`，别 `kill -9` watch 父进程——`--stop` 发 SIGTERM 会联动终止 claude 子进程后干净退出；`kill -9` 会让 claude 子进程变孤儿继续烧 token。`--resume` 清哨兵恢复。

## 结构化结果（你发战报的数据源）

### state.json（恢复点快照）

```jsonc
{
  "goal": "构建一个 Go REST API",
  "loop_count": 15,                  // 已跑轮数
  "status": "running",               // running/idle/completed/blocked_suspect/ctx_overflow_retry
  "last_tick_at": "2026-07-24 14:00:00",    // 上轮 tick 时间
  "last_heartbeat_at": "2026-07-24 14:00:30", // runOneTask 期间的心跳，判 watch 卡死
  "last_termination": null,          // {reason:"done",ts}|null，非 null=已结束
  "stall_count": 0,                  // 当前任务连续空转次数
  "had_any_commit": true,            // 是否有过真实 commit
  "last_input_tokens": 164814,       // 上轮上下文占用
  "ctx_max_tokens": 200000,         // 模型上下文窗口
  "event_counts": {"task_completed": 14, "task_stall": 1},  // 事件累计计数
  "dead_letter": [],                  // 死信队列（爆掉的 task/goal 待拆，暂态）
  "failed_tasks": [],                 // 真失败册（拆到底做不了，终态）
  "dlq_split_count": 0                 // splitTask 累计调用次数（防死循环）
}
```

`last_termination.reason` 取值：`done`（正常完成）/ `dead_letter_exhausted`（死信队列兜底停，横向 `failed_tasks>=5` 或纵向 `dlq_split_count>=30` 任一触发，需人工介入）。

判 watch 卡死：`last_heartbeat_at` 比当前时间老超过 60 分钟且 `status=running` → watch 可能卡死（进程没崩但 query 挂死），需人工介入或重启。`last_tick_at` tick 期间冻结，不能单独判卡死。

### events.jsonl（append-only 审计流）

每行一个事件：`{"ts":"...","type":"task_completed","tick_id":"...","loop_count":15,"data":{...}}`

事件类型：`tick_started` / `tick_completed` / `tick_skipped`（已终止/已锁，跳过） / `tick_locked`（拿锁，并发 watch 第二个触发） / `bootstrap_completed` / `task_completed` / `task_stall` / `task_blocked` / `session_created` / `session_resumed` / `session_dropped` / `aborted` / `done` / `suspected_false_completion` / `compact_probe_ok` / `compact_probe_failed` / `task_to_dlq` / `bootstrap_to_dlq` / `task_split` / `task_failed` / `dead_letter_exhausted` 等。

**判崩溃**：`tick_started` 无同 `tick_id` 的 `tick_completed` = 该 tick 崩溃。
**判并发冲突**：出现 `tick_locked` 说明第二个 watch 试图启动（已被锁挡掉，正常）。
**判已终止空转**：重启后若立刻 `tick_skipped`，多半是 `last_termination` 还在挡（见「已知行为」）。

### .task.md（进度真相源）

任务列表 + 勾选状态：`[ ]` 未完成 / `[x]` 已完成 / `[~]` 阻塞。进度数从这读。

## 发战报

起定时任务读上述文件，按你的判断组织战报。推荐用 `swallow --cwd <项目> --status --json` —— 它已把 state.json + .task.md + events 末尾 + watch 进程汇总成单一 JSON（含 `dead_letter` 块：`queue_len`/`dlq_split_count`/`dlq_split_limit`/`failed_count`/`failed_task_limit`/`queue`/`failed`），跨平台零依赖，不必自己解析 state.json。⚠️ 解析数字字段时若跑在带 `FORCE_COLOR` 的环境，用 `env -u FORCE_COLOR` 或读 `JSON.parse` 后取值，别比较原始 stdout（node 会给数字加 ANSI 色污染断言）。参考格式（非强制）：

```
📊 swallow 战报 20:38

✅ 任务 3：数据库连接池配置 — 已完成
🔄 第 2 轮，剩余 7/8
📋 进行中：任务 4 gateway 规则编译失败时跳过
🔧 当前操作：正在改 src/server.go
⏱ 心跳：20:24:11（启动 20:07:54，已运行 30 分钟）
📊 进度：1/8
🧹 上下文压缩（/compact deep 压缩成功）：81663 → 2611 tokens（压掉 79K，压缩至 3.2%·约 1/31）
```

字段映射：轮数→`loop_count`、剩余/进度→`.task.md`、心跳→`last_heartbeat_at`、空转→`stall_count`、压缩→`compact_probe_ok` 事件、死信拆分→`dead_letter` 块（`queue_len`/`dlq_split_count`/`failed_count`）。`当前操作`、`启动时间`等细粒度项 swallow 无专字段——从 events 末尾事件 / night_run.log 自行推断。

**压缩行数据源（`compact_probe_ok` 事件）**：`pre`（压缩前 token）/ `post`（压缩后 token）同源同量纲成对可比，直接算 `freed = pre - post`（压缩量）、`compress_ratio = post / pre`（压缩比）。⚠️ 这俩是**单次压缩的成对前后值**，别和 `/compact` 命令界面显示的「会话累计流经 1.44M → 当前 1 万」混了——后者 `before` 是会话累计（17 轮累加、量纲不同、不可比压缩比），swallow 探针的 `pre` 是单轮值（≤模型窗口）。两者别放一起比。

接入实战（任务执行 + 定时战报 + 微信推送）：
- [Hermes 实战](../docs/hermes-guide.md)
- [Claude Code 实战](../docs/claude-code-guide.md)

## 已知行为

- **bootstrap 慢属正常**：目标里若含 SPA 链接（腾讯文档等），WebFetch 拿不到表格数据，worker 会写 Playwright 脚本爬取——可能耗时 10+ 分钟但最终能成。别手动预写 `.task.md`（自己拆的任务可能不符合 goal 结构）。
- **项目已 done 后跑新缺陷**：直接重启会被 `state.json` 的 `last_termination={reason:"done"}` 挡掉（tick 直接 already_terminated 跳过）。要继续跑，清掉 `state.json` 的 `last_termination` 字段（置 `null`）或换新 goal 触发重新 bootstrap。`dead_letter_exhausted` 同理（兜底停了 watch，清该字段或换 goal 才能重启）。
- **撞 blocked_suspect 先看探针**：`status=blocked_suspect`（疑假完成）或 `ctx_overflow_retry` 频繁时，查 events.jsonl 有没有 `compact_probe_ok`——有探针压成功说明 ctx 在自我回收；没有就是真撞墙，多半是目标项目上下文太大，可在项目根放 `.claudeignore` 压扫描范围。
- **死信队列兜底停**：`last_termination=dead_letter_exhausted` 说明任务大到连拆都拆不动（横向 5 个不同 task 各自拆不出 / 纵向拆 30 次还在拆 = 子任务互相依赖死循环）。查 events 的 `task_split` 链看是哪个 task 反复爆，人工拆解或换更小 goal。详见 [docs/dead-letter-design.md](../docs/dead-letter-design.md)。
- **死信队列在拆分中**：`--status` 见 `dead_letter.queue_len > 0` 属正常（task 太大一个会话装不下，正在 `splitTask` 拆子项回插）。关注 `dlq_split_count` 接近 30（纵向死循环将至）或 `failed_count` 涨（横向拆不出在累积）——这两个接近上限就是兜底将至的前兆。

## 可观测性

完整信号体系（三层可观测面 + 8 类信号维度 + 外部 agent 监控契约）见 [docs/observability.md](../docs/observability.md)。

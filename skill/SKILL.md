---
name: swallow-scheduler
description: "让 AI 24 小时无人值守自动开发——拉起后自主拆任务、写代码、跑测试、提交，崩了自动续跑。适合「帮我把这个项目从零搭起来」「自动把缺陷表里失败的项全修了」「跑一晚上把这个功能做完」这类要持续干很久、人不想盯着的开发活。"
---

# Swallow Scheduler

swallow 自驱推进开发任务、把结果结构化落盘；外部 agent 定时读结果发战报。

## 铁律（外部 agent 必须遵守）

- 只把任务目标（goal）交给脚本，脚本自己拆任务。
- 禁止编辑 `.task.md`。
- 禁止自己拆任务——无论从哪里抠任务都不行。
- ⚠️ `--cwd` 绝不能指向 swallow 仓库自身——会污染 git 历史。
- ⚠️ 停 swallow 用 `--stop`，别 `kill -9` watch 父进程（`--stop` 联动杀 claude 子进程后干净退出；`kill -9` 留孤儿继续烧 token）。
- ⚠️ 密钥写进 `~/.config/swallow.env`（非交互进程不 source `~/.bashrc`，写别处拿不到）。

推进靠 `--watch` 长进程，崩了重启续跑（从 `state.json` 恢复点继续，不丢进度、不重复打勾）。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

装到中立路径：代码 `~/.local/share/swallow`、命令 `~/.local/bin/swallow`、配置 `~/.config/swallow.env`。`orchestrator.ts` 依赖 swallow 仓库的 `node_modules`（含随 SDK 打包的 claude 引擎），不能单独搬走；要换开发项目改 `--cwd`，别改 orchestrator。

## 用法

```bash
swallow --cwd <项目> "目标"            # 拉起推进（--watch 自驱）
swallow --cwd <项目> --status          # 实时状态（人看）
swallow --cwd <项目> --status --json   # 结构化 JSON（程序读，跨平台零依赖）
swallow --cwd <项目> --report          # 运行报告
swallow --cwd <项目> --stop            # 临时停（写 .stop 哨兵）
swallow --cwd <项目> --resume          # 恢复（删 .stop）
```

## 发战报（你的活）

定时跑 `swallow --cwd <项目> --status --json` —— 已把 state + .task.md + events 末尾 + watch 进程汇总成单一 JSON，跨平台零依赖，不必自己解析 state.json。⚠️ 带 `FORCE_COLOR` 的环境下解析数字字段要用 `env -u FORCE_COLOR` 或读 `JSON.parse` 后取值（node 给数字加 ANSI 色会污染字符串比较）。

文案、频道、频率你自己定。接入实战（拉起 + 定时战报 + 微信推送）见 [docs/hermes-guide.md](../docs/hermes-guide.md) / [docs/claude-code-guide.md](../docs/claude-code-guide.md)。

## 读结果（数据源）

- **`--status --json`** 优先用，含 `status`/`goal`/`tasks`/`loop_count`/`context`/`had_any_commit`/`stall`/`session_retries`/`dead_letter`（`queue_len`/`dlq_split_count`/`dlq_split_limit`/`failed_count`/`failed_task_limit`/`queue`/`failed`）/`last_termination`/`last_heartbeat_at`/`watch`/`event_counts`/`recent_events`。
- **state.json** 恢复点快照（上条已汇总，一般不用直读）。
- **events.jsonl** append-only 审计流，`tick_started` 无同 `tick_id` 的 `tick_completed` = 该 tick 崩溃。
- **.task.md** 进度真相源：`[ ]` 未完成 / `[x]` 完成 / `[~]` 阻塞。

判 watch 卡死：`last_heartbeat_at` 比当前时间老超 60 分钟且 `status=running`（进程没崩但 query 挂死）。

完整信号体系（8 类维度 + 监控契约）见 [docs/observability.md](../docs/observability.md)。

## 已知行为

- **项目已终止后重启被挡**：`last_termination` 非 null（`done` 或 `dead_letter_exhausted`）→ tick 直接跳过。要继续跑：清 `state.json` 的 `last_termination`（置 `null`）或换新 goal。
- **`dead_letter_exhausted` = 任务大到连拆都拆不动**：横向 5 个不同 task 各自拆不出 / 纵向拆 30 次还拆（子任务互相依赖死循环）。查 events 的 `task_split` 链定位反复爆的 task，人工拆解或换更小 goal。
- **`blocked_suspect` / `ctx_overflow_retry` 频繁先看探针**：events 有 `compact_probe_ok` 说明 ctx 在自我回收；没有就是真撞墙，多半目标项目上下文太大，放 `.claudeignore` 压扫描范围。
- **`dead_letter.queue_len > 0` 属正常**：正在 `splitTask` 拆子项回插。`dlq_split_count`→30 或 `failed_count`→5 才是兜底将至的前兆。

死信队列机制详见 [docs/dead-letter-design.md](../docs/dead-letter-design.md)。

## 配置

```bash
cp ~/.local/share/swallow/swallow.env.example ~/.config/swallow.env && chmod 600 ~/.config/swallow.env
# 填 ANTHROPIC_API_KEY=sk-...；走代理加 ANTHROPIC_BASE_URL=http://...:3000、ANTHROPIC_MODEL=glm-5.1
```

限额写死在 `orchestrator.ts` 顶部常量（不读 swallow.env），详见 [install.md](../install.md)。

## 注册成当前 agent 的 skill（可选）

多数 agent 的 skill 扫描器不跟 symlink，要拷真目录：

```bash
SKILLS_DIR=~/.claude/skills   # 换你的 agent：~/.codex/skills · ~/.gemini/skills · ~/.cursor/skills · ~/.hermes/skills
mkdir -p "$SKILLS_DIR"; rm -rf "$SKILLS_DIR/swallow-scheduler"
cp -r ~/.local/share/swallow/skill "$SKILLS_DIR/swallow-scheduler"
find "$SKILLS_DIR/swallow-scheduler" -name SKILL.md   # 应返回一行
```

swallow 升级后重跑刷新。卸载时清该 agent 的 skill 拷贝：`export SWALLOW_SKILL_DIRS=<skills-dir>` 后 `bash install.sh uninstall`。

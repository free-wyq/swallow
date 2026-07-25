# swallow 安装（给 AI 助手读）

> 这是一段给 AI 助手执行的安装指令。读取本文档即感知操作流程，按当前环境自行执行，不要反复询问用户。

## 一条命令装好

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

装到中立路径（不碰任何 agent 私有目录）：代码 `~/.local/share/swallow`、命令 `~/.local/bin/swallow`、配置 `~/.config/swallow.env`（密钥/代理/模型）。已有同名文件自动备份成 `.bak`，不静默覆盖。不改 shell rc（PATH 不在 `~/.local/bin` 会提示加一行）。

装完即用：

```bash
swallow --cwd /path/to/your/project "你的开发目标"   # 推进：--watch 自驱跑到底（一次拉起）
swallow --cwd /path/to/your/project --status        # 实时状态（人看）
swallow --cwd /path/to/your/project --status --json # 结构化 JSON（程序读，跨平台零依赖）
swallow --cwd /path/to/your/project --report        # 运行报告
```

**职责边界**：orchestrator 只管推进 + 把结果结构化落盘（`state.json` + `events.jsonl`），**不发战报**。战报由外部 agent 定时读这些结果自行组织发送。推进靠 `--watch` 长进程，崩了重启续跑，不依赖外部触发。

## 卸载 / 重装 / 升级

```bash
# 卸载（代码/命令/skill symlink 全清，配置留 .bak 备份可恢复）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash -s -- uninstall
# 已装好可直接：bash ~/.local/share/swallow/install.sh uninstall

# 重装（= 干净卸载 + 全新安装，解决 node_modules 脏 / 代码树卡住）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash -s -- reinstall

# 升级（重跑安装命令即可，增量更新，保留本地改动与配置）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

## 前提

- Node 18+（脚本会检查，没有则提示）
- `~/.local/bin` 在 PATH（不在则脚本提示）

## 配置密钥 / 走代理（重要）

cron / systemd / hermes cron 这类**非交互调度器跑的是干净 env，不会 source `~/.bashrc`**——你写在 `~/.bashrc` 里的 `ANTHROPIC_API_KEY` 它们根本拿不到（实测：调度器里得手 export + sed 抠 `~/.bashrc` 才跑得通，极脆、还常触发审批）。

把密钥写进 `~/.config/swallow.env` 一份，orchestrator 启动会自动读进环境（已 export 的不覆盖）：

```bash
cp ~/.local/share/swallow/swallow.env.example ~/.config/swallow.env
chmod 600 ~/.config/swallow.env   # 密钥别让别的用户读到
# 编辑 ~/.config/swallow.env，填 ANTHROPIC_API_KEY=sk-...
#   走代理才加：ANTHROPIC_BASE_URL=http://192.168.241.10:3000
#   走代理才加：ANTHROPIC_MODEL=glm-5.1（及其它 ANTHROPIC_DEFAULT_*_MODEL）
```

> 想换路径：`export SWALLOW_ENV_FILE=/path/to/your.env`。
>
> 限额不在这——写死在 `orchestrator.ts` 顶部常量（见下节）。

## 限额（写死在脚本，不读 swallow.env）

当前大背景 token 不限量（自托管/免费代理模型无按量计费），轮数/预算护栏纯属挡路——所以**限额写死在 `orchestrator.ts` 顶部常量**，不读 swallow.env。

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_TURNS_PER_TASK` | 0（不限） | 单任务最大轮数 |
| `BOOTSTRAP_MAX_TURNS` | 0（不限） | bootstrap（任务拆解）最大轮数 |
| `STALL_LIMIT` | 3 | 同任务连续零改动 N 次标阻塞 |
| `ABORT_TIMEOUT_MIN` | 60 | 单任务超 N 分钟无进展则 abort 重试 |
| `SESSION_RETRY_LIMIT` | 3 | 当前任务连续 ctx 撑爆 N 次：aborted 超时标阻塞 / ctx_overflow 达限入死信队列待拆 |
| `CTX_RECYCLE_RATIO` | 0.7 | 上轮 token 占窗口比超此值 → 下轮先发 `/compact deep` 探针压一轮（取 `compact_metadata.post_tokens` 判定），压不下来再弃会话。0=不启用 |
| `FAILED_TASK_LIMIT` | 5 | 死信队列真失败册累计达此数 → watch 停（goal 整体太难/太碎，横向兜底） |
| `DLQ_SPLIT_LIMIT` | 30 | splitTask 累计调用达此数 → 死信队列清空进 failed_tasks + watch 停（防无限拆死循环，纵向兜底） |
| `EVENTS_ROTATE_LINES` | 5000 | events.jsonl 超 N 行触发轮转（保留近期、归档 `events.jsonl.1`）。0=不轮转 |
| `HEARTBEAT_FLUSH_MS` | 30000 | runOneTask 期间心跳落盘节流间隔。外部 agent 对比 `last_heartbeat_at` 与当前时间判 watch 卡死 |

要改限额改 `orchestrator.ts` 顶部这几行（`0=不限`，`hasLimit(n)=n>0` 自洽），不用动 swallow.env。行为护栏（`STALL_LIMIT` 起往后留正数防死循环；死信两兜底 `FAILED_TASK_LIMIT`/`DLQ_SPLIT_LIMIT` 横纵分工，详见 [docs/dead-letter-design.md](docs/dead-letter-design.md)）。预算护栏已随成本追踪一并移除（token 不限量场景下无意义）。ctx 健康度探针是主动型护栏：窗口大小运行时由 `getContextUsage` 实测（非写死）。轮转「丢明细、不丢计数」——`--report` 累计统计改读 `state.event_counts`，轮转不破坏语义。心跳节流落盘让外部 agent 能判卡死（runOneTask 期间最长 60min，否则 state.json 冻结）。

## 可选：外部 agent 发战报 / 注册 skill

orchestrator 把结果结构化到 `state.json`（恢复点）+ `events.jsonl`（审计流）+ `.task.md`（进度），**不发战报**。由外部 agent 起定时任务读这些结果自行组织发送：

```bash
# 外部 agent 定时读结果（具体由该 agent 的定时机制实现）：
cat /path/to/your/project/state.json          # status/loop_count/last_termination 等
tail -8 /path/to/your/project/events.jsonl    # 最近事件
```

战报文案、推送频道、频率全由 agent 定，orchestrator 不掺和。推进与观察彻底解耦：watch 挂了不影响 agent 读已落盘的结果；agent 挂了不影响 watch 推进。

`--watch` 推进靠长进程，它崩了需重启才继续。要无人值守自动拉起，靠 systemd `Restart=always` / supervisor / agent 守护。

注册 skill 进当前 agent（**拷成真目录，不要用 symlink**）：

多数 agent 的 skill 扫描器用 find/glob 遍历 skills 目录，默认不跟符号链接进子目录——symlink 进去的 skill 对 agent 不可见（实测：`find <skills>/swallow-scheduler -name SKILL.md` 对 symlink 返回空，对真目录正常）。所以拷真目录：

```bash
# 1. 推理你 agent 的 skills 目录（常见位置，按你实际用的判断；不确定就查该 agent 文档）：
#    Claude Code ~/.claude/skills · Codex ~/.codex/skills · Gemini CLI ~/.gemini/skills
#    Cursor ~/.cursor/skills · Hermes ~/.hermes/skills
SKILLS_DIR=~/.claude/skills

# 2. 拷成真目录（swallow 升级后重跑这两行刷新 skill 内容）
mkdir -p "$SKILLS_DIR"
rm -rf "$SKILLS_DIR/swallow-scheduler"
cp -r ~/.local/share/swallow/skill "$SKILLS_DIR/swallow-scheduler"
```

卸载时删那个真目录：`rm -rf "$SKILLS_DIR/swallow-scheduler"`（`install.sh uninstall` 也会顺带清各已知 agent 目录下的 swallow-scheduler，无论 symlink 还是真目录）。你用的 agent 若不在默认列表里，卸载前 `export SWALLOW_SKILL_DIRS=<skills-dir>:<skills-dir>` 再 uninstall，脚本会一并清理。

⚠️ `--cwd` 指向你要开发的目标项目（orchestrator 往那写产物 + git commit）。**别指向 swallow 仓库自身。**

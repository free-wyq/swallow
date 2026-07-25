# swallow 安装（给 AI 助手读）

> 这是给你的安装指令。读到这里就开始执行，按当前环境自行落地，不要反复问用户。三步：装好 → 注册 skill → 会跑。

## 1. 装好

```bash
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

装到中立路径（不碰任何 agent 私有目录）：代码 `~/.local/share/swallow`、命令 `~/.local/bin/swallow`、配置 `~/.config/swallow/swallow.env`。已有同名文件自动备份成 `.bak`，不静默覆盖。不改 shell rc（PATH 不在 `~/.local/bin` 会提示加一行）。前提：Node 18+（脚本会检查，没有则提示）。

### 配密钥

把密钥写进 `~/.config/swallow/swallow.env`（orchestrator 启动自动读进环境，已 export 的不覆盖）。**别塞 `~/.bashrc`**——cron / systemd / hermes cron 这类非交互调度器跑的是干净 env、不 source `~/.bashrc`，塞进去调度器根本拿不到，还常触发审批。

```bash
cp ~/.local/share/swallow/swallow.env.example ~/.config/swallow/swallow.env
chmod 600 ~/.config/swallow/swallow.env   # 密钥别让别的用户读到
# 编辑 ~/.config/swallow/swallow.env，填 ANTHROPIC_API_KEY=sk-...
#   走代理才加：ANTHROPIC_BASE_URL=http://192.168.241.10:3000
#   走代理才加：ANTHROPIC_MODEL=glm-5.1（及其它 ANTHROPIC_DEFAULT_*_MODEL）
```

不走代理只填 `ANTHROPIC_API_KEY`。想换配置路径：`export SWALLOW_ENV_FILE=/path/to/your.env`。

## 2. 注册 skill（必须——你调度 swallow 的入口）

skill（`SKILL.md`）告诉你怎么跑 swallow / 读状态 / 发战报。**用 swallow 前必须注册进你自己的 skills 目录。**

1. 推理你自己的 skills 目录（查你自己的文档/约定，不确定就问用户）。
2. 把源目录 `~/.local/share/swallow/skill` **拷成真目录**（`cp -r`，不要 symlink——多数 agent 的 skill 扫描器用 find/glob 遍历、默认不跟符号链接进子目录，symlink 进去的 skill 你看不见）。
3. 目标名用 `swallow-scheduler`，已存在先删再拷（刷新）。
4. 完成后 `find <你的skills目录>/swallow-scheduler -name SKILL.md` 验证能扫到（应返回一行）。

swallow 升级后重做上面步骤刷新 skill 内容。

## 3. 会跑

```bash
swallow --cwd /path/to/your/project "你的开发目标"   # --watch 自驱跑到底（一次拉起）
swallow --cwd /path/to/your/project --status        # 实时状态（人看）
swallow --cwd /path/to/your/project --status --json # 结构化 JSON（程序读，跨平台零依赖）
swallow --cwd /path/to/your/project --report        # 运行报告
```

⚠️ `--cwd` 指向你要开发的目标项目（orchestrator 往那写产物 + git commit），**别指向 swallow 仓库自身**。

## 卸载 / 重装 / 升级

```bash
# 卸载（代码/命令/skill 拷贝全清，配置留 .bak 备份可恢复）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash -s -- uninstall
# 已装好可直接：bash ~/.local/share/swallow/install.sh uninstall

# 重装（= 干净卸载 + 全新安装，解决 node_modules 脏 / 代码树卡住）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash -s -- reinstall

# 升级（重跑安装命令即可，增量更新，保留本地改动与配置）
curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
```

卸载时 `install.sh uninstall` 会顺带扫各已知 agent 目录（Claude Code / Codex / Gemini / Cursor / Codeium / Windsurf / Hermes）清掉 `swallow-scheduler`（symlink 或真目录拷贝都清）。你若不在这默认列表里，卸载前 `export SWALLOW_SKILL_DIRS=<你的skills-dir>:<skills-dir>` 再 uninstall，脚本会一并清理。

## 可选：你发战报

orchestrator 把结果结构化到 `state.json`（恢复点）+ `events.jsonl`（审计流）+ `.task.md`（进度），**不发战报**。要战报，你自己起定时任务读这些结果自行组织发送：

```bash
cat /path/to/your/project/state.json          # status/loop_count/last_termination 等
tail -8 /path/to/your/project/events.jsonl    # 最近事件
```

文案、推送频道、频率全由你定，orchestrator 不掺和。不需要战报（比如本地开发、自己看状态就够）跳过本节。

## 要调限额

限额写死在 `orchestrator.ts` 顶部常量（token 不限量场景下轮数护栏纯属挡路，行为护栏留正数防死循环），不读 swallow.env。各常量含义见 [docs/observability.md](docs/observability.md) §3，要改改那几行（`0=不限`）。

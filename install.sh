#!/usr/bin/env bash
# swallow 安装 / 卸载 / 重装脚本 —— agent 无关
#
#   安装：  curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash
#   卸载：  curl -fsSL https://raw.githubusercontent.com/free-wyq/swallow/main/install.sh | bash -s -- uninstall
#           （已装好则直接：bash ~/.local/share/swallow/install.sh uninstall）
#           清理新 agent 的 skill 拷贝：export SWALLOW_SKILL_DIRS=<dir>:<dir> 后再 uninstall
#   重装：  ... | bash -s -- reinstall    （= 干净卸载后全新安装，解决 node_modules 脏 / 代码树卡住）
#   升级：  重跑安装命令即可（增量：git pull + npm install，保留你的本地改动与配置）
#
# 装到 POSIX 中立路径（不进任何 agent 私有目录）：
#   代码  ~/.local/share/swallow
#   命令  ~/.local/bin/swallow       (自驱入口，透传参数给 orchestrator.ts)
#   配置  ~/.config/swallow.env       (密钥/代理/模型，chmod 600)
set -euo pipefail

REPO_URL="https://github.com/free-wyq/swallow.git"
DEST="${SWALLOW_HOME:-$HOME/.local/share/swallow}"
BIN_DIR="${SWALLOW_BIN:-$HOME/.local/bin}"
CONF_DIR="${SWALLOW_CONF:-$HOME/.config}"

# 卸载时扫这些 skills 目录清 swallow-scheduler（symlink / 真目录拷贝都清）。
# 只列常见 agent 作默认、尽力而为；新 agent 不在列表里时，export SWALLOW_SKILL_DIRS=<dir>:<dir>
# 追加即可（无需改脚本）。注册时 agent 自由挑 skills 目录，卸载就靠这份列表 + 该扩展口找回来。
AGENT_SKILL_DIRS=(
  "$HOME/.claude/skills" "$HOME/.codex/skills" "$HOME/.gemini/skills"
  "$HOME/.cursor/skills" "$HOME/.codeium/skills" "$HOME/.windsurf/skills"
  "$HOME/.hermes/skills"
)
# 扩展点：SWALLOW_SKILL_DIRS 冒号分隔，追加到已知列表（卸载循环幂等，重复条目无害，不去重）
if [ -n "${SWALLOW_SKILL_DIRS:-}" ]; then
  _saved_ifs="$IFS"; IFS=:
  for _d in $SWALLOW_SKILL_DIRS; do
    [ -n "$_d" ] && AGENT_SKILL_DIRS+=("$_d")
  done
  IFS="$_saved_ifs"
fi

say()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

# 写文件前防覆盖：已存在且非 symlink 且内容不同 → 备份成 .bak，绝不静默覆盖
safe_write() {  # safe_write <path> <content>
  local f="$1"
  if [ -e "$f" ] && [ ! -L "$f" ]; then
    if [ "$2" = "$(cat "$f" 2>/dev/null)" ]; then return; fi  # 内容一致=我们的
    mv "$f" "$f.bak" 2>/dev/null || true
    warn "已有 $f，已备份为 $f.bak（原内容未丢）"
  fi
  printf '%s' "$2" > "$f"
}

# 备份并删除用户数据文件（conf 等），保留 .bak 以防误删
backup_rm() {  # backup_rm <path>
  if [ -e "$1" ] || [ -L "$1" ]; then
    mv "$1" "$1.bak" 2>/dev/null || rm -f "$1"
    say "已备份 $1 → $1.bak"
  fi
}

check_node() {
  command -v node >/dev/null 2>&1 || { err "未检测到 Node。请先装 Node 18+（https://nodejs.org）再重跑。"; exit 1; }
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 18 ] || { err "Node 版本过低（$(node -v)，需 18+），请升级后重跑。"; exit 1; }
}

do_install() {
  check_node
  mkdir -p "$BIN_DIR" "$CONF_DIR"

  # 1. 拉代码（已有则增量更新，不覆盖本地改动）
  if [ -d "$DEST/.git" ]; then
    say "已存在，更新中：$DEST"
    git -C "$DEST" pull --ff-only || { err "git pull 失败（可能有未提交改动）。手动处理 $DEST，或用 reinstall 干净重装。"; exit 1; }
  else
    if [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null)" ]; then
      err "$DEST 非空且非 git 仓库，请移走后重跑，或用 uninstall 清理。"
      exit 1
    fi
    say "拉取代码到 $DEST"
    git clone --depth 1 "$REPO_URL" "$DEST"
  fi

  # 2. 装依赖
  say "安装依赖（npm install）"
  npm install --prefix "$DEST" --silent

  # 3. 装 swallow 命令（路径已固化进脚本，readlink 自定位无关，换机器照样跑）
  say "安装 swallow 命令到 $BIN_DIR"
  safe_write "$BIN_DIR/swallow" '#!/usr/bin/env bash
# swallow —— 24h 无人值守开发 orchestrator 入口，透传所有参数给 orchestrator.ts
exec "'"$DEST"'/node_modules/.bin/tsx" "'"$DEST"'/orchestrator.ts" "$@"
'
  chmod +x "$BIN_DIR/swallow"

  # 4. 配置模板：swallow.env.example 拷到 ~/.config（不覆盖已有，已有让用户自己改——含密钥）
  if [ ! -f "$CONF_DIR/swallow.env" ] && [ -f "$DEST/swallow.env.example" ]; then
    cp "$DEST/swallow.env.example" "$CONF_DIR/swallow.env"
    chmod 600 "$CONF_DIR/swallow.env"
    say "已生成 $CONF_DIR/swallow.env 模板（填 ANTHROPIC_API_KEY 后即可用，已限 600 权限）"
  fi

  # PATH 检查（不替用户改 shell rc，只提示）
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR 不在 PATH。请加一行到 shell 配置：export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac

  echo
  say "安装完成！"
  echo
  echo "  装在：$DEST（代码）  $BIN_DIR/swallow（命令）"
  echo
  echo "  直接跑：    swallow --cwd /path/to/your/project \"你的开发目标\""
  echo "  看状态：    swallow --cwd /path/to/your/project --status"
  echo "  运行报告：  swallow --cwd /path/to/your/project --report"
  echo
  echo "  ⚠️ --cwd 指向你要开发的目标项目，别指向 swallow 仓库自身。"
  echo
  echo "  ⚠️ 配密钥：编辑 $CONF_DIR/swallow.env 填 ANTHROPIC_API_KEY=sk-..."
  echo "     （非交互进程不 source ~/.bashrc，密钥得放这里 orchestrator 才读得到）"
  echo
  echo "  战报/推送：orchestrator 只把结果结构化到 state.json/events.jsonl，"
  echo "  由外部 agent 读这些结果自行组织发送，orchestrator 不发战报。"
  echo
  echo "  注册 skill（可选；多数 agent 的扫描器不跟 symlink，要拷真目录）："
  echo "    cp -r $DEST/skill ~/.claude/skills/swallow-scheduler   # Claude Code（换 agent 换目录）"
  echo "  卸载时清理该 agent 的 skill 拷贝：export SWALLOW_SKILL_DIRS=<skills-dir> 后再 uninstall"
  echo "  卸载：bash $DEST/install.sh uninstall"
}

do_uninstall() {
  local removed=0

  # 1. 清命令文件（含遗留 wrapper .bak 一起清）
  #    保留清理旧的 loop / loop-report / loop-tick（让旧装用户卸干净残留），并新增清 swallow。
  for f in "$BIN_DIR/swallow" "$BIN_DIR/loop" "$BIN_DIR/loop-report" "$BIN_DIR/loop-tick"; do
    if [ -e "$f" ] || [ -L "$f" ]; then rm -f "$f" "$f.bak"; removed=1; fi
  done

  # 2. swallow.env 含密钥 → 备份再删（不静默抹）
  local swallow_env="$CONF_DIR/swallow.env"
  if [ -e "$swallow_env" ]; then
    mv "$swallow_env" "$swallow_env.bak" 2>/dev/null || rm -f "$swallow_env"
    say "swallow.env 已备份 → $swallow_env.bak"
    removed=1
  fi

  # 3. 清各 agent skills 目录里的 swallow-scheduler（symlink 或真目录拷贝都清）
  #    - symlink：只清指向我们 DEST、或因 DEST 已删而悬空的；指向别处的不动
  #    - 真目录：若含 SKILL.md 且 name 是 swallow-scheduler，视为我们的拷贝，删
  for d in "${AGENT_SKILL_DIRS[@]}"; do
    local lk="$d/swallow-scheduler"
    if [ -L "$lk" ]; then
      local tgt; tgt="$(readlink "$lk" 2>/dev/null || true)"
      case "$tgt" in
        "$DEST/skill"|"$DEST"/*) rm -f "$lk"; say "清 skill symlink：$lk"; removed=1 ;;
        *) # 悬空链接（目标已不存在）也清
          [ -e "$tgt" ] || { rm -f "$lk"; say "清悬空 skill symlink：$lk"; removed=1; } ;;
      esac
    elif [ -d "$lk" ] && [ -f "$lk/SKILL.md" ]; then
      # 真目录拷贝：靠 SKILL.md frontmatter 的 name 字段确认是我们的，再删
      if grep -q '^name: *swallow-scheduler' "$lk/SKILL.md" 2>/dev/null; then
        rm -rf "$lk"; say "清 skill 目录：$lk"; removed=1
      fi
    fi
  done

  # 4. 删代码目录（最后删，保证上面的悬空检测先跑）
  if [ -d "$DEST" ]; then rm -rf "$DEST"; removed=1; fi

  if [ "$removed" = 1 ]; then
    echo
    say "已卸载 swallow（代码/命令/skill 已清，配置留 .bak 备份）"
  else
    warn "未检测到 swallow 的安装痕迹，无需卸载"
  fi
}

do_reinstall() {
  say "重装 = 干净卸载 + 全新安装"
  do_uninstall
  echo
  do_install
}

case "${1:-install}" in
  install)   do_install ;;
  uninstall) do_uninstall ;;
  reinstall) do_reinstall ;;
  -h|--help|help)
    sed -n '2,12p' "$0" ;;
  *) err "未知子命令：$1（可用：install / uninstall / reinstall）"; exit 2 ;;
esac

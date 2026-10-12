#!/bin/sh
# 做扩展实验时用这个包装脚本启动 pi，它处理了两件容易踩的事：
#   1. 清掉从宿主会话继承来的 PI_* 环境变量
#      （否则 pi 会把自己当成宿主的一部分，print / JSON 模式会静默无输出）
#   2. 关闭 MSYS/Git-Bash 的路径转换
#      （否则以 / 开头的参数会被改写成 Windows 路径，例如 "/extlab" 变成 "D:/.../extlab"）
#
# 注意：关掉路径转换后，就得自己把启动脚本的路径转成 Windows 形式交给 node，
# 因为 pi 在 Git-Bash 里的本身是个 POSIX shell 包装脚本（它会再 exec node pi-launcher.js）。
#
# 用法：
#   ./run-cli.sh --print --no-session -e ./hello-ext.ts 'Call dir_stats with {"path":"."}'
#   ./run-cli.sh --print --no-session "/extlab"
#   MSYS_NO_PATHCONV= 前缀不生效也没关系，本脚本会强制设置它。

unset PI_SESSION_FILE PI_SESSION_ID PI_CODING_AGENT_SESSION_DIR
unset PI_MODEL PI_PROVIDER PI_REASONING_LEVEL PI_CODING_AGENT

PI_BIN=$(command -v pi 2>/dev/null) || {
	echo "找不到 pi 命令：请把 pi 加入 PATH（或直接改这个脚本里的路径）。" >&2
	exit 1
}

DIR=$(dirname "$PI_BIN")

# 情况 A：pi 是原生可执行文件（Windows 的 .cmd/.exe，或 POSIX 下真正的可执行文件）
case "$PI_BIN" in
	*.cmd|*.exe|*.bat) exec "$PI_BIN" "$@" ;;
esac

# 情况 B：pi 是 POSIX shell 包装脚本，旁边有 pi-launcher.js（本机就是这种）
if [ -f "$DIR/pi-launcher.js" ]; then
	if command -v cygpath >/dev/null 2>&1; then
		DIR=$(cygpath -w "$DIR")   # 转成 Windows 路径，否则 node 会把 /d/... 解析成 C:\d\...
	fi
	MSYS_NO_PATHCONV=1 exec node "$DIR/pi-launcher.js" "$@"
fi

# 情况 C：其它情况直接把参数交给 pi（此时不要强制关路径转换）
exec "$PI_BIN" "$@"

# 扩展示例：hello-ext

一个可直接加载的最小 pi 扩展，外加把它跑通的完整方法。全部步骤都在本机实测通过（pi v1.1.0）。

## 文件

| 文件 | 作用 |
|---|---|
| `hello-ext.ts` | 扩展本体：1 个工具 + 1 个命令 + 1 个钩子 + 会话生命周期 |
| `sdk-test.mjs` | 无头验证：加载扩展 → 发命令 → 调工具 → 断言副作用（**4/4 通过**） |
| `run-cli.sh` | 启动 pi 的包装脚本（清 `PI_*` 变量、关 MSYS 路径转换） |

## 扩展演示了四个扩展点

1. **`pi.registerTool()`** — 工具 `dir_stats`（递归统计文件数与行数）
   - `description` 决定模型**什么时候会想到用它**，要写「做什么 + 何时用」
   - `promptSnippet` 决定它**是否出现在 system prompt 的可用工具列表**（不提供就不列）
   - `annotations: { readOnlyHint: true }` 让审批型扩展可以据此放行
   - `execute` 里调 `onUpdate()` 就会触发 `tool_execution_update` 事件
   - 失败要 `throw`（会被转成 `isError` 工具结果），不要返回错误文本
2. **`pi.registerCommand()`** — 注册 `/extlab` 命令
3. **`pi.on("tool_call")`** — 工具调用前的钩子；写审计日志，返回 `{ block: true, reason }` 即可拦截
4. **`pi.on("session_start" / "session_shutdown")`** — 会话级资源的正确启停位置

## 三种加载方式

```bash
# ① 一次性加载（开发时最常用，不改配置）
pi -e ./examples/hello-ext.ts

# ② 用户级：装进 agent 目录后一直生效（agent-dir 默认 ~/.pi/agent）
cp examples/hello-ext.ts "$PI_CODING_AGENT_DIR/extensions/"     # 或 ~/.pi/agent/extensions/

# ③ 项目级：随项目走，需要项目信任
mkdir -p <项目>/.pi/extensions && cp examples/hello-ext.ts <项目>/.pi/extensions/
```

TypeScript **不需要编译**（pi 用 jiti 直接执行）。改完代码在会话里 `/reload` 生效。

## 三种验证方式（从快到真）

### A. 无头测试（最快，可断言）

```bash
node examples/sdk-test.mjs
```

脚本自己解析 pi 的安装位置，优先级：`PI_PACKAGE_ROOT` → `PI_MANAGED_INSTALL_ROOT`（取
`releases/` 下最新版）→ 裸包名导入。

### B. 让真实模型调用你的工具

```bash
./examples/run-cli.sh --print --no-session -e ./examples/hello-ext.ts \
  'Call the tool dir_stats with {"path":"."} then state the file count.'
```

实测输出：`.: 6 files, 439 lines`

### C. 看事件流，确认工具真的执行了

```bash
./examples/run-cli.sh --mode json --no-session -e ./examples/hello-ext.ts \
  'Call dir_stats with {"path":"."}. Do nothing else.'
```

应出现 `tool_execution_start` / `tool_execution_update` / `tool_execution_end`。
`tool_execution_update` 说明工具的 `onUpdate()` 被调用了。

## 坑清单（都是实测踩到的）

1. **同名扩展已装在用户目录时，`-e` 会直接报冲突**（实测报错）：
   ```
   Error: Failed to load extension "<agent-dir>/extensions/hello-ext.ts":
     Tool "dir_stats" conflicts with <当前目录>/hello-ext.ts
   Hint: Start without extensions using "pi -ne".
   ```
   这是预期行为（工具不能同名）。测试文件副本时加 `-ne`（只加载 `-e` 显式指定的），
   或者先把用户目录那份删掉。
2. **Windows / Git-Bash 会把 `/` 开头的参数当路径转换**：`pi "/extlab"` 到 pi 手里变成
   `D:/.../extlab`，命令不会分发 —— 现象是「命令没反应，模型反而开始自己瞎逛」。
   解决：`MSYS_NO_PATHCONV=1`（`run-cli.sh` 已内置）。
   注意：关掉路径转换后，启动脚本的路径也得自己转成 Windows 形式（`run-cli.sh` 里用 `cygpath -w` 处理）。
3. **SDK 会话必须 `await session.bindExtensions({})`**，CLI 不用（CLI 自动绑定）。
4. **写无头测试时要用 `noExtensions: true` 隔离发现**：否则用户目录已装的同名扩展会一起加载，
   重名命令会被消歧成 `extlab:1` / `extlab:2`，`getCommand("extlab")` 找不到，
   于是 `/extlab` 被当成普通文本发给模型，`prompt()` 会真的发起模型调用甚至长时间不返回。
5. **不要在扩展工厂函数里启动进程 / socket / watcher / 定时器**：有些调用会加载扩展但
   **不启动会话**。长生命周期资源从 `session_start` 起、在幂等的 `session_shutdown` 里释放。
6. **`exposure` 默认值不是「都激活」**：`direct` / `model-only` 注册即激活；
   `codemode` / `deferred` / `hidden` 注册时**不激活**，要显式激活。
7. **`model-only` 的工具不能被其它工具调用**（`ctx.executeTool()` 会报 not found）。
8. **非交互模式没有 UI**：`ctx.ui.notify()` 在 print / JSON 模式下什么都不显示。
   想让命令在这些模式下也可验证，用 `ctx.hasUI` 分支，或写日志。
9. **`tool_call` 钩子抛错 = fail-safe 阻止该工具**（不是忽略错误）。
10. **直接调 `def.execute()` 会绕过 `tool_call` 钩子**（钩子在 agent / 扩展运行时里）。
    要验证「审批钩子能拦住工具」，必须经会话发起真实调用。
11. **扩展与 pi 同进程同权限**：它能读你的文件、凭据、会话历史。只加载信得过的扩展；
    项目级扩展要经过项目信任。

## 环境变量

| 变量 | 作用 |
|---|---|
| `PI_EXT_AUDIT=1` | 开启本扩展的审计日志（默认关闭，避免长期驻留时每个会话都写文件） |
| `PI_PACKAGE_ROOT` | 供 `sdk-test.mjs` 定位 pi 安装位置 |
| `PI_MANAGED_INSTALL_ROOT` | 同上（安装器根目录，脚本取 `releases/` 下最新版） |

审计日志位置：`%TEMP%/pi-ext-audit.log`（或 `/tmp/pi-ext-audit.log`）。

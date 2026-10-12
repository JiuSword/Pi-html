/**
 * 一个可直接加载的最小 pi 扩展，演示四个最常用的扩展点：
 *   1. registerTool      —— 给模型一个真实可调用的工具
 *   2. registerCommand   —— 给用户一个 / 命令
 *   3. pi.on("tool_call") —— 工具调用前的钩子（可审批；审计日志需 PI_EXT_AUDIT=1 才开启）
 *   4. session_start / session_shutdown —— 会话级资源的正确启停位置
 *
 * 用法（任选一种）：
 *   pi -e ./examples/hello-ext.ts                  # 单次加载，不写入配置
 *   cp examples/hello-ext.ts ~/.pi/agent/extensions/    # 装进用户级目录，之后一直生效
 *   mkdir -p <项目>/.pi/extensions && cp ...            # 项目级（需项目信任）
 * 开发时在会话里改完代码用 /reload 重载。
 */

import { readdirSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const AUDIT_FILE = join(process.env.TEMP ?? "/tmp", "pi-ext-audit.log");
/** 审计日志按需开启：长期驻留时默认不写文件，需要时设 PI_EXT_AUDIT=1 */
const AUDIT_ENABLED = process.env.PI_EXT_AUDIT === "1";

/** 递归统计目录：文件数、总行数、按扩展名 Top 5 */
function scanDir(root: string, maxFiles = 5000) {
	const byExt: Record<string, number> = {};
	let files = 0;
	let lines = 0;
	const walk = (dir: string) => {
		if (files >= maxFiles) return;
		let items: string[];
		try {
			items = readdirSync(dir);
		} catch {
			return; // 权限不足等情况，跳过而不是让工具失败
		}
		for (const name of items) {
			if (name === "node_modules" || name === ".git" || name.startsWith(".")) continue;
			const full = join(dir, name);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				walk(full);
			} else if (st.isFile()) {
				files++;
				const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "(no ext)";
				byExt[ext] = (byExt[ext] ?? 0) + 1;
				// 只统计看起来是文本的小文件，避免把二进制读进内存
				if (st.size < 512 * 1024) {
					try {
						lines += readFileSync(full, "utf8").split("\n").length;
					} catch {
						/* 二进制或不可读，忽略 */
					}
				}
			}
		}
	};
	walk(root);
	const top = Object.entries(byExt)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([k, v]) => `${k}=${v}`)
		.join(", ");
	return { files, lines, top, truncated: files >= maxFiles };
}

export default function helloExtension(pi: ExtensionAPI) {
	// ---------------- 1. 工具：目录统计 ----------------
	pi.registerTool({
		name: "dir_stats",
		label: "Dir stats",
		// description 决定模型「什么时候会想到用它」，要写清做什么 + 何时用
		description:
			"Count files and total lines of code in a directory tree, skipping node_modules/.git/hidden dirs. Use when the user asks how big a codebase is or wants a file/line overview.",
		// promptSnippet 会出现在 system prompt 的可用工具列表里（不提供就不列出）
		promptSnippet: "Count files and lines in a directory",
		parameters: Type.Object({
			path: Type.String({ description: "Directory to scan (absolute, or relative to the session cwd)" }),
		}),
		// 只读操作的注解：审批型扩展可以据此放行
		annotations: { readOnlyHint: true },
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const root =
				params.path.startsWith("/") || /^[A-Za-z]:/.test(params.path) ? params.path : join(ctx.cwd, params.path);
			onUpdate?.({ content: [{ type: "text", text: `scanning ${root} ...` }], details: {} });
			const r = scanDir(root);
			return {
				content: [
					{
						type: "text",
						text: `${relative(ctx.cwd, root) || "."}: ${r.files} files, ${r.lines} lines${r.truncated ? " (truncated)" : ""}\nby extension: ${r.top}`,
					},
				],
				details: { root, ...r },
			};
		},
	});

	// ---------------- 2. 命令：/extlab ----------------
	pi.registerCommand("extlab", {
		description: "Show whether this extension is loaded, and audit-log stats",
		handler: async (args, ctx) => {
			// 命令在所有模式下都会加载，但只有交互模式有 UI。
			// 写日志的好处：print / JSON / RPC 下也能验证命令真的执行了。
			if (AUDIT_ENABLED) {
				try {
					appendFileSync(AUDIT_FILE, `${new Date().toISOString()}\t<command:extlab>\targs=${args ?? ""}\n`);
				} catch {
					/* ignore */
				}
			}
			if (ctx.hasUI) ctx.ui.notify(`hello-ext 已加载；参数="${args ?? ""}"；审计日志=${AUDIT_FILE}`, "info");
			else console.log(`[hello-ext] /extlab 已执行，参数="${args ?? ""}"（当前模式无 UI）`);
		},
	});

	// ---------------- 3. 钩子：工具调用前 ----------------
	pi.on("tool_call", async (event) => {
		if (!AUDIT_ENABLED) return undefined;
		try {
			appendFileSync(
				AUDIT_FILE,
				`${new Date().toISOString()}\t${event.toolName}\tparent=${event.parentToolCallId ?? "-"}\n`,
			);
		} catch {
			/* 审计失败不应影响工具执行 */
		}
		// 演示「可拦截」：如需阻止，返回 { block: true, reason: "..." }
		return undefined;
	});

	// ---------------- 4. 会话生命周期：正确的位置 ----------------
	// 注意：不要在工厂函数里起进程/定时器（有些调用会加载扩展但不启动会话）
	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus?.("extlab", "hello-ext active");
	});
	pi.on("session_shutdown", async () => {
		// 必须幂等：取消 / 重载 / 会话替换 / 进程退出可能都走到这里
	});
}

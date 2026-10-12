/**
 * 无头验证：不启动 TUI，直接加载扩展文件、发一条 / 命令、调用一次工具，然后断言副作用。
 * 这是验证扩展最可靠的方式 —— 可断言、可重复、不依赖模型是否配合。
 *
 * 运行：node examples/sdk-test.mjs
 *
 * pi 安装位置的解析顺序（避免把本机路径写死）：
 *   1. 环境变量 PI_PACKAGE_ROOT          —— 指向包含 @earendil-works/* 的 node_modules
 *   2. 环境变量 PI_MANAGED_INSTALL_ROOT  —— 安装器管理的根目录（取 releases 下最新版）
 *   3. 裸包名导入                        —— 项目里自行安装了 pi 的情况
 */

process.env.PI_EXT_AUDIT = "1"; // 必须在扩展被加载【之前】设置：扩展在工厂函数里读取该开关

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(process.env.TEMP ?? "/tmp", "pi-ext-audit.log");

function resolvePackageRoot() {
	if (process.env.PI_PACKAGE_ROOT) return process.env.PI_PACKAGE_ROOT;
	const managed = process.env.PI_MANAGED_INSTALL_ROOT;
	if (!managed) return null;
	const releases = join(managed, "releases");
	if (!existsSync(releases)) return null;
	const versions = readdirSync(releases)
		.filter((v) => existsSync(join(releases, v, "node_modules", "@earendil-works", "pi-coding-agent")))
		.sort();
	return versions.length ? join(releases, versions[versions.length - 1], "node_modules") : null;
}

const root = resolvePackageRoot();
let C;
if (root) {
	C = await import(pathToFileURL(join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
} else {
	try {
		C = await import("@earendil-works/pi-coding-agent");
	} catch {
		console.error(
			"找不到 pi 的安装位置。请设置其一后重试：\n" +
				"  PI_PACKAGE_ROOT=<包含 @earendil-works/* 的 node_modules>\n" +
				"  PI_MANAGED_INSTALL_ROOT=<安装器根目录，脚本取 releases 下最新版>",
		);
		process.exit(1);
	}
}

const results = [];
/** 把可能挂住的调用变成可失败的结果，而不是让脚本卡死 */
const withTimeout = (p, ms) =>
	Promise.race([
		p.then((r) => ({ done: true, value: r })),
		new Promise((r) => setTimeout(() => r({ done: false, value: "TIMEOUT" }), ms)),
	]);
const check = (id, desc, ok, evidence) => {
	results.push({ id, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};

// ---- 1. 加载扩展（等价于 CLI 的 -e，但可断言副作用） ----
const loader = new C.DefaultResourceLoader({
	cwd: here,
	agentDir: C.getAgentDir(),
	settingsManager: C.SettingsManager.inMemory({}),
	// 关键：隔离测试。默认还会从 agentDir（~/.pi/agent/extensions）发现全局扩展；
	// 若那里也装了一份 hello-ext.ts，同一文件会被加载两次。pi 会把重名命令
	// 消歧为 extlab:1 / extlab:2，于是 getCommand("extlab") 失败，/extlab 被当成
	// 普通文本发给模型（会真正发起一次模型调用）。noExtensions 只保留显式路径。
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	additionalExtensionPaths: [join(here, "hello-ext.ts")],
});
await loader.reload();

const loaded = loader.getExtensions();
const commands = loaded.extensions.flatMap((e) => [...(e.commands?.keys?.() ?? [])]);
const tools = loaded.extensions.flatMap((e) => [...(e.tools?.keys?.() ?? [])]);
const dupes = [...new Set([...commands, ...tools].filter((n, i, a) => a.indexOf(n) !== i))];
check(
	"E1",
	"扩展文件被加载，命令与工具都完成注册且无重复",
	commands.includes("extlab") && tools.includes("dir_stats") && dupes.length === 0,
	`命令 = ${JSON.stringify(commands)}，工具 = ${JSON.stringify(tools)}，重复 = ${JSON.stringify(dupes)}，错误 = ${JSON.stringify(loaded.errors?.length ?? 0)}`,
);

// ---- 2. 建会话（SDK 必须显式 bindExtensions；CLI 才自动绑定） ----
const rt = await C.ModelRuntime.create({ refreshOnCreate: false });
const model = rt.getModel("deepseek", "deepseek-flash") ?? (await rt.getAvailable())[0];
const session = (
	await C.createAgentSession({
		cwd: here,
		modelRuntime: rt,
		model,
		resourceLoader: loader,
		settingsManager: C.SettingsManager.inMemory({}),
	})
).session;
await session.bindExtensions({});

// ---- 3. 命令应被分发，而不是当成消息送给模型 ----
try {
	rmSync(AUDIT, { force: true });
} catch {}
const r1 = await withTimeout(session.prompt("/extlab sdk-test"), 30_000);
const returned = r1.done ? r1.value : undefined;
await new Promise((r) => setTimeout(r, 200));
const log = existsSync(AUDIT) ? readFileSync(AUDIT, "utf8") : "";
check(
	"E2",
	"`/extlab` 被当作命令分发（handler 执行），而非送给模型",
	r1.done && !returned && log.includes("<command:extlab>"),
	`prompt() 返回 = ${JSON.stringify(r1.value)}（被 handled 时为空）；审计日志 = ${JSON.stringify(log.trim().slice(0, 110))}`,
);

// ---- 4. 直接调用工具，验证统计逻辑真的能跑 ----
const def = session.getToolDefinition("dir_stats");
let out = "";
let err = "";
try {
	const r = await def.execute("t1", { path: "." }, undefined, undefined, { cwd: here });
	out = (r.content ?? []).map((b) => b.text ?? "").join("");
} catch (e) {
	err = e.message;
}
check(
	"E4",
	"dir_stats 直接调用能产出真实统计",
	/\d+ files, \d+ lines/.test(out),
	err ? `抛错：${err}` : `输出 = ${JSON.stringify(out.slice(0, 150))}`,
);

// ---- 5. 直接调用工具【不走】tool_call 钩子（如实记录这个行为） ----
const log2 = existsSync(AUDIT) ? readFileSync(AUDIT, "utf8") : "";
check(
	"E5",
	"直接调 def.execute() 会绕过 tool_call 钩子（钩子在 agent/扩展运行时里，不在工具定义上）",
	!log2.includes("dir_stats"),
	`审计日志 = ${JSON.stringify(log2.trim().slice(0, 160))}（只有命令那一行，没有 dir_stats）→ 想验证钩子拦截工具，必须经会话发起真实调用`,
);

session.dispose?.();

console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
process.exit(pass === results.length ? 0 : 1);

// 验证矩阵核实 ③：Codemode 沙箱（QuickJS/WASM）
const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-codemode/dist/index.js";
const CM = await import(R);
const results = [];
const check = (id, desc, ok, evidence) => {
	results.push({ id, desc, ok, evidence });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};

const calls = [];
const sandbox = new CM.CodemodeSandbox({
	timeoutMs: 5000,
	tools: [
		{ name: "echo", description: "echo back", execute: async (args) => `echo:${args.text}` },
		{ name: "boom", description: "always throws", execute: async () => { throw new Error("tool failed on purpose"); } },
		{ name: "slow", description: "sleeps", execute: async () => { await new Promise((r) => setTimeout(r, 800)); return "slept"; } },
	],
});

// ---- 1. 工具可调用 + 输出/返回值
{
	const r = await sandbox.execute(`
		const a = await tools.echo({ text: "hi" });
		text(a);
		return 42;
	`);
	calls.push(r);
	check("CM1", "沙箱内 tools.<name>() 可调用，text() 进入 output、return 进入 value", r.ok === true && r.output?.[0]?.text === "echo:hi" && r.value === 42, `ok=${r.ok} output=${JSON.stringify(r.output)} value=${JSON.stringify(r.value)}`);
}

// ---- 2. 沙箱边界：没有 Node / 网络 / 定时器 / 文件系统
{
	const r = await sandbox.execute(`
		const report = {
			process: typeof process,
			require: typeof require,
			fetch: typeof fetch,
			setTimeout: typeof setTimeout,
			Buffer: typeof Buffer,
			__dirname: typeof __dirname,
		};
		return report;
	`);
	calls.push(r);
	const v = r.value ?? {};
	const blocked = ["process", "require", "fetch", "setTimeout", "Buffer", "__dirname"].every((k) => v[k] === "undefined");
	check("CM2", "沙箱内不存在 Node / require / fetch / 定时器 / Buffer（能力仅限注入的工具）", blocked, Object.entries(v).map(([k, val]) => `${k}=${val}`).join(", "));
}

// ---- 3. 工具抛错 → 脚本内 catch 得到 Error
{
	const r = await sandbox.execute(`
		try { await tools.boom({}); return "no-error"; }
		catch (e) { return "caught:" + e.message; }
	`);
	calls.push(r);
	check("CM3", "工具抛错在脚本内表现为可 catch 的 Error（错误不会静默）", r.ok === true && String(r.value).startsWith("caught:"), `value = ${JSON.stringify(r.value)}`);
}

// ---- 4. 脚本失败时的结果形态
{
	const r = await sandbox.execute(`await tools.boom({});`);
	calls.push(r);
	check("CM4", "未捕获的脚本错误 → ok=false 且带 error.kind/message（宿主可判定）", r.ok === false && !!r.error, `ok=${r.ok} error = ${JSON.stringify(r.error)?.slice(0, 130)}`);
}

// ---- 5. 超时是硬截止
{
	const r = await sandbox.execute(`await tools.slow({});`, { timeoutMs: 150 });
	calls.push(r);
	check("CM5", "timeoutMs 是硬截止（150ms 超时 vs 800ms 工具）", r.ok === false && /timeout/i.test(String(r.error?.kind ?? r.error?.message ?? "")), `error = ${JSON.stringify(r.error)?.slice(0, 120)}`);
}

// ---- 6. store / load 跨执行
{
	const saved = {};
	const r1 = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1); return load("runs");`, { store: saved });
	if (r1.ok) Object.assign(saved, r1.storeWrites?.set ?? {});
	const r2 = await sandbox.execute(`store("runs", (load("runs") ?? 0) + 1); return load("runs");`, { store: saved });
	if (r2.ok) Object.assign(saved, r2.storeWrites?.set ?? {});
	calls.push(r1, r2);
	check("CM6", "store/load 跨执行保留状态（第一次 1、第二次 2）", r1.value === 1 && r2.value === 2, `两次执行返回值 = ${r1.value}, ${r2.value}；storeWrites = ${JSON.stringify(r1.storeWrites)}`);
}

// ---- 7. 常量限额与 options 行解析
{
	const opts = CM.parseCodemodeSource(`// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}\ntext("x");`);
	check(
		"CM7",
		"// @options 行被解析，字段名从 snake_case 规范化为 camelCase（源码写 max_output_tokens → 读到 maxOutputTokens）",
		opts.options?.maxOutputTokens === 2000 && opts.options?.timeoutMs === 30000,
		`源码写 {"max_output_tokens":2000,"timeout_ms":30000} → 解析得到 ${JSON.stringify(opts.options)}`,
	);
	check(
		"CM8",
		"限额常量与文档一致：输出 16Mi 字符 / 100000 次调用 / store 单值 256Ki、总量 1Mi",
		CM.MAX_OUTPUT_CHARS === 16777216 && CM.MAX_OUTPUT_ITEMS === 100000 && CM.MAX_STORE_VALUE_CHARS === 262144 && CM.MAX_STORE_TOTAL_CHARS === 1048576,
		`MAX_OUTPUT_CHARS=${CM.MAX_OUTPUT_CHARS}, MAX_OUTPUT_ITEMS=${CM.MAX_OUTPUT_ITEMS}, MAX_STORE_VALUE_CHARS=${CM.MAX_STORE_VALUE_CHARS}, MAX_STORE_TOTAL_CHARS=${CM.MAX_STORE_TOTAL_CHARS}`,
	);
}

// ---- 8. 宿主看得到调用清单，但那是宿主侧的（模型侧不可见，见 SDK 测试）
{
	const r = calls.find((x) => x.ok && x.calls?.length > 0);
	check("CM9", "执行结果带 calls 清单供宿主观测（calls 不进模型上下文，需靠集成层）", !!r, `含 calls 的结果：calls = ${JSON.stringify(r?.calls?.map((c) => c.name ?? c.tool ?? c)?.slice(0, 4))}`);
}

await sandbox.close();
console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) console.log("失败项:", results.filter((r) => !r.ok).map((r) => r.id).join(", "));

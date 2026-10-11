// 验证矩阵核实 ⑤：写一个真实扩展，验证 暴露级别 / prepareLoadout / 审批钩子 / 嵌套调用
// 真实模型（deepseek-flash）+ 真实扩展运行时；提示极短
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const A = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/index.js";
const C = await import(R);
const { Type } = await import(A);

const results = [];
const check = (id, desc, ok, evidence) => {
	results.push({ id, desc, ok, evidence });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};

const tmp = mkdtempSync(join(tmpdir(), "pi-ext-verify-"));
mkdirSync(join(tmp, ".pi"), { recursive: true });

const observed = { executed: [], toolCallEvents: [], nestedParentIds: [], lastPayload: null };
let piRef = null;

const extensionFactory = (pi) => {
	piRef = pi;

	// 父工具：内部用 ctx.executeTool 调另一个工具（嵌套调用）
	pi.registerTool({
		name: "echo_then_count",
		label: "Echo then count",
		description: 'Echo text and count its characters. Call this when asked to echo text.',
		promptSnippet: "SNIPPET-echo_then_count",
		parameters: Type.Object({ text: Type.String() }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			observed.executed.push("echo_then_count");
			const nested = await ctx.executeTool("count_chars", { text: params.text });
			const chars = nested.result?.details?.chars;
			return { content: [{ type: "text", text: `echo=${params.text} chars=${chars}` }], details: { echo: params.text, chars } };
		},
	});

	// 被嵌套调用的工具
	pi.registerTool({
		name: "count_chars",
		label: "Count chars",
		description: "Count characters.",
		promptSnippet: "SNIPPET-count_chars",
		parameters: Type.Object({ text: Type.String() }),
		exposure: "codemode", // 可被其它工具调用（model-only 恰恰不可被调用）
		async execute(_id, params) {
			observed.executed.push("count_chars");
			return { content: [{ type: "text", text: String(params.text.length) }], details: { chars: params.text.length } };
		},
	});

	// 危险工具（annotation 驱动审批）
	pi.registerTool({
		name: "danger_delete",
		label: "Delete",
		description: "Delete a file. Call this when asked to delete a file.",
		promptSnippet: "SNIPPET-danger_delete",
		parameters: Type.Object({ path: Type.String() }),
		annotations: { destructiveHint: true },
		async execute(_id, params) {
			observed.executed.push("danger_delete:" + params.path);
			return { content: [{ type: "text", text: "deleted" }], details: {} };
		},
	});

	// 五种暴露级别（用 promptSnippet 精确判断“是否声明给模型”）
	for (const [name, exposure] of [
		["exp_direct", "direct"],
		["exp_model_only", "model-only"],
		["exp_codemode", "codemode"],
		["exp_deferred", "deferred"],
		["exp_hidden", "hidden"],
	]) {
		pi.registerTool({
			name,
			label: name,
			description: `${name} tool`,
			promptSnippet: `SNIPPET-${name}`,
			parameters: Type.Object({}),
			exposure,
			async execute() {
				return { content: [{ type: "text", text: name }], details: {} };
			},
		});
	}

	// 编排型工具：prepareLoadout 改写描述 + 隐藏另一个工具的声明
	pi.registerTool({
		name: "orchestrator",
		label: "Orchestrator",
		description: "Orchestrates.",
		promptSnippet: "SNIPPET-orchestrator",
		parameters: Type.Object({}),
		exposure: "direct", // 编排型工具自己也是声明的（codemode 就是这样：被显式激活且声明）
		prepareLoadout() {
			return {
				descriptions: { echo_then_count: "CUSTOM-DESCRIPTION-FROM-ORCHESTRATOR" },
			};
		},
		async execute() {
			return { content: [{ type: "text", text: "orchestrated" }], details: {} };
		},
	});

	// 捕获真正发给 provider 的请求载荷（用于验证 prepareLoadout 改写 description）
	pi.on("before_provider_request", (event) => {
		observed.lastPayload = event.payload;
	});

	// 审批网关：注解驱动
	pi.on("tool_call", async (event) => {
		observed.toolCallEvents.push({ name: event.toolName, parent: event.parentToolCallId ?? null });
		if (event.parentToolCallId) observed.nestedParentIds.push(event.parentToolCallId);
		const hints = pi.getAllTools().find((t) => t.name === event.toolName)?.annotations;
		if (hints?.destructiveHint === true) return { block: true, reason: "blocked by approval gateway: destructive tool" };
		return undefined;
	});
};

// ---- 隔离的 loader（不加载用户自己的资源）
const loader = new C.DefaultResourceLoader({
	cwd: tmp,
	agentDir: C.getAgentDir(),
	settingsManager: C.SettingsManager.inMemory({}),
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	extensionFactories: [extensionFactory],
});
await loader.reload();

const rt = await C.ModelRuntime.create({ refreshOnCreate: false });
const model = rt.getModel("deepseek", "deepseek-flash");
const session = (
	await C.createAgentSession({
		cwd: tmp,
		modelRuntime: rt,
		model, // 显式注入模型（否则空设置下无可用模型）
		resourceLoader: loader,
		settingsManager: C.SettingsManager.inMemory({}),
	})
).session;
await session.bindExtensions({});

// ============================== 1. 暴露级别：注册 ≠ 声明
{
	const all = piRef.getAllTools();
	const exposure = Object.fromEntries(all.filter((t) => t.name.startsWith("exp_")).map((t) => [t.name, t.exposure]));
	check("X1", "扩展的工具注册进工具表，五种暴露级别被正确记录", Object.keys(exposure).length === 5 && exposure.exp_codemode === "codemode", `exposure 实测 = ${JSON.stringify(exposure)}`);

	const active = session.getActiveToolNames();
	const declaredToModel = ["exp_direct", "exp_model_only"].filter((n) => active.includes(n));
	const notActivated = ["exp_codemode", "exp_deferred", "exp_hidden"].filter((n) => !active.includes(n));
	check(
		"X2",
		"注册时只有 direct / model-only 被激活；codemode / deferred / hidden 注册后不激活",
		declaredToModel.length === 2 && notActivated.length === 3,
		`激活集 = ${JSON.stringify(active)}；未激活 = ${JSON.stringify(notActivated)}`,
	);

	const callable = session.getCallableToolNames();
	check(
		"X3",
		"可调用集 ⊋ 激活集：codemode / deferred 工具不被声明但仍可被脚本与其它工具调用",
		callable.includes("exp_codemode") && callable.includes("exp_deferred") && !callable.includes("exp_hidden"),
		`codemode 可调用=${callable.includes("exp_codemode")}、deferred 可调用=${callable.includes("exp_deferred")}、hidden 可调用=${callable.includes("exp_hidden")}（hidden 两者都不是）`,
	);

	const prompt = session.systemPrompt;
	const snippets = (s) => prompt.includes(s);
	check(
		"X4",
		"system prompt 只列出被声明的工具的 snippet；codemode/deferred/hidden 不出现在提示词里",
		snippets("SNIPPET-exp_direct") && snippets("SNIPPET-exp_model_only") && !snippets("SNIPPET-exp_codemode") && !snippets("SNIPPET-exp_deferred") && !snippets("SNIPPET-exp_hidden"),
		`prompt 内含：direct=${snippets("SNIPPET-exp_direct")} model-only=${snippets("SNIPPET-exp_model_only")} codemode=${snippets("SNIPPET-exp_codemode")} deferred=${snippets("SNIPPET-exp_deferred")} hidden=${snippets("SNIPPET-exp_hidden")}（prompt ${prompt.length} 字符）`,
	);

	// ---- prepareLoadout：动态激活编排工具后，描述被改写 + 某工具声明被隐藏
	const before = session.systemPrompt.includes("SNIPPET-exp_direct");
	session.setActiveToolsByName([...session.getActiveToolNames(), "orchestrator"]);
	const prompt2 = session.systemPrompt;
	// prepareLoadout 的 descriptions 改写的是【工具声明】里的 description（发给 provider 的 tools），不是 prompt 里的 snippet 列表
	check(
		"X5a",
		"动态激活（setActiveToolsByName）+ prepareLoadout：改写发给模型的工具声明 description",
		session.agent.state.tools.find((t) => t.name === "echo_then_count")?.description === "CUSTOM-DESCRIPTION-FROM-ORCHESTRATOR",
		`echo_then_count 的声明 description = ${JSON.stringify(session.agent.state.tools.find((t) => t.name === "echo_then_count")?.description)}`,
	);
}

// ============================== 2. 真实模型调用：审批钩子 + 嵌套调用
console.log("\n--- 发起真实模型调用 ---");
console.log("    使用模型:", session.model?.provider + "/" + session.model?.id);
// 收窄工具集（但必须保留 count_chars，否则嵌套调用会因为不在 loadout 里而失败）
session.setActiveToolsByName(["echo_then_count", "count_chars", "danger_delete"]);
let promptError = null;
try {
	await session.prompt('Call the tool danger_delete with {"path":"/tmp/x"}, then call the tool echo_then_count with {"text":"hi"}. Do nothing else.');
} catch (e) {
	promptError = e;
}

const msgs = session.messages;
const toolResults = msgs.filter((m) => m.role === "toolResult");
const dangerRes = toolResults.find((m) => m.toolName === "danger_delete");
const echoRes = toolResults.find((m) => m.toolName === "echo_then_count");

if (promptError) console.log("    prompt 异常:", promptError.message?.slice(0, 160));
console.log("    本次消息角色序列:", JSON.stringify(msgs.map((m) => m.role + (m.toolName ? `(${m.toolName})` : ""))));

check(
	"X6",
	"审批钩子（annotations.destructiveHint 驱动）拦下危险工具，且 execute 从未执行",
	dangerRes?.isError === true && !observed.executed.some((x) => x.startsWith("danger_delete")),
	`danger_delete.isError=${dangerRes?.isError}，返回内容 ≈ ${JSON.stringify(dangerRes?.content)?.slice(0, 120)}；实际执行过的工具 = ${JSON.stringify(observed.executed)}`,
);
check("X7", "嵌套调用真的发生（ctx.executeTool 调到了 count_chars）", echoRes !== undefined && observed.executed.includes("count_chars"), `echo_then_count 返回 = ${JSON.stringify(echoRes?.content)?.slice(0, 130)}`);
check(
	"X8",
	"嵌套调用不进 transcript：模型上下文里没有 count_chars 的 toolResult",
	!toolResults.some((m) => m.toolName === "count_chars"),
	`transcript 里的 toolResult = ${JSON.stringify(toolResults.map((m) => m.toolName))}`,
);
check(
	"X9",
	"父工具结果上保留了有界的 nestedCalls 记录（名称/状态，不含结果）",
	Array.isArray(echoRes?.nestedCalls?.calls) && echoRes.nestedCalls.calls.some((n) => n.name === "count_chars" && n.status === "ok"),
	`nestedCalls = ${JSON.stringify(echoRes?.nestedCalls)?.slice(0, 240)}`,
);
check(
	"X10",
	"嵌套调用的事件携带 parentToolCallId，且 tool_call 钩子对嵌套调用同样生效",
	observed.nestedParentIds.length > 0 && observed.toolCallEvents.some((e) => e.name === "count_chars" && e.parent),
	`tool_call 事件序列 = ${JSON.stringify(observed.toolCallEvents)}`,
);

// ============================== 3. SessionManager 权威
{
	const persistedCtx = () => session.sessionManager.buildSessionContext().messages.length;
	const before = session.messages.length;
	const ctxBefore = persistedCtx();
	session.agent.state.messages = [];
	check(
		"X11",
		"给 agent.state.messages 赋值不会改变持久化上下文（SessionManager 才是权威）",
		persistedCtx() === ctxBefore && ctxBefore > 0,
		`持久化上下文 ${ctxBefore} → ${persistedCtx()}（不变 ✓）；而内存视图 session.messages ${before} → ${session.messages.length}（会变，所以只能当视图）`,
	);
}

const stats = session.getSessionStats?.();
console.log("\n本次真实调用统计:", JSON.stringify(stats?.usage ?? stats)?.slice(0, 200));
session.dispose?.();
rmSync(tmp, { recursive: true, force: true });

console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) console.log("失败项:", results.filter((r) => !r.ok).map((r) => r.id).join(", "));

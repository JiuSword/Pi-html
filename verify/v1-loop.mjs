// 验证矩阵核实 ①：Agent 循环层（并行工具 / terminate / 四个钩子）
// 使用 faux provider，脚本化模型响应，确定性、无网络、无 API 费用
const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works";
const { Agent } = await import(`${R}/pi-agent-core/dist/index.js`);
const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText, fauxThinking, Type } =
	await import(`${R}/pi-ai/dist/index.js`);

const results = [];
const check = (id, desc, ok, evidence) => {
	results.push({ id, desc, ok, evidence });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness({ responses, tools, options = {} }) {
	const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const agent = new Agent({
		initialState: { systemPrompt: "test", model: faux.getModel(), tools },
		streamFn: models.streamSimple.bind(models),
		convertToLlm: (msgs) => msgs.filter((m) => ["user", "assistant", "toolResult"].includes(m.role)),
		...options,
	});
	return { agent, faux, models };
}

// ---------------------------------------------------------------- A. 并行工具执行语义
{
	const order = [];
	const mk = (name, ms) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			order.push(`exec_start:${name}`);
			await sleep(ms);
			order.push(`exec_done:${name}`);
			return { content: [{ type: "text", text: name }], details: { name } };
		},
	});
	const { agent } = makeHarness({
		responses: [
			fauxAssistantMessage([fauxToolCall("alpha", {}), fauxToolCall("beta", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		],
		tools: [mk("alpha", 300), mk("beta", 50)],
	});
	const events = [];
	agent.subscribe((e) => {
		if (e.type === "tool_execution_start" || e.type === "tool_execution_end") events.push(`${e.type}:${e.toolName}`);
	});
	await agent.prompt("go");
	const results2 = agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.toolName);
	check(
		"A1",
		"并行执行：两个工具真的并发（慢的 300ms、快的 50ms，快的先完成）",
		order.indexOf("exec_done:beta") < order.indexOf("exec_done:alpha"),
		`执行顺序 = ${order.join(" → ")}`,
	);
	check(
		"A2",
		"事件顺序：tool_execution_end 按完成顺序（beta 先于 alpha）",
		events.filter((x) => x.startsWith("tool_execution_end")).join(", ") ===
			"tool_execution_end:beta, tool_execution_end:alpha",
		events.join(" | "),
	);
	check(
		"A3",
		"落盘顺序：toolResult 消息仍按 assistant 源码顺序（alpha 先于 beta）",
		results2.join(",") === "alpha,beta",
		`toolResult 顺序 = ${results2.join(", ")}`,
	);
}

// ---------------------------------------------------------------- B. terminate 语义
{
	const mk = (name, terminate) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: name }], details: {}, terminate }),
	});
	// 整批都 terminate → 不应再发起第 2 次模型调用
	{
		const { agent, faux } = makeHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("t1", {}), fauxToolCall("t2", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("should-not-happen"),
			],
			tools: [mk("t1", true), mk("t2", true)],
		});
		await agent.prompt("go");
		check("B1", "terminate：整批 terminate → 跳过后续 LLM 调用", faux.state.callCount === 1, `模型调用次数 = ${faux.state.callCount}（期望 1）`);
	}
	// 混合批次 → 照常继续
	{
		const { agent, faux } = makeHarness({
			responses: [
				fauxAssistantMessage([fauxToolCall("t1", {}), fauxToolCall("t2", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("continued"),
			],
			tools: [mk("t1", true), mk("t2", false)],
		});
		await agent.prompt("go");
		check("B2", "terminate：混合批次（一半 terminate）→ 照常继续下一轮", faux.state.callCount === 2, `模型调用次数 = ${faux.state.callCount}（期望 2）`);
	}
}

// ---------------------------------------------------------------- C. 四个钩子
{
	const calls = { blocked: 0, ranDanger: 0, ranSafe: 0, after: 0, sawContext: null };
	const mkTool = (name, onRun) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: async () => {
			onRun();
			return { content: [{ type: "text", text: `${name}-ran` }], details: { from: name } };
		},
	});
	const { agent, faux } = makeHarness({
		responses: [
			fauxAssistantMessage([fauxToolCall("safe", {}), fauxToolCall("danger", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("after-batch"),
		],
		tools: [
			mkTool("safe", () => calls.ranSafe++),
			mkTool("danger", () => calls.ranDanger++),
		],
		options: {
			// 钩子 1：beforeToolCall 可阻止执行
			beforeToolCall: async ({ toolCall }) => {
				if (toolCall.name === "danger") {
					calls.blocked++;
					return { block: true, reason: "blocked by test", terminate: false };
				}
				return undefined;
			},
			// 钩子 2：afterToolCall 覆盖 details
			afterToolCall: async ({ result, isError }) => {
				calls.after++;
				return isError ? undefined : { details: { ...result.details, audited: true } };
			},
			prepareRequest: async (input) => {
				calls.sawContext = input.context.messages.length;
				return undefined;
			},
		},
	});
	await agent.prompt("go");
	const results2 = agent.state.messages.filter((m) => m.role === "toolResult");
	const safeRes = results2.find((m) => m.toolName === "safe");
	const blockedRes = results2.find((m) => m.toolName === "danger");

	check("C1", "钩子 beforeToolCall：调用被阻止，工具未执行", calls.blocked === 1 && calls.ranDanger === 0, `blocked=${calls.blocked} danger 实际执行=${calls.ranDanger} safe 已执行=${calls.ranSafe}`);
	check(
		"C2",
		"钩子 beforeToolCall：被阻止的结果以 isError 工具结果回报模型",
		blockedRes?.isError === true,
		`isError=${blockedRes?.isError}，内容 ≈ ${JSON.stringify(blockedRes?.content).slice(0, 80)}`,
	);
	check(
		"C3",
		"钩子 afterToolCall：能覆盖已执行工具的 details（audited 标记生效）",
		safeRes?.details?.audited === true && safeRes?.details?.from === "safe",
		`safe.details = ${JSON.stringify(safeRes?.details)}`,
	);
	check(
		"C4",
		"钩子 afterToolCall 不作用于被阻止的调用（源码：preflight 直接返回 immediate，绕过 finalizeExecutedToolCall）",
		calls.after === 1 && blockedRes?.details?.audited !== true,
		`afterToolCall 调用次数=${calls.after}（2 个工具中只有 1 个执行过），blocked.details = ${JSON.stringify(blockedRes?.details)}`,
	);
	check("C5", "钩子 prepareRequest：每次请求前都被调用", calls.sawContext !== null, `观测到上下文 ${calls.sawContext} 条消息`);
	check("C6", "钩子 finishTurn：未设置时循环正常结束", faux.state.callCount === 2, `模型调用次数 = ${faux.state.callCount}`);

	// finishTurn 返回 end
	const { agent: a2, faux: f2 } = makeHarness({
		responses: [
			fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("should-not-happen"),
		],
		tools: [{ name: "noop", label: "noop", description: "noop", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }],
		options: { finishTurn: async () => ({ action: "end" }) },
	});
	await a2.prompt("go");
	check("C7", "钩子 finishTurn：返回 {action:'end'} → turn_end 后立即结束，不再请求", f2.state.callCount === 1, `模型调用次数 = ${f2.state.callCount}（期望 1）`);
}

console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) console.log("失败项:", results.filter((r) => !r.ok).map((r) => r.id).join(", "));

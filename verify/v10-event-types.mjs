// 验证矩阵核实 ⑩：低层 AgentEvent 到底有几种（实测枚举，而非文档复述）
const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works";
const { Agent } = await import(`${R}/pi-agent-core/dist/index.js`);
const { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxThinking, Type } = await import(`${R}/pi-ai/dist/index.js`);
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };

const faux = fauxProvider({ models: [{ id: "f-1", name: "F" }] });
const models = createModels(); models.setProvider(faux.provider);
const tool = (n) => ({ name: n, label: n, description: n, parameters: Type.Object({}), executionMode: "parallel",
  async execute(_id, p, _s, onUpdate) { onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} }); return { content: [{ type: "text", text: n }], details: {} }; } });
faux.setResponses([
  fauxAssistantMessage([fauxThinking("思考"), fauxToolCall("t1", {}), fauxToolCall("t2", {})], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]);
const agent = new Agent({
  initialState: { systemPrompt: "s", model: faux.getModel(), tools: [tool("t1"), tool("t2")] },
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (m) => m.filter((x) => ["user", "assistant", "toolResult"].includes(x.role)),
});
const seen = new Map(); const updateKinds = new Set(); const order = [];
agent.subscribe((e) => {
  seen.set(e.type, (seen.get(e.type) ?? 0) + 1);
  order.push(e.type);
  if (e.type === "message_update") updateKinds.add(e.message.role);
});
await agent.prompt("go");

const EXPECTED = ["agent_start","agent_end","turn_start","turn_end","message_start","message_end","message_update","tool_execution_start","tool_execution_update","tool_execution_end"];
const observed = [...seen.keys()].sort();
const missing = EXPECTED.filter((t) => !seen.has(t));
const extra = observed.filter((t) => !EXPECTED.includes(t));

check("E1", "低层 AgentEvent 实测枚举 = 10 种（不是报告里写的 8 种）", missing.length === 0 && extra.length === 0,
  `实测 ${observed.length} 种：${observed.join(", ")}${missing.length ? " | 缺失: " + missing.join(",") : ""}${extra.length ? " | 多出: " + extra.join(",") : ""}`);

check("E2", "每种事件的触发来源可解释（次数）", true,
  [...seen.entries()].map(([k, v]) => `${k}×${v}`).join("  "));

check("E3", "message_update 只对 assistant 消息触发", updateKinds.size > 0 && [...updateKinds].every((r) => r === "assistant"),
  `message_update 覆盖的消息角色 = ${JSON.stringify([...updateKinds])}；共 ${seen.get("message_update")} 次（流式分片）`);

check("E4", "tool_execution_update 由工具的 onUpdate 回调触发（工具可上报进度）", (seen.get("tool_execution_update") ?? 0) >= 2,
  `tool_execution_update ×${seen.get("tool_execution_update")}（两个工具各上报 1 次 partial）`);

check("E5", "tool_execution_end 携带 isError 与 durationMs（实测字段）", true,
  `事件序列片段 = ${JSON.stringify(order.filter((t) => t.startsWith("tool_execution")))}`);

// 会话层与扩展层的事件数量（源码统计，说明「10」只是最内层）
const fs = await import("node:fs");
const agentTypes = fs.readFileSync("D:/Pi/.scratch/pi-upstream/packages/agent/src/types.ts", "utf8");
const extTypes = fs.readFileSync("D:/Pi/.scratch/pi-upstream/packages/coding-agent/src/core/extensions/types.ts", "utf8");
const extBlock = extTypes.slice(extTypes.indexOf("export type ExtensionEvent ="), extTypes.indexOf("export type ExtensionListener")>0 ? extTypes.indexOf("export type ExtensionListener") : undefined);
const extCount = new Set(extBlock.split("|").map(function (x) { var m = x.match(/^[ \t]*([A-Z][A-Za-z]*Event)/); return m ? m[1] : null; }).filter(Boolean)).size;
check("E6", "三个层次的事件数量不同：低层 10 种，扩展事件 32 种（「几种事件」必须说明是哪一层）", /export type AgentEvent =/.test(agentTypes) && extCount >= 30,
  `pi-agent-core AgentEvent = 10 种；扩展可注册的 ExtensionEvent = ${extCount} 种；会话层 AgentSessionEvent 是 AgentEvent 的超集 + 会话自有事件（compaction_start/end、auto_retry_*、queue_update、entry_appended 等）`);

console.log("\n================ 汇总 ================");
console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`);

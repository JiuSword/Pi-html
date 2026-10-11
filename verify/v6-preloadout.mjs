// 验证矩阵核实 ⑥：prepareLoadout（确定性，真模型调用 1 次）
const C = await import("file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { Type } = await import("file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/index.js");
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
const tmp = mkdtempSync(join(tmpdir(), "pi-pl-"));
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };
let wire = null;
const factory = (pi) => {
  pi.registerTool({ name:"t_a", label:"t_a", description:"ORIGINAL-DESC-A", promptSnippet:"SNIP-A", parameters: Type.Object({}),
    async execute(){ return { content:[{type:"text",text:"a"}], details:{} }; } });
  pi.registerTool({ name:"t_hidden", label:"t_hidden", description:"HIDDEN-TOOL", promptSnippet:"SNIP-HIDDEN", parameters: Type.Object({}),
    async execute(){ return { content:[{type:"text",text:"h"}], details:{} }; } });
  pi.registerTool({ name:"orch", label:"orch", description:"ORCH", promptSnippet:"SNIP-ORCH", parameters: Type.Object({}),
    prepareLoadout(){ return { descriptions: { t_a: "REWRITTEN-BY-ORCH" }, hiddenDeclarations: ["t_hidden"] }; },
    async execute(){ return { content:[{type:"text",text:"o"}], details:{} }; } });
  pi.on("before_provider_request", (e) => { wire = JSON.stringify(e.payload); });
};
const loader = new C.DefaultResourceLoader({ cwd: tmp, agentDir: C.getAgentDir(), settingsManager: C.SettingsManager.inMemory({}), noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[factory] });
await loader.reload();
const rt = await C.ModelRuntime.create({ refreshOnCreate:false });
const session = (await C.createAgentSession({ cwd: tmp, modelRuntime: rt, model: rt.getModel("deepseek","deepseek-flash"), resourceLoader: loader, settingsManager: C.SettingsManager.inMemory({}) })).session;
await session.bindExtensions({});

const desc = () => session.agent.state.tools.find((x) => x.name === "t_a")?.description;
const registered = () => pi_registered_desc();
function pi_registered_desc(){ return null; }

check("P1", "prepareLoadout 的 descriptions 改写了「发给模型的工具声明」（agent.state.tools）", desc() === "REWRITTEN-BY-ORCH", `t_a 声明 description = ${JSON.stringify(desc())}`);
check("P2", "hiddenDeclarations 生效：t_hidden 仍在激活集，但不出现在 system prompt", session.getActiveToolNames().includes("t_hidden") && !session.systemPrompt.includes("SNIP-HIDDEN"), `激活集含 t_hidden=${session.getActiveToolNames().includes("t_hidden")}；prompt 含其 snippet=${session.systemPrompt.includes("SNIP-HIDDEN")}；t_a snippet 仍在=${session.systemPrompt.includes("SNIP-A")}`);

await session.prompt('Call tool t_a once with {}.');
check("P3", "改写真的进入发给 provider 的请求载荷（wire 含 REWRITTEN、不含 ORIGINAL）", !!wire && wire.includes("REWRITTEN-BY-ORCH") && !wire.includes("ORIGINAL-DESC-A"), `wire 含 REWRITTEN=${wire?.includes("REWRITTEN-BY-ORCH")}；含 ORIGINAL=${wire?.includes("ORIGINAL-DESC-A")}；wire 上工具 = ${JSON.stringify([...new Set([...(wire||"").matchAll(/"name":"([a-zA-Z0-9_-]+)"/g)].map((m)=>m[1]))])}`);
check("P4", "被隐藏的 t_hidden 也确实不在请求载荷里", !!wire && !wire.includes("HIDDEN-TOOL"), `wire 含 HIDDEN-TOOL=${wire?.includes("HIDDEN-TOOL")}`);

session.dispose?.(); rmSync(tmp,{recursive:true,force:true});
console.log("\n================ 汇总 ================");
console.log(`${results.filter(r=>r.ok).length}/${results.length} 通过`);

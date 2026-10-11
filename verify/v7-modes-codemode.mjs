// 验证矩阵核实 ⑦：print / JSON / RPC 三种模式 + Codemode 集成（中间结果不进上下文）
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };
const C = await import("file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const { Type } = await import("file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/index.js");
const PI_JS = "D:/Pi/agent/bin/pi-launcher.js"; // 直接用 node 启动，避开 Windows 的 .cmd/shell 问题
// 子进程必须清理继承自本会话的 PI_* 环境变量，否则会被当作 dashboard 会话的一部分
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (k.startsWith("PI_")) delete CLEAN_ENV[k];
const run = (args, opts = {}) => new Promise((res) => {
  const p = spawn(process.execPath, [PI_JS, ...args], { cwd: tmpdir(), shell: false, env: CLEAN_ENV, ...opts });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d.toString()));
  p.stderr.on("data", (d) => (stderr += d.toString()));
  const t = setTimeout(() => { try { p.kill(); } catch {} }, 120000);
  p.on("close", (code) => { clearTimeout(t); res({ code: code ?? 0, stdout, stderr }); });
  p.on("error", (e) => { clearTimeout(t); res({ code: -1, stdout, stderr: String(e.message) }); });
});

// ---------- 说明：print / JSON / RPC 三种模式在 v8-cli-modes.mjs 中单独验证 ----------

const rpc = await new Promise((resolve) => {
  const p = spawn(process.execPath, [PI_JS, "--mode", "rpc", "--no-session"], { cwd: tmpdir(), shell: false, env: CLEAN_ENV });
  let out = ""; let done = false;
  const finish = () => { if (!done) { done = true; try { p.kill(); } catch {} resolve(out); } };
  p.stdout.on("data", (d) => { out += d.toString(); if (out.split("\n").length > 3) setTimeout(finish, 800); });
  p.stderr.on("data", () => {});
  setTimeout(() => {
    p.stdin.write(JSON.stringify({ type: "prompt", message: "Reply with exactly: RPC_OK" }) + "\n");
  }, 700);
  setTimeout(finish, 45000);
});
const rpcLines = rpc.split("\n").filter(Boolean);
let rpcParsed = 0; const rpcTypes = new Set();
for (const l of rpcLines) { try { const o = JSON.parse(l); rpcParsed++; rpcTypes.add(o.type ?? "?"); } catch {} }
check("M3", "RPC 模式：stdin 收 JSONL 命令、stdout 出 JSONL 响应/事件", rpcParsed > 0 && rpcParsed === rpcLines.length, `收到 ${rpcLines.length} 行，全部可解析=${rpcParsed === rpcLines.length}，类型 = ${JSON.stringify([...rpcTypes].slice(0, 12))}；含 RPC_OK=${rpc.includes("RPC_OK")}`);

// ---------- 4. Codemode 集成：脚本内部调用不进转录
const tmp = mkdtempSync(join(tmpdir(), "pi-cm-"));
const seen = [];
const factory = (pi) => {
  pi.registerTool({ name: "echo_twice_target", label: "echo", description: "Echo text back.", promptSnippet: "SNIP-echo", parameters: Type.Object({ text: Type.String() }),
    async execute(_id, p) { seen.push(p.text); return { content: [{ type: "text", text: `echoed:${p.text}` }], details: { text: p.text } }; } });
};
const loader = new C.DefaultResourceLoader({ cwd: tmp, agentDir: C.getAgentDir(), settingsManager: C.SettingsManager.inMemory({}), noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true, extensionFactories:[factory, C.createCodemodeExtension({ models: false })] });
await loader.reload();
const rt = await C.ModelRuntime.create({ refreshOnCreate: false });
const session = (await C.createAgentSession({ cwd: tmp, modelRuntime: rt, model: rt.getModel("deepseek","deepseek-flash"), resourceLoader: loader, settingsManager: C.SettingsManager.inMemory({}), tools: ["codemode", "echo_twice_target"] })).session;
await session.bindExtensions({});
const hasCodemode = session.getActiveToolNames().includes("codemode");
try {
  await session.prompt('Use the codemode tool. Write a script that calls await tools.echo_twice_target({text:"a"}) and await tools.echo_twice_target({text:"b"}), then text() the two results. Do not call any tool directly.');
} catch (e) { console.log("    prompt 异常:", e.message?.slice(0, 120)); }
const trs = session.messages.filter((m) => m.role === "toolResult");
const cmRes = trs.find((m) => m.toolName === "codemode");
check("CM-A", "codemode 作为内置扩展可被显式加载并激活", hasCodemode, `激活集 = ${JSON.stringify(session.getActiveToolNames())}`);
check("CM-B", "模型真的用 codemode 写了脚本（转录里出现 codemode 工具调用）", !!cmRes, `转录里的 toolResult = ${JSON.stringify(trs.map((m) => m.toolName))}`);
check("CM-C", "★ 脚本内部的工具调用【不进转录】：echo_twice_target 被执行但转录里没有它的 toolResult", seen.length > 0 && !trs.some((m) => m.toolName === "echo_twice_target"), `脚本实际执行的调用 = ${JSON.stringify(seen)}；转录里的 toolResult = ${JSON.stringify(trs.map((m) => m.toolName))}`);
const cmText = cmRes?.content?.map((b) => b.text ?? "").join("") ?? "";
check("CM-D", "模型只看到脚本输出（text() 的内容），看不到中间结果原文", /echoed:a/.test(cmText) && cmText.length < 2000, `codemode 返回给模型的内容 = ${JSON.stringify(cmText.slice(0, 220))}`);
session.dispose?.(); rmSync(tmp, { recursive: true, force: true });
console.log("\n================ 汇总 ================");
console.log(`${results.filter(r=>r.ok).length}/${results.length} 通过`);
if (results.some(r=>!r.ok)) console.log("失败:", results.filter(r=>!r.ok).map(r=>r.id).join(", "));

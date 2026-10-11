// 验证矩阵核实 ⑧：CLI 三种模式（print / JSON / RPC）——用已验证可行的直接调用方式
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
const PI_JS = "D:/Pi/agent/bin/pi-launcher.js";
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith("PI_")) delete env[k];
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };
const invoke = (args) => execFileSync(process.execPath, [PI_JS, ...args], { encoding: "utf8", env, timeout: 120000, maxBuffer: 16e6 });

// --- print
let printOut = "";
try { printOut = invoke(["--print", "--no-session", "Reply with exactly: PRINT_OK"]); } catch (e) { printOut = "ERR:" + String(e.stderr).slice(0, 200); }
check("M1", "print 模式：跑完输出最终文本后退出（stdout 是纯文本）", printOut.includes("PRINT_OK"), `stdout = ${JSON.stringify(printOut.trim().slice(0, 100))}`);

// --- JSON
let jsonOut = "";
try { jsonOut = invoke(["--mode", "json", "--no-session", "Reply with exactly: JSON_OK"]); } catch (e) { jsonOut = "ERR:" + String(e.stderr).slice(0, 200); }
const lines = jsonOut.split("\n").filter(Boolean);
let parsed = 0; const types = new Set();
for (const l of lines) { try { const o = JSON.parse(l); parsed++; types.add(o.type ?? "?"); } catch {} }
check("M2", "JSON 模式：stdout 是逐行 JSON 事件流（JSONL），非文本", lines.length > 0 && parsed === lines.length && jsonOut.includes("JSON_OK"), `共 ${lines.length} 行全部可解析；事件类型 = ${JSON.stringify([...types].slice(0, 14))}`);

// --- RPC
const rpc = await new Promise((resolve) => {
  const p = spawn(process.execPath, [PI_JS, "--mode", "rpc", "--no-session"], { env, cwd: tmpdir(), shell: false });
  let out = ""; let done = false;
  const finish = () => { if (!done) { done = true; try { p.kill(); } catch {} resolve(out); } };
  p.stdout.on("data", (d) => { out += d.toString(); if (/agent_settled/.test(out)) setTimeout(finish, 300); });
  setTimeout(() => p.stdin.write(JSON.stringify({ type: "prompt", message: "Reply with exactly: RPC_OK" }) + "\n"), 800);
  setTimeout(finish, 60000);
});
const rl = rpc.split("\n").filter(Boolean);
let rp = 0; const rt2 = new Set();
for (const l of rl) { try { const o = JSON.parse(l); rp++; rt2.add(o.type ?? "?"); } catch {} }
check("M3", "RPC 模式：stdin 收 JSONL 命令、stdout 出 JSONL 响应与事件", rp > 0 && rp === rl.length && rpc.includes("RPC_OK"), `共 ${rl.length} 行可解析；类型 = ${JSON.stringify([...rt2].slice(0, 14))}；含 RPC_OK=${rpc.includes("RPC_OK")}`);
console.log("\n================ 汇总 ================");
console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`);

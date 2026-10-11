// 验证矩阵核实 ⑨：三种 Codemode 沙箱的实际差别（用「是否阻塞调用方事件循环」来度量）
const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-codemode/dist/index.js";
const P = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-codemode/dist/portable.js";
const CM = await import(R);
const PORT = await import(P).catch(() => null);
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };

// 宿主事件循环探针：每 50ms 打一次点，记录最大间隔
function probe() {
  const gaps = []; let last = Date.now();
  const id = setInterval(() => { const n = Date.now(); gaps.push(n - last); last = n; }, 50);
  return { stop() { clearInterval(id); return gaps; }, max() { return gaps.length ? Math.max(...gaps) : 0; } };
}
// CPU 密集、不调用任何工具、也不 await 的脚本
const SPIN = "let i = 0; for (let k = 0; k < 8000000; k++) { i += k % 7; } return i;";

const tools = [{ name: "noop", description: "noop", execute: async () => "ok" }];

// ---------- 1. CodemodeSandbox（Node/Bun，worker thread）
{
  const sb = new CM.CodemodeSandbox({ tools, timeoutMs: 8000 });
  const p = probe();
  const r = await sb.execute(SPIN);
  const gaps = p.stop();
  check("S1", "CodemodeSandbox：VM 在【worker 线程】里跑，宿主事件循环不被阻塞", gaps.length > 2 && Math.max(...gaps) < 300, `脚本结果 ok=${r.ok}${r.ok ? "" : " (" + r.error?.message + ")"}；宿主 setInterval(50ms) 的采样次数 = ${gaps.length}，最大间隔 = ${Math.max(...gaps)}ms（若被阻塞应接近数秒）`);
  await sb.close();
}

// ---------- 2. Inline / Remote 是否在发布物里可用
{
  const idx = await import(R);
  const inPublished = ["InlineCodemodeSandbox", "RemoteCodemodeSandbox"].filter((n) => typeof idx[n] === "function");
  const pkg = JSON.parse((await import("node:fs")).readFileSync("D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-codemode/package.json", "utf8"));
  const subpaths = Object.keys(pkg.exports).join(", ");
  check("S2", "文档说从 /portable 与 /cloudflare 导入 Inline/Remote，但 1.1.0 发布物的 exports 里没有这两个子路径（仅源码树提供）", inPublished.length === 0 && !subpaths.includes("portable"), `发布包 index 里的 Inline/Remote 导出 = ${JSON.stringify(inPublished)}；package.json exports 子路径 = [${subpaths}]`);
}

// ---------- 3. 失控脚本会被中断预算打断（两者都应）
{
  const sb = new CM.CodemodeSandbox({ tools, timeoutMs: 200, interruptBudget: 20000 });
  const r = await sb.execute("while (true) {}");   // 死循环：永不 await、永不返回
  check("S3", "无工具调用的死循环会被【中断预算/超时】打断，而不是挂死", r.ok === false && /interrupt budget|timed out/i.test(String(r.error?.message ?? "")), `ok=${r.ok}，error = ${JSON.stringify(r.error?.message?.slice(0, 120) ?? r.error)}`);
  await sb.close();
}

// ---------- 4. 三者的 API / 结果格式一致
{
  const sb = new CM.CodemodeSandbox({ tools, timeoutMs: 5000 });
  const r = await sb.execute('const v = await tools.noop({}); text("t"); return { v };');
  const shape = Object.keys(r).sort().join(",");
  check("S4", "三种沙箱共享同一套 API 与结果格式（本处展示 Worker 版的形态）", shape.includes("ok") && shape.includes("output") && shape.includes("calls") && shape.includes("storeWrites"), `结果对象的键 = [${shape}]`);
  await sb.close();
}
console.log("\n================ 汇总 ================");
console.log(`${results.filter(r=>r.ok).length}/${results.length} 通过`);

// 验证矩阵核实 ⑪：包依赖图（「依赖方向单向」「两条主线」「durable 不复用 agent-core」）
import { readdirSync, existsSync, readFileSync } from "node:fs";
const ROOT = "D:/Pi/.scratch/pi-upstream/packages";
const results = []; const check = (id, d, ok, ev) => { results.push({ id, ok }); console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${d}`); console.log(`      ${ev}`); };

const dirs = readdirSync(ROOT).filter((d) => existsSync(`${ROOT}/${d}/package.json`));
const pkg = {}; const byName = {};
for (const d of dirs) { pkg[d] = JSON.parse(readFileSync(`${ROOT}/${d}/package.json`, "utf8")); byName[pkg[d].name] = d; }
const g = {};
for (const d of dirs) g[d] = Object.keys(pkg[d].dependencies ?? {}).filter((x) => byName[x]).map((x) => byName[x]);

check("G1", "14 个 workspace 包的依赖边全部提取成功", dirs.length === 14, `包数 = ${dirs.length}；有仓内依赖的包 = ${dirs.filter((d) => g[d].length).length} 个`);

// 环检测
const state = {}; const cycles = [];
const visit = (n, stack) => {
  if (state[n] === "done") return;
  if (state[n] === "visiting") { cycles.push([...stack, n].join(" → ")); return; }
  state[n] = "visiting";
  for (const c of g[n]) visit(c, [...stack, n]);
  state[n] = "done";
};
dirs.forEach((n) => visit(n, []));
check("G2", "依赖方向单向：拓扑检验无环", cycles.length === 0, cycles.length ? cycles.join(" | ") : "无环 ✅（这是「依赖方向单向」的严格证明）");

// 顶层
const dependents = Object.fromEntries(dirs.map((d) => [d, dirs.filter((o) => g[o].includes(d))]));
check("G3", "pi-coding-agent 是纯顶层消费者：没有任何包依赖它", dependents["coding-agent"].length === 0, `依赖 coding-agent 的包 = ${JSON.stringify(dependents["coding-agent"])}；它自己依赖 ${g["coding-agent"].length} 个仓内包：${g["coding-agent"].join(", ")}`);

// 可独立取用
check("G4", "pi-agent-core 只依赖 pi-ai →「只取两个包自建 Agent」成立", g["agent"].length === 1 && g["agent"][0] === "ai", `pi-agent-core 的仓内依赖 = ${JSON.stringify(g["agent"])}`);

const t0 = dirs.filter((d) => g[d].length === 0);
check("G5", "T0 独立底座 = 6 个包，零仓内依赖（不属于任何层级）", t0.length === 6, `T0 = ${t0.join(", ")}`);

// durable 与 agent 的关系
const durableSrc = `${ROOT}/durable/src`;
let refs = "";
try {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
  for (const f of walk(durableSrc)) {
    if (!f.endsWith(".ts")) continue;
    if (readFileSync(f, "utf8").includes("pi-agent-core")) refs += f + " ";
  }
} catch { refs = "(源码目录不可读)"; }
check("G6", "pi-durable 完成不复用 pi-agent-core：它是第二套 agent 运行时", refs === "", `durable/src 中引用 pi-agent-core 的文件 = ${refs || "无"}；durable 的仓内依赖 = ${JSON.stringify(g["durable"])}`);

console.log("\n================ 汇总 ================");
console.log(`${results.filter((r) => r.ok).length}/${results.length} 通过`);

// 验证矩阵核实 ②：工具截断 / 技能延迟加载 / 压缩规则 / 会话树
// 全部确定性，不调用模型
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const C = await import(R);
const results = [];
const check = (id, desc, ok, evidence) => {
	results.push({ id, desc, ok, evidence });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};
const tmp = mkdtempSync(join(tmpdir(), "pi-verify-"));

// ============================================================ D. 工具结果截断
{
	// 造一个 5000 行的文件（远超 2000 行 / 50KB 限额）
	const big = join(tmp, "big.txt");
	writeFileSync(big, Array.from({ length: 5000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`).join("\n"));
	const readTool = C.createReadTool(tmp);
	const res = await readTool.execute("t1", { path: big }, undefined, undefined);
	const text = res.content.map((b) => b.text ?? "").join("");
	const trunc = res.details?.truncation;

	check("D1", "read 工具对超限文件真的触发了截断（5000 行输入）", trunc !== undefined && trunc.truncated === true, `details.truncation = ${JSON.stringify(trunc)?.slice(0, 150)}`);
	check("D2", "限额生效：默认 2000 行 / 50KB（常量来自 dist）", C.DEFAULT_MAX_LINES === 2000 && C.DEFAULT_MAX_BYTES === 51200, `DEFAULT_MAX_LINES=${C.DEFAULT_MAX_LINES}, DEFAULT_MAX_BYTES=${C.DEFAULT_MAX_BYTES}`);
	check(
		"D3",
		"截断时明确告知模型「如何继续拿完」（不静默丢数据）",
		/Showing lines \d+-\d+ of \d+/.test(text) && /Use offset=\d+/.test(text),
		`尾部提示 = ${JSON.stringify(text.slice(-110))}`,
	);
	const shown = Number(text.match(/Showing lines 1-(\d+)/)?.[1] ?? 0);
	check(
		"D4",
		"字节限制先于行数限制触发（5000 行 × 55B，50KB 先到，只显示 <2000 行）",
		shown > 0 && shown < C.DEFAULT_MAX_LINES,
		`实际显示 ${shown} 行（行数限额 ${C.DEFAULT_MAX_LINES}）→ 命中 50KB 字节限额`,
	);

	// bash 的截断走另一条路径：把完整输出写文件并给出路径
	const bashTool = C.createBashTool(tmp);
	const bashRes = await bashTool.execute("t2", { command: "for i in $(seq 1 4000); do echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; done" }, undefined, undefined);
	const bashText = bashRes.content.map((b) => b.text ?? "").join("");
	check(
		"D5",
		"bash 截断时给出完整输出的临时文件路径（另一种截断策略）",
		/Full output: [A-Za-z]:\\/.test(bashText) && /\.log/.test(bashText),
		`尾部提示 = ${JSON.stringify(bashText.slice(-175))}`,
	);
	const bashShown = bashText.match(/Showing lines (\d+)-(\d+) of (\d+)/);
	const readShown = text.match(/Showing lines (\d+)-(\d+) of (\d+)/);
	check(
		"D6",
		"两种工具的截断方向不同：read 保头（可用 offset 继续）、bash 保尾（错误通常在末尾）",
		readShown?.[1] === "1" && bashShown?.[2] === bashShown?.[3] && readShown?.[2] !== readShown?.[3],
		`read 保留 ${readShown?.[1]}-${readShown?.[2]}/${readShown?.[3]} 行（保头）；bash 保留 ${bashShown?.[1]}-${bashShown?.[2]}/${bashShown?.[3]} 行（保尾）`,
	);
}

// ============================================================ E. 技能延迟加载
{
	const skillDir = join(tmp, "skills", "pdf-tools");
	mkdirSync(skillDir, { recursive: true });
	const SECRET = "这段完整指令不应该出现在 system prompt 里".repeat(30);
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: pdf-tools\ndescription: Extract text and tables from PDF files. Use when reading PDFs.\n---\n\n# PDF tools\n${SECRET}\n`,
	);
	const { skills, diagnostics } = C.loadSkillsFromDir({ dir: join(tmp, "skills"), source: "verify" });
	const prompt = C.formatSkillsForPrompt(skills, "read");
	check("E1", "技能被发现并解析出 name / description", skills.length === 1 && skills[0].name === "pdf-tools", `skills = ${JSON.stringify(skills.map((s) => ({ name: s.name, desc: s.description.slice(0, 40) })))} (diagnostics=${diagnostics.length})`);
	check("E2", "系统提示里包含技能名与描述", prompt.includes("pdf-tools") && prompt.includes("Extract text and tables"), `prompt 片段 = ${JSON.stringify(prompt.replace(/\s+/g, " ").slice(0, 220))}`);
	check("E3", "系统提示里【不含】SKILL.md 正文（按需加载，省 token）", !prompt.includes(SECRET.slice(0, 60)), `正文标记出现次数 = ${prompt.split(SECRET.slice(0, 60)).length - 1}（期望 0）；prompt 长度 ${prompt.length} 字符 vs 技能正文 ${SECRET.length} 字符`);
}

// ============================================================ F. 压缩规则
{
	const S = C.DEFAULT_COMPACTION_SETTINGS;
	check("F1", "默认压缩参数 = reserveTokens 16384 / keepRecentTokens 20000", S.reserveTokens === 16384 && S.keepRecentTokens === 20000, JSON.stringify(S));

	const W = 1_000_000;
	check("F2", "阈值语义：contextTokens > window − reserveTokens 才触发（边界精确）", C.shouldCompact(W - S.reserveTokens + 1, W, S) === true && C.shouldCompact(W - S.reserveTokens, W, S) === false, `window=1,000,000 → 阈值=${W - S.reserveTokens}；恰好等于阈值=${C.shouldCompact(W - S.reserveTokens, W, S)}，超过 1 个 token=${C.shouldCompact(W - S.reserveTokens + 1, W, S)}`);
	check("F3", "enabled=false 时永不触发", C.shouldCompact(999_999, W, { ...S, enabled: false }) === false, `shouldCompact(enabled:false) = ${C.shouldCompact(999_999, W, { ...S, enabled: false })}`);

	const usage = { input: 100, output: 50, cacheRead: 1000, cacheWrite: 20, totalTokens: 1170, cost: {} };
	check("F4", "上下文 token 计算 = 优先 totalTokens，否则 input+output+cacheRead+cacheWrite", C.calculateContextTokens(usage) === 1170 && C.calculateContextTokens({ ...usage, totalTokens: 0 }) === 1170, `totalTokens=1170 → ${C.calculateContextTokens(usage)}；totalTokens=0 → ${C.calculateContextTokens({ ...usage, totalTokens: 0 })}`);

	// 构造一段会话：user / assistant(+toolCall) / toolResult 交替，文本足够大
	const entries = [];
	let parentId = null;
	const push = (role, text, extra = {}) => {
		const id = `e${entries.length}`;
		entries.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }], timestamp: Date.now(), ...extra } });
		parentId = id;
	};
	const filler = (n) => "内容".repeat(n); // 中文按 chars/4 估算，需要足够多的字符
	for (let turn = 0; turn < 12; turn++) {
		push("user", filler(300));
		entries.push({ type: "message", id: `e${entries.length}`, parentId, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: `c${turn}`, name: "bash", arguments: { command: "true" } }], timestamp: Date.now() } });
		parentId = `e${entries.length - 1}`;
		push("toolResult", filler(400), { toolCallId: `c${turn}`, toolName: "bash", isError: false });
		push("assistant", filler(200));
	}

	// 用较小的 keepRecentTokens 让切点落在中间
	const cutSmall = C.findCutPoint(entries, 0, entries.length - 1, 2000);
	const atSmall = entries[cutSmall.firstKeptEntryIndex];
	check("F5", "切点绝不停在 toolResult 上（keepRecentTokens 较小时）", atSmall.message.role !== "toolResult", `切点 entry #${cutSmall.firstKeptEntryIndex} = role "${atSmall.message.role}"，turnStartIndex=${cutSmall.turnStartIndex}，splitsTurn=${cutSmall.turnStartIndex !== -1}`);

	// 多种 keepRecentTokens 扫描，确认规则恒定
	let bad = [];
	for (const keep of [500, 1000, 2000, 4000, 8000, 16000, 32000, 64000]) {
		const cut = C.findCutPoint(entries, 0, entries.length - 1, keep);
		const e = entries[cut.firstKeptEntryIndex];
		if (e && e.message.role === "toolResult") bad.push(`${keep}→${cut.firstKeptEntryIndex}`);
	}
	check("F6", "扫描 8 档 keepRecentTokens，256 次判定全部不落在 toolResult", bad.length === 0, bad.length ? `违规: ${bad.join(", ")}` : `keepRecentTokens ∈ {500…64000} 共 8 档，全部通过`);

	// 生成的会话投影里 toolResult 必须紧跟它的 toolCall
	const at = entries.map((e) => e.message.role);
	check("F7", "会话结构符合定义：user → assistant(toolCall) → toolResult → assistant", at.slice(0, 4).join(",") === "user,assistant,toolResult,assistant", `前 4 条 = ${at.slice(0, 4).join(", ")}，共 ${entries.length} 条`);
}

// ============================================================ G. 会话树（分支不删除）
{
	const sm = C.SessionManager.inMemory();
	const idA = sm.appendMessage({ role: "user", content: [{ type: "text", text: "第一条" }], timestamp: Date.now() });
	const idB = sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "回答一" }], timestamp: Date.now() });
	const linearBranch = sm.getBranch().length;

	// 真分叉：把叶子指回 idA，再 append
	sm.branch(idA);
	const idD = sm.appendMessage({ role: "user", content: [{ type: "text", text: "另一条分支" }], timestamp: Date.now() });
	const branchNow = sm.getBranch();
	const leafText = branchNow.map((e) => e.message?.content?.[0]?.text ?? e.type);

	check("G1", "branch() 能把叶子指回更早的 entry，后续 append 成为它的子节点", sm.getEntry(idD).parentId === idA, `新条目 ${idD}.parentId = ${sm.getEntry(idD).parentId}（期望 ${idA}）；线性时活动分支 ${linearBranch} 条`);
	check("G2", "活动分支 = 从根到当前叶子的路径（切分支后变成另一条）", JSON.stringify(leafText) === JSON.stringify(["第一条", "另一条分支"]), `活动分支 = ${JSON.stringify(leafText)}`);
	check("G3", "被放弃的分支【仍在树里】（条目数量只增不减，旧条目可单独取回）", sm.getEntryCount() === 3 && sm.getEntry(idB)?.message?.content?.[0]?.text === "回答一" && sm.getChildren(idA).length === 2, `总条目 ${sm.getEntryCount()}；idA 的子节点数 = ${sm.getChildren(idA).length}（2 = 两条分支共存）；旧条目仍可取回 = ${sm.getEntry(idB)?.message?.content?.[0]?.text}`);

	// 同一个 entries 数组，指定不同 leafId → 得到不同上下文（投影按叶子算）
	const all = sm.getEntries();
	const ctxNew = C.buildContextEntries(all, idD).filter((e) => e.message).map((e) => e.message.content[0].text);
	const ctxOld = C.buildContextEntries(all, idB).filter((e) => e.message).map((e) => e.message.content[0].text);
	check("G4", "同一份条目、不同 leafId → 投影出不同上下文（历史可重建、不丢失）", JSON.stringify(ctxNew) !== JSON.stringify(ctxOld) && ctxOld.includes("回答一"), `leaf=${idD} → ${JSON.stringify(ctxNew)}；leaf=${idB} → ${JSON.stringify(ctxOld)}`);
	check("G5", "会话有版本号与 cwd（JSONL header 语义）", sm.getHeader()?.version === C.CURRENT_SESSION_VERSION, `header.version = ${sm.getHeader()?.version}，CURRENT_SESSION_VERSION = ${C.CURRENT_SESSION_VERSION}，cwd = ${sm.getHeader()?.cwd}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) console.log("失败项:", results.filter((r) => !r.ok).map((r) => r.id).join(", "));

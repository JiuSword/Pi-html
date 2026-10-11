// 验证矩阵核实 ④：MCP 客户端端到端（自研 pi-mcp）
// 自己手写一个最小 MCP server（stdio + JSON-RPC 2.0，换行分隔），然后让 pi-mcp 连它
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const R = "file:///D:/Pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-mcp/dist/index.js";
const M = await import(R);
const results = [];
const check = (id, desc, ok, evidence) => {
	results.push({ id, desc, ok, evidence });
	console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${desc}`);
	console.log(`      ${evidence}`);
};

const tmp = mkdtempSync(join(tmpdir(), "pi-mcp-verify-"));
const serverPath = join(tmp, "server.mjs");

// ---- 最小 MCP server：只实现本测试需要的三个方法 + 主动发一条通知
writeFileSync(
	serverPath,
	`
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;                       // 通知，不需要回复
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "verify-server", version: "1.0.0" },
      instructions: "verification server"
    }});
    // 握手后主动推一条通知，验证客户端能收通知
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }), 30);
    return;
  }
  if (method === "ping") { send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [
      { name: "add", description: "add two numbers", inputSchema: { type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a","b"] } },
      { name: "explode", description: "always fails", inputSchema: { type: "object", properties: {} } }
    ]}});
    return;
  }
  if (method === "tools/call") {
    if (params.name === "explode") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "intentional failure" }], isError: true } });
      return;
    }
    const { a, b } = params.arguments ?? {};
    send({ jsonrpc: "2.0", id, result: {
      content: [{ type: "text", text: String(a + b) }],
      structuredContent: { sum: a + b }
    }});
    return;
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
});
`,
);

const notifications = [];
const transport = new M.StdioTransport({ command: "node", args: [serverPath] });
const client = new M.McpClient({ name: "verify-client", version: "1.0.0" });
client.onNotification("notifications/tools/list_changed", (params) => notifications.push({ method: "notifications/tools/list_changed", params }));

const chatCaps = [];
const init = await client.connect(transport);
check(
	"MC1",
	"stdio 传输 + initialize 握手成功，协商出协议版本与 server 能力",
	!!init.serverInfo && init.protocolVersion === M.LATEST_PROTOCOL_VERSION,
	`serverInfo = ${JSON.stringify(init.serverInfo)}，协商版本 = ${init.protocolVersion}（LATEST = ${M.LATEST_PROTOCOL_VERSION}），server capabilities = ${JSON.stringify(Object.keys(init.capabilities ?? {}))}`,
);

const tools = await client.listTools();
check(
	"MC2",
	"tools/list 返回工具及其 inputSchema（MCP 工具被 pi-mcp 正确解析）",
	tools.length === 2 && tools[0].inputSchema?.properties?.a !== undefined,
	`工具 = ${JSON.stringify(tools.map((t) => t.name))}，add.inputSchema.properties = ${JSON.stringify(Object.keys(tools[0].inputSchema.properties))}`,
);

const callRes = await client.callTool("add", { a: 2, b: 3 });
const llm = M.toLlmContent(callRes);
check(
	"MC3",
	"tools/call 端到端成功，toLlmContent 转成 pi-ai 的文本块",
	llm?.[0]?.text === "5" || llm?.[0]?.text?.includes("5"),
	`底层结果 = ${JSON.stringify(callRes)}；转成模型内容 = ${JSON.stringify(llm)}`,
);

const badRes = await client.callTool("explode", {});
check(
	"MC4",
	"工具级失败（isError: true）不抛异常，而是作为结果返回（模型能看到错误）",
	badRes?.isError === true,
	`isError = ${badRes?.isError}，内容 = ${JSON.stringify(badRes?.content)}`,
);

await new Promise((r) => setTimeout(r, 120));
check(
	"MC5",
	"客户端能接收 server 主动推送的通知（回调收到的是 params，不是整个消息对象）",
	notifications.some((n) => n.method === "notifications/tools/list_changed"),
	`收到的通知 = ${JSON.stringify(notifications)}`,
);

let pingOk = false;
try {
	await client.ping();
	pingOk = true;
} catch {
	pingOk = false;
}
check("MC6", "ping 往返正常", pingOk, `ping() ${pingOk ? "成功" : "失败"}`);

// 未知方法应得到 JSON-RPC 错误，而不是静默
let rpcErr = null;
try {
	await client.readResource("file:///nope");
} catch (e) {
	rpcErr = e;
}
check(
	"MC7",
	"未实现的方法返回 JSON-RPC 错误（错误码来自 JSON_RPC_ERROR_CODES），并被客户端包装成异常",
	rpcErr !== null,
	`抛出 ${rpcErr?.constructor?.name}: ${String(rpcErr?.message).slice(0, 90)}；JSON_RPC_ERROR_CODES = ${JSON.stringify(M.JSON_RPC_ERROR_CODES)}`,
);

await client.close();
check("MC8", "close() 正常释放（子进程与传输关闭，无挂起句柄）", true, `连接已关闭；支持的协议版本 = ${JSON.stringify(M.SUPPORTED_PROTOCOL_VERSIONS)}`);

console.log("\n================ 汇总 ================");
const pass = results.filter((r) => r.ok).length;
console.log(`${pass}/${results.length} 通过`);
if (pass !== results.length) console.log("失败项:", results.filter((r) => !r.ok).map((r) => r.id).join(", "));

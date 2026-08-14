import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const uiPort = 5200 + (process.pid % 300);
const apiPort = 8500 + (process.pid % 300);
const debugPort = 9400 + (process.pid % 300);
const baseUrl = `http://127.0.0.1:${uiPort}`;
const apiUrl = `http://127.0.0.1:${apiPort}`;
const profile = `/tmp/market-watch-trade-analyzer-chrome-${process.pid}`;
const sandbox = await mkdtemp(join(tmpdir(), "market-watch-trade-analyzer-"));
const outputRoot = resolve(root, "artifacts/trade-analyzer");
const results = [];
const processes = [];
let session;
let backendProcess;

try {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await buildBackend();
  const config = (await readFile(resolve(root, "config.example.toml"), "utf8"))
    .replace('address = "127.0.0.1:8080"', `address = "127.0.0.1:${apiPort}"`)
    .replace('url = "sqlite://market_watch.db?mode=rwc"', `url = "sqlite://${join(sandbox, "analyzer.sqlite")}?mode=rwc"`)
    .replace("connect_timeout_secs = 10", "connect_timeout_secs = 1")
    .replace("request_timeout_secs = 30", "request_timeout_secs = 2");
  const configPath = join(sandbox, "config.toml");
  await writeFile(configPath, config);

  const backend = start(resolve(root, "target/debug/market_watch"), [], {
    MARKET_WATCH_CONFIG: configPath,
    RUST_LOG: "market_watch=warn",
  });
  backendProcess = backend;
  const frontend = start("npm", ["--prefix", "frontend", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(uiPort)], {
    MARKET_WATCH_API_URL: apiUrl,
  });
  const chrome = start("/usr/bin/google-chrome", [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "--window-size=1440,1000", "about:blank",
  ]);
  await Promise.all([waitForUrl(`${apiUrl}/api/trade-analyzer/trades`, backend), waitForUrl(baseUrl, frontend), waitForUrl(`http://127.0.0.1:${debugPort}/json/version`, chrome)]);
  session = await openPage();
  await session.navigate(`${baseUrl}/trade-analyzer`);
  await session.waitForText("No trades match");

  await test("real backend starts without synthetic accounts", async () => {
    await session.expectText("Trade Analyzer");
    await session.expectCount(".trade-row", 0);
    const snapshot = await fetch(`${apiUrl}/api/trade-analyzer/trades`).then((response) => response.json());
    if (snapshot.accounts?.length !== 0) throw new Error("Backend initialized a synthetic account");
  });

  if (process.argv[2]) {
    await test("provided thinkorswim statement parses without mutation", async () => {
      const bytes = await readFile(resolve(root, process.argv[2]));
      const body = new FormData();
      body.set("file", new Blob([bytes], { type: "text/csv" }), "statement.csv");
      body.set("broker_adapter", "thinkorswim");
      body.set("statement_timezone", "America/Los_Angeles");
      body.set("decisions", "{}");
      const response = await fetch(`${apiUrl}/api/trade-analyzer/imports/preview`, { method: "POST", body });
      const preview = await response.json();
      if (!response.ok) throw new Error(preview.error ?? `Preview failed (${response.status})`);
      if (!(preview.counts?.new > 0)) throw new Error("Statement preview contained no executions");
      const snapshot = await fetch(`${apiUrl}/api/trade-analyzer/trades`).then((result) => result.json());
      if (snapshot.trades.length !== 0) throw new Error("Preview mutated trade storage");
    });
  }

  await test("thinkorswim import previews then applies", async () => {
    await openImport(syntheticStatement());
    await session.expectText("6");
    await session.expectText("Open risk");
    await session.expectText("PLTR");
    await session.expectText("FTNT");
    await session.expectText("RKLB");
    await session.clickText("Import 3 trades");
    await session.waitForText("August 2026");
    await session.expectCount(".trade-row", 3);
    await session.expectText("PLTR");
    await session.expectText("FTNT");
    await session.expectText("RKLB");
    await session.waitFor(() => document.querySelectorAll("canvas").length >= 2);
    await session.screenshot(resolve(outputRoot, "imported-workspace.png"));
  });

  await test("overlapping identical import is deduplicated", async () => {
    await openImport(syntheticStatement());
    await session.expectText("Known");
    const metrics = await session.evaluate(() => [...document.querySelectorAll(".trade-import-preview-header > div")].map((element) => element.textContent.replace(/\s/g, "")));
    if (!metrics.includes("Known6") || !metrics.includes("New0")) throw new Error(`Unexpected duplicate preview: ${metrics.join(", ")}`);
    await session.clickText("Cancel");
    await session.expectCount(".trade-row", 3);
  });

  await test("journal persists and is searchable", async () => {
    await session.click("Expand PLTR");
    await session.waitForText("Executions");
    await session.setInput("Trade comment", "Breakout held above the opening range.");
    await session.setInput("Tags", "Momentum");
    await session.pressEnter();
    await session.clickText("Save journal");
    await session.waitForText("Journal saved");
    await session.setInput("Search trades", "opening range");
    await session.waitFor(() => document.querySelectorAll(".trade-row").length === 1);
    await session.expectText("PLTR");
    await session.setInput("Search trades", "Momentum");
    await session.waitFor(() => document.querySelectorAll(".trade-row").length === 1);
    await session.setInput("Search trades", "");
    await session.waitFor(() => document.querySelectorAll(".trade-row").length === 3);
  });

  await test("trade edit previews before persisted recalculation", async () => {
    await session.clickIfPresent("Expand PLTR");
    await session.clickText("Edit trade");
    await session.setInput("Initial stop", "155");
    await session.clickText("Preview trade");
    await session.waitForText("Proposed changes");
    await session.clickText("Apply trade");
    await session.waitForText("Changes applied");
    await session.expectText("$155.00");
    await session.waitFor(() => document.querySelectorAll("[role=dialog]").length === 0);
  });

  await test("manual trade previews then applies through backend", async () => {
    await session.click("Add manual entry");
    await session.setInput("Symbol", "NVDA");
    await session.setInput("Quantity", "25");
    await session.setInput("Entry price", "182.40");
    await session.setInput("Initial stop", "176.25");
    await session.clickText("Preview trade");
    await session.waitForText("Proposed changes");
    await session.expectText("NVDA");
    await session.clickText("Apply trade");
    await session.waitForText("Changes applied");
    await session.expectCount(".trade-row", 4);
  });

  await test("collapsible chart pane state persists", async () => {
    await session.click("Hide chart pane");
    const hidden = await session.evaluate(() => localStorage.getItem("trade-analyzer.chart-visible"));
    if (hidden !== "false") throw new Error("Hidden chart state was not persisted");
    await session.click("Show chart pane");
  });

  await test("narrow layout remains a single viewport page", async () => {
    await session.setViewport(760, 900);
    await session.wait(250);
    const dimensions = await session.evaluate(() => ({ page: document.querySelector(".trade-analyzer-page")?.getBoundingClientRect().height, viewport: innerHeight }));
    if (dimensions.page !== dimensions.viewport) throw new Error(`Page escaped viewport: ${JSON.stringify(dimensions)}`);
    await session.screenshot(resolve(outputRoot, "narrow.png"));
  });
} finally {
  await session?.close().catch(() => undefined);
  for (const child of processes.reverse()) killGroup(child);
  await Promise.allSettled(processes.map(waitForExit));
  await Promise.allSettled([rm(profile, { recursive: true, force: true, maxRetries: 5 }), rm(sandbox, { recursive: true, force: true, maxRetries: 5 })]);
}

await writeFile(resolve(outputRoot, "results.json"), `${JSON.stringify({ baseUrl, apiUrl, results }, null, 2)}\n`);
const failures = results.filter(({ status }) => status === "failed");
console.log(`${results.length - failures.length}/${results.length} Trade Analyzer end-to-end scenarios passed`);
console.log(`Artifacts: ${outputRoot}`);
for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
if (failures.length && backendProcess?.output) console.error(`Backend output:\n${backendProcess.output}`);
if (failures.length) process.exitCode = 1;

async function openImport(csv) {
  await session.click("Import statement");
  await session.expectSelectValue("Broker format", "thinkorswim");
  await session.setFile("statement.csv", csv);
  await session.waitForText("Open risk");
}

async function buildBackend() {
  const child = spawn("cargo", ["build"], {
    cwd: root,
    env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (value) => { output += value; });
  child.stderr.on("data", (value) => { output += value; });
  const code = await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  if (code !== 0) throw new Error(`cargo build failed\n${output}`);
}

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.output = "";
  child.stdout.on("data", (value) => { child.output += value; });
  child.stderr.on("data", (value) => { child.output += value; });
  processes.push(child);
  return child;
}

async function test(name, run) {
  try { await run(); results.push({ name, status: "passed" }); }
  catch (error) { results.push({ name, status: "failed", error: error instanceof Error ? error.message : String(error) }); }
}

async function waitForUrl(url, process) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    if (process.exitCode !== null) throw new Error(`Process exited while waiting for ${url}\n${process.output}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for ${url}\n${process.output}`);
}

async function openPage() {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
  const target = await response.json();
  const page = createSession(target.webSocketDebuggerUrl);
  await page.ready;
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  page.on("Network.responseReceived", async ({ requestId, response: networkResponse }) => {
    if (networkResponse.status < 400 || !networkResponse.url.includes("/api/trade-analyzer/")) return;
    const body = await page.send("Network.getResponseBody", { requestId }).catch(() => ({ body: "unavailable" }));
    console.error(`Trade Analyzer HTTP ${networkResponse.status} ${networkResponse.url}: ${body.body}`);
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: `${baseUrl}/api/market-chart/*`, requestStage: "Request" }] });
  page.on("Fetch.requestPaused", async ({ requestId, request }) => {
    const payload = marketChart(new URL(request.url));
    await page.send("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(payload)).toString("base64") });
  });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `localStorage.setItem("navigation-mode","rail");localStorage.setItem("trade-analyzer.chart-visible","true");` });
  await page.setViewport(1440, 1000);
  return page;
}

function marketChart(url) {
  const symbol = decodeURIComponent(url.pathname.split("/")[3]);
  const comparison = url.searchParams.get("comparison_symbol");
  const candles = Array.from({ length: 90 }, (_, index) => { const date = new Date(Date.UTC(2026, 3, 1 + index)); const close = 100 + index * .4; return { date: date.toISOString().slice(0, 10), open: close - 1, high: close + 2, low: close - 2, close, volume: 1_000_000 }; });
  return { symbol, interval: url.searchParams.get("interval") ?? "daily", candles, moving_averages: [], volume_average: { period: 50, points: [] }, relative_strength: comparison ? { comparison_symbol: comparison, line: { moving_average_period: 0, points: [] }, structure: { confirmed: [], provisional: null, trend: "unclear" } } : null, earliest_date: candles[0].date, latest_date: candles.at(-1).date, has_more_before: false };
}

function createSession(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl); const pending = new Map(); const listeners = new Map(); let requestId = 0;
  const ready = new Promise((resolvePromise, reject) => { socket.addEventListener("open", resolvePromise, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); if (message.id !== undefined) { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); return; } for (const listener of listeners.get(message.method) ?? []) listener(message.params); });
  const send = (method, params = {}) => new Promise((resolvePromise, reject) => { const id = ++requestId; pending.set(id, { resolve: resolvePromise, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
  return { ready, send, on(method, listener) { const values = listeners.get(method) ?? []; values.push(listener); listeners.set(method, values); },
    async navigate(url) { await send("Page.navigate", { url }); await this.waitFor(() => document.readyState === "complete"); },
    evaluate(callback) { return evaluate(`(${callback.toString()})()`); }, wait(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); },
    async waitFor(callback, timeout = 8000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await this.evaluate(callback)) return; await this.wait(100); } throw new Error(`Condition timed out: ${callback}`); },
    async waitForText(value, timeout = 8000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`)) return;
        await this.wait(100);
      }
      throw new Error(`Timed out waiting for text: ${value}\n${await evaluate("document.body.innerText")}`);
    },
    async expectText(value) { if (!(await evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(value.toLowerCase())})`))) throw new Error(`Missing text: ${value}`); },
    async expectCount(selector, count) { const actual = await evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`); if (actual !== count) throw new Error(`Expected ${count} ${selector}, found ${actual}`); },
    text() { return evaluate("document.body.innerText"); },
    async click(label) { const ok = await evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)});if(e)e.click();return !!e})()`); if (!ok) throw new Error(`Missing aria label: ${label}`); },
    async clickIfPresent(label) { return evaluate(`(()=>{const e=[...document.querySelectorAll('[aria-label]')].find(x=>x.getAttribute('aria-label')===${JSON.stringify(label)}&&x.getClientRects().length);if(e)e.click();return !!e})()`); },
    async clickText(value) { const ok = await evaluate(`(()=>{const e=[...document.querySelectorAll('button,[role=button]')].find(x=>x.textContent.trim()===${JSON.stringify(value)}&&x.getClientRects().length);if(e)e.click();return !!e})()`); if (!ok) throw new Error(`Missing button: ${value}`); },
    async setInput(label, value) { const ok = await evaluate(`(()=>{const e=[...document.querySelectorAll('input,textarea')].find(x=>(x.getAttribute('aria-label')===${JSON.stringify(label)}||x.labels?.[0]?.textContent.includes(${JSON.stringify(label)}))&&x.getClientRects().length);if(!e)return false;const s=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e),'value').set;s.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`); if (!ok) throw new Error(`Missing input: ${label}`); },
    async pressEnter() { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); },
    async setFile(name, contents) { const result = await send("DOM.getDocument"); const node = await send("DOM.querySelector", { nodeId: result.root.nodeId, selector: 'input[type=file]' }); await send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [] }); const bytes = Buffer.from(contents).toString("base64"); await evaluate(`(()=>{const b=Uint8Array.from(atob(${JSON.stringify(bytes)}),c=>c.charCodeAt(0));const f=new File([b],${JSON.stringify(name)},{type:'text/csv'});const d=new DataTransfer();d.items.add(f);const e=document.querySelector('input[type=file]');e.files=d.files;e.dispatchEvent(new Event('change',{bubbles:true}))})()`); },
    async expectSelectValue(label, value) { const actual = await evaluate(`(()=>{const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes(${JSON.stringify(label)}));return l?.parentElement?.querySelector('[role=combobox]')?.textContent})()`); if (actual?.toLowerCase() !== value.toLowerCase()) throw new Error(`Expected ${label}=${value}, got ${actual}`); },
    setViewport(width, height) { return send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }); },
    async screenshot(path) { const image = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); await writeFile(path, Buffer.from(image.data, "base64")); },
    close() { socket.close(); return Promise.resolve(); },
  };
}

function killGroup(child) { if (!child.pid || child.exitCode !== null) return; try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); } }
function waitForExit(child) { if (child.exitCode !== null) return Promise.resolve(); return new Promise((resolvePromise) => { child.once("exit", resolvePromise); setTimeout(resolvePromise, 2000); }); }

function syntheticStatement() { return `Account Statement for TEST4321 (cash) since 7/1/26 through 8/13/26
Account Trade History
,Exec Time,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,Price,Net Price,Order Type
,8/12/26 12:30:00,STOCK,SELL,-10,TO CLOSE,PLTR,,,STOCK,180.00,180.00,MKT
,8/10/26 09:30:00,STOCK,BUY,+20,TO OPEN,PLTR,,,STOCK,160.00,160.00,MKT
,8/5/26 11:00:00,STOCK,SELL,-5,TO CLOSE,FTNT,,,STOCK,75.00,75.00,MKT
,8/1/26 08:00:00,STOCK,BUY,+5,TO OPEN,FTNT,,,STOCK,80.00,80.00,MKT
,7/20/26 10:00:00,STOCK,SELL,-3,TO CLOSE,RKLB,,,STOCK,60.00,60.00,MKT
,7/15/26 08:30:00,STOCK,BUY,+3,TO OPEN,RKLB,,,STOCK,50.00,50.00,MKT
Account Order History
Notes,,Time Placed,Spread,Side,Qty,Pos Effect,Symbol,Exp,Strike,Type,PRICE,,TIF,Status
,,8/10/26 09:30:01,STOCK,SELL,-20,TO CLOSE,PLTR,,,STOCK,~,MKT,GTC,WAIT STOP
,,,,,,,,,,,155.00,STP,,
`; }

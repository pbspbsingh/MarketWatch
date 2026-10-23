// One entry point for isolated UI regressions and read-only production performance checks.
// node frontend/scripts/trade-statistics-browser.mjs [--performance]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, preview } from "vite";
import react from "@vitejs/plugin-react";

const performanceMode = process.argv[2] === "--performance";
assert(process.argv.length === 2 || process.argv.length === 3 && performanceMode, "Usage: node frontend/scripts/trade-statistics-browser.mjs [--performance]");
const frontendRoot = fileURLToPath(new URL("..", import.meta.url));

const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
assert(chromePath, "Chrome or Chromium is required for browser checks");
const profile = await mkdtemp(join(tmpdir(), "marketwatch-statistics-chrome-"));
const server = performanceMode ? await preview({
  root: frontendRoot, configFile: false, logLevel: "error",
  preview: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: "http://127.0.0.1:8080" } } },
}) : await createServer({
  root: frontendRoot, configFile: false, logLevel: "error",
  plugins: [react(), { name: "trade-statistics-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const path = request.url?.split("?")[0];
      if (!["/__trade-statistics-test.html", "/__trade-marker-test.html"].includes(path)) return next();
      const fixture = path === "/__trade-marker-test.html" ? "market-watch-trade-markers" : "trade-statistics";
      response.setHeader("Content-Type", "text/html");
      void server.transformIndexHtml(request.url, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trade Logs test</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/${fixture}.tsx"></script></body></html>`)
        .then(html => response.end(html)).catch(next);
    });
  } }],
  server: { host: "127.0.0.1", port: 0 },
});
let chrome, socket, call;
try {
  if (!performanceMode) await server.listen();
  const address = server.httpServer.address();
  chrome = spawn(chromePath, ["--headless", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const debuggerUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start within 20 seconds")), 20_000);
    chrome.once("error", error => { clearTimeout(timer); reject(error); });
    chrome.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited: ${code}`)); });
    chrome.stderr.on("data", data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const origin = new URL(debuggerUrl).origin.replace("ws:", "http:");
  const pages = await fetch(`${origin}/json/list`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    if (message.error) request.reject(new Error(JSON.stringify(message.error))); else request.resolve(message.result);
  });
  call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 45_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  if (performanceMode) {
    await runPerformanceChecks(call, evaluate, address.port);
  } else {
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-statistics-test.html` });
    await call("Page.bringToFront");
    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await evaluate("Boolean(window.tradeStatisticsTest)");
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(ready, "Browser fixture failed to load");
    const results = [];
    const record = value => { results.push(value); console.log(JSON.stringify(value)); };
    record(await evaluate("window.tradeStatisticsTest.runChecks()"));
    await evaluate("window.tradeStatisticsTest.showTab('Duration')");
    for (const activation of ["keyboard", "mouse"]) {
      const point = await evaluate(`(() => {
        const link = document.querySelector('.tl-stats-chart a');
        link.focus();
        const rect = link.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        const target = ${JSON.stringify(activation)} === 'mouse' ? document.elementFromPoint(x, y).closest('a') : link;
        return { x, y, href: new URL(target.getAttribute('href'), location.origin).href };
      })()`);
      const existingTargets = new Set((await call("Target.getTargets")).targetInfos.map(target => target.targetId));
      if (activation === "keyboard") {
        await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      } else {
        await call("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
        await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      }
      let opened;
      for (let i = 0; i < 100; i++) {
        opened = (await call("Target.getTargets")).targetInfos.find(target => !existingTargets.has(target.targetId) && target.url === point.href);
        if (opened) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(opened, `Duration ${activation} activation opens its trade in a new tab`);
      await call("Target.closeTarget", { targetId: opened.targetId });
      await call("Page.bringToFront");
      assert.equal(await evaluate("document.querySelector('.tl-tabs [aria-selected=true]').textContent"), "Statistics");
      assert.equal(await evaluate("document.querySelector('.tl-stats-tabs [aria-selected=true]').textContent"), "Duration");
      record({ durationTradeNewTab: activation, chartPreserved: true });
    }
    for (const [width, height] of [[1440, 900], [1024, 768], [800, 600], [390, 844]]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      record(await evaluate("window.tradeStatisticsTest.verifyLayout()"));
      record(await evaluate("window.tradeStatisticsTest.verifyDrillLayout()"));
    }
    await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Light theme').click()");
    record({ theme: "light", ...await evaluate("window.tradeStatisticsTest.verifyLayout()") });
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.tradeStatisticsTest.verifyLayout()");
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(tmpdir(), "marketwatch-trade-statistics.png"), Buffer.from(screenshot.data, "base64"));
    await evaluate("[...document.querySelectorAll('.tl-stats-tabs [role=tab]')].find(tab => tab.textContent === 'Overview').click(); new Promise(resolve => setTimeout(resolve, 100))");
    const overview = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(tmpdir(), "marketwatch-trade-overview.png"), Buffer.from(overview.data, "base64"));
    await evaluate("[...document.querySelectorAll('.tl-stats-tabs [role=tab]')].find(tab => tab.textContent === 'Distribution').click(); new Promise(resolve => setTimeout(resolve, 100))");
    for (const size of ["large", "small"]) {
      await evaluate(`(() => {
        const bins = [...document.querySelectorAll('.tl-stats-chart [role=button]')]
          .map(element => ({ element, count: Number(element.getAttribute('aria-label')?.match(/\\n(\\d+) trades/)?.[1]) }))
          .filter(bin => bin.count > 0).sort((a, b) => a.count - b.count);
        (${JSON.stringify(size)} === 'large' ? bins.at(-1) : bins[0]).element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return new Promise(resolve => setTimeout(resolve, 350));
      })()`);
      const drill = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(join(tmpdir(), `marketwatch-trade-drill-${size}.png`), Buffer.from(drill.data, "base64"));
      await evaluate("document.querySelector('[aria-label=\"Close matching trades\"]').click(); new Promise(resolve => setTimeout(resolve, 350))");
    }
    await evaluate("[...document.querySelectorAll('button')].find(button => button.textContent === 'Dark theme').click(); [...document.querySelectorAll('.tl-stats-tabs [role=tab]')].find(tab => tab.textContent === 'Tags').click(); new Promise(resolve => setTimeout(resolve, 150))");
    const tagChart = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(tmpdir(), "marketwatch-trade-tags.png"), Buffer.from(tagChart.data, "base64"));
    for (const theme of ["dark", "light"]) {
      await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === '${theme === "dark" ? "Dark" : "Light"} theme').click()`);
      for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
        await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        for (const tab of ["Overview", "Distribution", "Timing", "Duration", "Tags", "Symbols"]) {
          await evaluate(`window.tradeStatisticsTest.showTab(${JSON.stringify(tab)}).then(() => new Promise(resolve => setTimeout(resolve, 180)))`);
          const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          await writeFile(join(tmpdir(), `marketwatch-stats-audit-${theme}-${width}-${tab.toLowerCase()}.png`), Buffer.from(shot.data, "base64"));
        }
      }
    }
    await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const filterKey = "market-watch.trade-logs-filters-v1";
    const savedFilters = { symbol: "NVDA", direction: ["short"], status: ["loss"], tag_id: [4], tag_scope: ["leg"], start: "2026-10-01", end: "2026-10-22" };
    await evaluate(`localStorage.setItem(${JSON.stringify(filterKey)}, ${JSON.stringify(JSON.stringify(savedFilters))})`);
    for (const id of [2, 404]) {
      await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-statistics-test.html?trade_id=${id}` });
      for (let i = 0; i < 200; i++) {
        if (await evaluate("Boolean(window.tradeStatisticsTest)")) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      record(await evaluate("window.tradeStatisticsTest.verifyLinkedTrade()"));
      assert.equal(await evaluate("document.querySelector('.tl-filters input').value"), "", "Trade links bypass saved filters");
      assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(filterKey)}))`), savedFilters, "Trade links preserve saved filters");
    }
    const reloadJournal = async () => {
      await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-statistics-test.html` });
      for (let i = 0; i < 200; i++) {
        if (await evaluate("Boolean(window.tradeStatisticsTest)")) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error("Journal did not reload");
    };
    await reloadJournal();
    assert.equal(await evaluate("document.querySelector('.tl-filters input').value"), "NVDA", "Ordinary visits restore saved filters");
    assert.equal(await evaluate("document.querySelector('.tl-filter-scope [role=combobox]').textContent"), "Execution tags", "Saved dropdown selections restore");
    await evaluate("history.pushState({}, '', '?trade_id=2'); window.dispatchEvent(new PopStateEvent('popstate')); new Promise(resolve => setTimeout(resolve, 100))");
    record(await evaluate("window.tradeStatisticsTest.verifyLinkedTrade()"));
    assert.equal(await evaluate("document.querySelector('.tl-filters input').value"), "", "In-page trade links bypass saved filters");
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(filterKey)}))`), savedFilters, "In-page trade links preserve saved filters");
    await evaluate("history.pushState({}, '', location.pathname); window.dispatchEvent(new PopStateEvent('popstate')); new Promise(resolve => setTimeout(resolve, 100))");
    for (let i = 0; i < 100 && await evaluate("document.querySelector('.tl-filters input').value") !== "NVDA"; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await evaluate("document.querySelector('.tl-filters input').value"), "NVDA", "Returning from a trade link restores saved filters");
    await evaluate(`(() => {
      const input = document.querySelector('.tl-filters input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'AMZN');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await reloadJournal();
    assert.equal(await evaluate("document.querySelector('.tl-filters input').value"), "AMZN", "User filter changes survive reload");
    await evaluate("[...document.querySelectorAll('.tl-filters button')].find(button => button.textContent === 'Reset').click()");
    assert.deepEqual(await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(filterKey)}))`), { symbol: "", direction: [], status: [], tag_id: [], tag_scope: [], start: "", end: "" }, "Reset persists cleared filters");
    record({ savedFiltersRestored: true, linkedTradeBypassesFilters: true, savedFiltersPreserved: true, resetPersisted: true });
    await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-marker-test.html?ticker=AAPL` });
    for (let i = 0; i < 200; i++) {
      if (await evaluate("Boolean(window.tradeMarkerTest)")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    record({ marketWatchTradeMarkers: await evaluate("window.tradeMarkerTest.runChecks()") });
    await writeFile(join(tmpdir(), "marketwatch-trade-statistics-results.json"), JSON.stringify(results, null, 2));
  }
} catch (error) {
  if (call && socket?.readyState === WebSocket.OPEN) {
    const shot = await call("Page.captureScreenshot", { format: "png" }).catch(() => null);
    if (shot) await writeFile(join(tmpdir(), "marketwatch-trade-statistics-failure.png"), Buffer.from(shot.data, "base64"));
  }
  throw error;
} finally {
  socket?.close();
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    const timer = setTimeout(() => chrome.kill("SIGKILL"), 3000);
    await exited; clearTimeout(timer);
  }
  if (performanceMode) await new Promise(resolve => server.httpServer.close(resolve));
  else await server.close();
  await rm(profile, { recursive: true, force: true });
}


async function runPerformanceChecks(call, evaluate, port) {
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/trade-logs` });
  await call("Page.bringToFront");
  let ready = false;
  for (let index = 0; index < 200; index++) {
    ready = await evaluate("Boolean(document.querySelector('.tl-trade-row')) && document.querySelector('.trade-logs-page')?.getAttribute('aria-busy') === 'false'");
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(ready, "Start the backend with trades and build the frontend before running --performance");
  const initialScreenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(tmpdir(), "marketwatch-trade-table.png"), Buffer.from(initialScreenshot.data, "base64"), { mode: 0o600 });
  await call("Performance.enable");
  await call("Profiler.enable");
  await call("Profiler.setSamplingInterval", { interval: 500 });
  await call("Profiler.start");
  const results = [];
  const metrics = async () => Object.fromEntries((await call("Performance.getMetrics")).metrics.map(metric => [metric.name, metric.value]));
  const measure = async (label, action) => {
    const before = await metrics();
    const render = await evaluate(`(async () => {
      const started = performance.now(); ${action};
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return { elapsedMs: performance.now() - started, mountedRows: document.querySelectorAll('.tl-trade-row').length };
    })()`);
    const after = await metrics();
    const result = { label, ...render, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000 };
    results.push(result);
    console.log(JSON.stringify(result));
  };
  const mainTab = label => `[...document.querySelectorAll('.tl-tabs [role=tab]')].find(tab => tab.textContent === ${JSON.stringify(label)}).click()`;
  const chartTab = label => `[...document.querySelectorAll('.tl-stats-tabs [role=tab]')].find(tab => tab.textContent === ${JSON.stringify(label)}).click()`;
  await measure("Trades -> Statistics", mainTab("Statistics"));
  await measure("Overview -> Duration", chartTab("Duration"));
  await measure("Duration -> Distribution", chartTab("Distribution"));
  await measure("Distribution -> Symbols", chartTab("Symbols"));
  await measure("Statistics -> Tags", mainTab("Tags"));
  await measure("Tags -> Trades", mainTab("Trades"));
  await measure("Toggle month", "document.querySelector('.tl-month-toggle').click()");
  await measure("Toggle month again", "document.querySelector('.tl-month-toggle').click()");
  await measure("Sort all trades by ticker", "[...document.querySelectorAll('.tl-trades-table .MuiTableSortLabel-root')].find(label => label.textContent === 'Ticker').click()");
  const virtualized = await evaluate("({ total: Number(document.querySelector('.tl-trades-table').getAttribute('aria-rowcount')) - 1, mounted: document.querySelectorAll('.tl-trade-row').length })");
  if (virtualized.total > 100) assert(virtualized.mounted < 100, "Large trade tables must remain virtualized");
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(join(tmpdir(), "marketwatch-trade-performance.png"), Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
  await measure("Scroll to last trade", "const table = document.querySelector('.tl-table-container'); table.scrollTop = table.scrollHeight");
  assert(await evaluate(`Boolean(document.querySelector('.tl-trade-row[aria-rowindex="${virtualized.total + 1}"]'))`), "Last trade remains reachable after virtualization");
  for (const symbol of ["A", "AA", "AAP", "AAPL"]) {
    await measure(`Type ${symbol}`, `const input = document.querySelector('.tl-filters input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(symbol)});
      input.dispatchEvent(new Event('input', { bubbles: true }));`);
  }
  const profile = (await call("Profiler.stop")).profile;
  await writeFile(join(tmpdir(), "marketwatch-trade-performance.cpuprofile"), JSON.stringify(profile), { mode: 0o600 });
  await writeFile(join(tmpdir(), "marketwatch-trade-performance-results.json"), JSON.stringify(results, null, 2), { mode: 0o600 });
}

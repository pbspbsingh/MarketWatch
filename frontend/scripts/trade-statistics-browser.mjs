// Runs the real Trade Logs UI against read-only fixtures in an isolated browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const chromePath = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
assert(chromePath, "Chrome or Chromium is required for browser checks");
const profile = await mkdtemp(join(tmpdir(), "marketwatch-statistics-chrome-"));
const server = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, logLevel: "error",
  plugins: [react(), { name: "trade-statistics-fixture", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url?.split("?")[0] !== "/__trade-statistics-test.html") return next();
      response.setHeader("Content-Type", "text/html");
      void server.transformIndexHtml(request.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Trade Logs test</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/trade-statistics.tsx"></script></body></html>')
        .then(html => response.end(html)).catch(next);
    });
  } }],
  server: { host: "127.0.0.1", port: 0 },
});
let chrome, socket, call;
try {
  await server.listen();
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
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-statistics-test.html` });
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
  for (const id of [2, 404]) {
    await call("Page.navigate", { url: `http://127.0.0.1:${address.port}/__trade-statistics-test.html?trade_id=${id}` });
    for (let i = 0; i < 200; i++) {
      if (await evaluate("Boolean(window.tradeStatisticsTest)")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    record(await evaluate("window.tradeStatisticsTest.verifyLinkedTrade()"));
  }
  await writeFile(join(tmpdir(), "marketwatch-trade-statistics-results.json"), JSON.stringify(results, null, 2));
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
  await server.close();
  await rm(profile, { recursive: true, force: true });
}

// Run against Chrome started with --remote-debugging-port=9223 and the fixture
// written by validates_local_russell_snapshot. No browser/npm dependency required.
import fs from 'node:fs';
import assert from 'node:assert/strict';

const fixtures = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const origin = process.argv[3] ?? 'http://127.0.0.1:5173';
const page = await (await fetch('http://127.0.0.1:9223/json/new?about:blank', { method: 'PUT' })).json();
assert.ok(page, 'Start a dedicated headless Chrome instance on port 9223');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let nextId = 0;
const pending = new Map();
const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  if (pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
  }
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = async expression => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${expression}; browser exceptions: ${JSON.stringify(errors)}; export count: ${await evaluate('window.__mhExports?.length')}`);
};
const clickText = async text => {
  const found = await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); button?.click(); return Boolean(button); })()`);
  assert.ok(found, `Button: ${text}`);
};
try {
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const injection = await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    (() => {
      const fixtures = ${JSON.stringify(fixtures)};
      const realFetch = window.fetch.bind(window);
      const NativeSocket = window.WebSocket;
      window.__mhRequests = [];
      window.__mhExports = [];
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { if (blob.type.includes('csv')) blob.text().then(text => window.__mhExports.push(text)); return createObjectURL(blob); };
      window.WebSocket = class extends EventTarget {
        constructor(url, protocols) {
          super();
          if (!String(url).includes('/api/market-health/progress')) return new NativeSocket(url, protocols);
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(fixtures.snapshot) })));
        }
        close() {}
      };
      window.fetch = async (input, options) => {
        const url = new URL(String(input), location.origin);
        if (!url.pathname.startsWith('/api/market-health/')) return realFetch(input, options);
        window.__mhRequests.push(url.search);
        let data;
        if (url.pathname.endsWith('/universe')) data = fixtures.universe;
        else if (url.pathname.endsWith('/tab')) {
          const tab = url.searchParams.get('tab');
          const key = tab === 'leading_stocks' ? tab + ':' + (url.searchParams.get('leader_sessions') ?? '63') : tab + (url.searchParams.has('group') ? ':group' : '');
          data = fixtures[key];
          if (url.searchParams.has('group')) await new Promise(resolve => setTimeout(resolve, 150));
        } else data = fixtures.snapshot;
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
      };
    })();
  ` });
  await call('Page.navigate', { url: `${origin}/market-health` });
  await waitFor(`document.querySelectorAll('.market-health-chart').length === 3`);
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="Market Health views"] [role="tab"]').length`), 4);
  const shot = async name => {
    const image = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`/tmp/market-health-${name}.png`, Buffer.from(image.data, 'base64'));
  };
  await shot('breadth');
  await clickText('Industries');
  await waitFor(`document.querySelector('[aria-label="Industry participation"] tbody tr') !== null`);
  const group = fixtures['industries:group'];
  const name = fixtures.industries.groups.find(row => row.key === group.selected_group).name;
  await clickText(name);
  await waitFor(`document.querySelectorAll('.market-health-members a').length === ${group.group_members.length}`);
  await shot('industries');
  await clickText('Themes');
  await waitFor(`document.querySelector('[aria-label="Theme participation"] tbody tr') !== null`);
  await clickText('Leading Stocks');
  await waitFor(`document.querySelector('[aria-label="Leading Stocks"] tbody tr') !== null`);
  assert.ok(await evaluate(`/return 63/i.test(document.body.innerText)`));
  assert.equal(await evaluate(`document.querySelector('[aria-label="Leading Stocks"] tbody tr td a').textContent`), fixtures['leading_stocks:63'].leading_stocks[0].symbol);
  const leadersFit = `(() => {
    const content = document.querySelector('.market-health-content-leading_stocks');
    const table = document.querySelector('.market-health-leading-stocks .market-health-leader-table');
    const rows = table?.querySelectorAll('tbody tr');
    const footer = document.querySelector('.market-health-leading-stocks .MuiTablePagination-root');
    return content && table && rows.length > 1 && footer
      && content.scrollHeight <= content.clientHeight + 1
      && rows[rows.length - 1].getBoundingClientRect().bottom <= table.getBoundingClientRect().top + table.clientHeight + 1
      && footer.getBoundingClientRect().bottom <= window.innerHeight;
  })()`;
  await waitFor(leadersFit);
  const tallRowCount = await evaluate(`document.querySelectorAll('[aria-label="Leading Stocks"] tbody tr').length`);
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 750, deviceScaleFactor: 1, mobile: false });
  await waitFor(leadersFit);
  await waitFor(`document.querySelectorAll('[aria-label="Leading Stocks"] tbody tr').length < ${tallRowCount}`);
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await waitFor(`document.querySelectorAll('[aria-label="Leading Stocks"] tbody tr').length === ${tallRowCount}`);
  assert.equal(await evaluate(`document.querySelector('input[type="range"]')`), null);
  await evaluate(`document.querySelector('button[aria-label="Leader lookback"]').click()`);
  await waitFor(`document.querySelector('input[type="range"]') !== null`);
  await evaluate(`document.querySelector('input[type="range"]').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 });
  await waitFor(`/return 20/i.test(document.body.innerText) && window.__mhRequests.some(q => q.includes('leader_sessions=20')) && document.querySelector('[aria-label="Leading Stocks"] tbody tr') !== null`);
  assert.equal(await evaluate(`document.querySelector('[aria-label="Leading Stocks"] tbody tr td a').textContent`), fixtures['leading_stocks:20'].leading_stocks[0].symbol);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`document.querySelector('input[type="range"]') === null`);
  await evaluate(`document.querySelector('button[aria-label="Export Leading Stocks CSV"]').click()`);
  await waitFor(`window.__mhExports.length === 1`);
  assert.ok((await evaluate(`window.__mhExports[0]`)).split('\n')[0].includes('excess_20_pp'));
  await shot('leaders');
  await evaluate(`document.querySelector('button[aria-label="Leader lookback"]').click()`);
  await waitFor(`document.querySelector('input[type="range"]') !== null`);
  await evaluate(`document.querySelector('input[type="range"]').focus()`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await waitFor(`/return 252/i.test(document.body.innerText)`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await waitFor(`document.querySelector('input[type="range"]') === null`);
  await clickText('Market Breadth');
  await waitFor(`document.querySelectorAll('.market-health-chart').length === 3`);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS: four tabs, group drilldown, floating lookback, viewport-fitting pagination, three leader horizons, ranking, dynamic CSV, and no browser exceptions.');
  await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
} finally {
  socket.close();
}

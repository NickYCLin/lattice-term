// Measures the real sidebar at its default width with a full Chromium.
// Headless Linux uses an isolated Xvfb display so desktop hover capabilities are real.
// Requires an installed Chromium (CHROME or Playwright cache); reads no user profiles.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const root = fileURLToPath(new URL("..", import.meta.url));
const cache = path.join(homedir(), ".cache/ms-playwright");
const cached = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()
  .flatMap(name => [path.join(cache, name, "chrome-linux64/chrome"), path.join(cache, name, "chrome-linux/chrome"), path.join(cache, name, "chrome-win64/chrome.exe")]) : [];
const chrome = [process.env.CHROME, ...cached, "/usr/bin/chromium", "/usr/bin/google-chrome"].find(file => file && existsSync(file));
if (!chrome) throw new Error("Set CHROME to an installed Chromium executable.");
const work = mkdtempSync(path.join(tmpdir(), "latticeterm-folder-layout-"));
class DevTools {
  pending = new Map(); next = 1;
  async connect(url) {
    this.socket = new WebSocket(url);
    await new Promise((resolve, reject) => { this.socket.addEventListener("open", resolve, { once: true }); this.socket.addEventListener("error", reject, { once: true }); });
    this.socket.addEventListener("message", event => {
      const message = JSON.parse(event.data), waiting = this.pending.get(message.id);
      if (waiting) { this.pending.delete(message.id); message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.next++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}
let server, browser, devtools, virtualDisplay;
let markup = "";
try {
  server = await createServer({ root, configFile: false, plugins: [react(), { name: "card-layout-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__card-layout")) return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html data-theme="storybook"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles/index.css?direct"><style>body{padding:16px;overflow:auto}ul{padding:0;margin:0;list-style:none}</style></head><body>${markup}</body></html>`);
    });
  } }], define: { __APP_VERSION__: JSON.stringify("layout-fixture") }, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 1280, innerHeight: 900 };
  try {
    const [{ SessionProjectSidebar }, { I18nProvider }, { emptySessionSidebarLayout, createSessionSidebarFolder }] = await Promise.all([
      server.ssrLoadModule("/src/components/sessions/SessionProjectSidebar.tsx"), server.ssrLoadModule("/src/i18n/index.tsx"), server.ssrLoadModule("/src/app/sessionSidebarLayout.ts"),
    ]);
    let layout = emptySessionSidebarLayout;
    for (const [index, name] of ["測試-子資料夾", "測試-桃源水情", "測試-航空城"].entries()) layout = createSessionSidebarFolder(layout, { id: `folder:synthetic-${index}`, name }, null);
    const noop = () => {};
    const sidebar = createElement(SessionProjectSidebar, { projects: [], layout, activeSessionId: null, choosingProject: false, chooseError: false, mobileOpen: true,
      onMobileClose: noop, onChooseProject: noop, onLaunchProject: noop, onSelect: noop, onRemove: noop, onQuickLaunch: noop,
      onExportWorkspace: noop, onImportWorkspace: noop, onClearWorkspace: noop, onToggleFolder: noop, onCreateFolder: noop, onRenameFolder: noop, onDeleteFolder: noop, onRevealNode: noop, onMove: noop,
    });
    markup = renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-TW" }, createElement("div", { style: { display: "flex", width: "100%", minHeight: "320px" } }, sidebar)));
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
  await server.listen();
  const browserEnv = { ...process.env };
  if (process.platform === "linux" && !browserEnv.DISPLAY) {
    virtualDisplay = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x1024x24", "-nolisten", "tcp"], { stdio: ["ignore", "pipe", "ignore"] });
    const display = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Xvfb startup timed out")), 10000);
      let output = "";
      virtualDisplay.stdout.on("data", bytes => { output += bytes; if (/^\d+\n/.test(output)) { clearTimeout(timer); resolve(output.trim()); } });
      virtualDisplay.once("error", () => { clearTimeout(timer); reject(new Error("Desktop hover measurement needs Xvfb or an existing DISPLAY on Linux.")); });
      virtualDisplay.once("exit", code => { clearTimeout(timer); reject(new Error(`Xvfb exited during startup (${code})`)); });
    });
    browserEnv.DISPLAY = `:${display}`;
  }
  browser = spawn(chrome, [...(process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "--disable-background-networking", "--disable-extensions", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${work}`, "about:blank"], { env: browserEnv, stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chromium startup timed out")), 20000);
    browser.stderr.on("data", bytes => { output += bytes; const found = output.match(/DevTools listening on (ws:\/\/\S+)/); if (found) { clearTimeout(timer); resolve(found[1]); } });
    browser.on("exit", () => { clearTimeout(timer); reject(new Error(`Chromium exited before startup: ${output.slice(0, 1200)}`)); });
  });
  devtools = new DevTools(); await devtools.connect(endpoint);
  const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await devtools.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await devtools.send("Page.enable", {}, sessionId);
  await devtools.send("Page.navigate", { url: `http://127.0.0.1:${server.httpServer.address().port}/__card-layout` }, sessionId);
  const deadline = Date.now() + 20000;
  while (!await evaluate("document.querySelectorAll('.session-tree__folder-row').length === 3 && getComputedStyle(document.querySelector('.session-projects')).display !== 'none'")) {
    if (Date.now() > deadline) throw new Error("Fixture layout did not load");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await devtools.send("DOM.enable", {}, sessionId);
  await devtools.send("CSS.enable", {}, sessionId);
  const { root: documentNode } = await devtools.send("DOM.getDocument", {}, sessionId);
  const { nodeIds } = await devtools.send("DOM.querySelectorAll", { nodeId: documentNode.nodeId, selector: ".session-tree__folder-row" }, sessionId);
  const results = [];
  for (const mode of ["desktop", "touch", "mobile"]) for (const theme of ["dark", "light", "dusk", "linen", "storybook", "clarity"]) for (const width of [320, 760]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await devtools.send("Emulation.setTouchEmulationEnabled", { enabled: mode !== "desktop", maxTouchPoints: 1 }, sessionId);
    await evaluate(`document.body.classList.toggle('app--mobile', ${mode === "mobile"}); document.documentElement.dataset.theme=${JSON.stringify(theme)}; document.documentElement.dataset.motion='reduced'; document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    const touch = await evaluate("matchMedia('(hover: none)').matches");
    if (touch !== (mode !== "desktop")) throw new Error(`Input emulation mismatch: ${JSON.stringify({mode, theme, width, touch})}`);
    let baseline;
    for (const state of ["idle", "hover", "focus", "menu"]) {
      for (const nodeId of nodeIds) await devtools.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: state === "hover" ? ["hover"] : [] }, sessionId);
      await evaluate(`document.activeElement?.blur();document.querySelectorAll('.session-tree__folder-row').forEach(row=>row.classList.toggle('is-menu-open', ${state === "menu"}));`);
      const measurements = await evaluate(`(() => {
        const sidebar = document.querySelector('.session-projects');
        const rows = [...document.querySelectorAll('.session-tree__folder-row')].map(row => {
          const button = row.querySelector('.session-tree__folder-select'), name = button.querySelector('.truncate'), actions = row.querySelector('.session-tree__folder-actions');
          if (${state === "focus"}) button.focus({preventScroll:true});
          const box = row.getBoundingClientRect(), text = name.getBoundingClientRect(), controls = actions.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(name);
          const fullWidth = range.getBoundingClientRect().width, fontSize = parseFloat(getComputedStyle(name).fontSize);
          const shown = getComputedStyle(actions).display !== 'none';
          return { name: name.textContent, fullWidth, visibleWidth: text.width, minimum: 4 * fontSize, controlsWidth:controls.width, shown, controlCount:actions.querySelectorAll('button').length,
            overlap: shown && text.right > controls.left + 0.75, top:box.top, height:box.height };
        });
        return { sidebarWidth:sidebar.getBoundingClientRect().width, rows };
      })()`);
      if (state === "idle") baseline = measurements;
      const failed = measurements.rows.some((row, index) => row.controlCount !== 1 || row.overlap || row.visibleWidth + 0.75 < row.minimum
        || state === "idle" && row.visibleWidth + 0.75 < row.fullWidth
        || row.shown !== (mode !== "desktop" || state !== "idle")
        || mode === "desktop" && state === "idle" && row.controlsWidth !== 0
        || Math.abs(row.top - baseline.rows[index].top) > 0.75 || Math.abs(row.height - baseline.rows[index].height) > 0.75);
      if (failed) throw new Error(`Folder layout failure: ${JSON.stringify({mode, theme, width, state, measurements, baseline})}`);
      results.push({ mode, theme, width, state, ...measurements });
    }
  }
  console.log(`${results.length} sidebar layouts passed; 0 failed (3 input/UI modes × 6 themes × 2 widths × 4 states; real sidebar, three synthetic folder names)`);
  if (process.env.FOLDER_LAYOUT_RESULTS) writeFileSync(process.env.FOLDER_LAYOUT_RESULTS, JSON.stringify(results, null, 2));
} finally {
  devtools?.socket?.close(); browser?.kill();
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  virtualDisplay?.kill();
  await server?.close(); rmSync(work, { recursive: true, force: true });
}

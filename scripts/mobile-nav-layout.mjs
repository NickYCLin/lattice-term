// Synthetic mobile NavRail width regression; fresh Chromium profile, no user data.
// Run with CHROMIUM_NO_SANDBOX=1 where sandboxing is unavailable.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
const root = fileURLToPath(new URL("..", import.meta.url));
const cache = path.join(homedir(), ".cache/ms-playwright");
const cached = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith("chromium_headless_shell-")).sort().reverse()
  .flatMap(name => [path.join(cache, name, "chrome-linux/headless_shell"), path.join(cache, name, "chrome-headless-shell-linux64/chrome-headless-shell")]) : [];
const chrome = [process.env.CHROME, ...cached, "/usr/bin/chromium", "/usr/bin/google-chrome"].find(file => file && existsSync(file));
if (!chrome) throw new Error("Set CHROME to an installed Chromium executable.");
const work = mkdtempSync(path.join(tmpdir(), "latticeterm-nav-layout-"));
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
let server, browser, devtools;
let markup = "";
try {
  server = await createServer({ root, configFile: false, plugins: [react(), { name: "nav-layout-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__nav-layout")) return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/src/styles/index.css?direct"></head><body><div class="app app--mobile">${markup}</div></body></html>`);
    });
  } }], define: { __APP_VERSION__: JSON.stringify("layout-fixture") }, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  const [{ NavRail }, { I18nProvider }, { navigationItemsFor }] = await Promise.all([
    server.ssrLoadModule("/src/components/shell/NavRail.tsx"), server.ssrLoadModule("/src/i18n/index.tsx"), server.ssrLoadModule("/src/app/navigation.ts"),
  ]);
  await server.listen();
  browser = spawn(chrome, [...(process.env.CHROMIUM_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), "--disable-background-networking", "--disable-extensions", "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${work}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
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
  let passed = 0;
  for (const width of [320, 393, 760, 1024]) for (const theme of ["dark", "light", "dusk", "linen", "storybook", "clarity"]) {
    const compact = width <= 672;
    globalThis.window = { matchMedia: () => ({ matches: compact }) };
    try {
      markup = renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-TW" }, createElement(NavRail, {
        mobile: true, current: "settings", items: navigationItemsFor("ios"), activityUnreadCount: 3, onSelect() {},
      })));
    } finally { delete globalThis.window; }
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId);
    await devtools.send("Page.navigate", { url: `http://127.0.0.1:${server.httpServer.address().port}/__nav-layout?width=${width}&theme=${theme}` }, sessionId);
    const deadline = Date.now() + 20000;
    while (!await evaluate("!!document.querySelector('.rail') && getComputedStyle(document.querySelector('.rail__items')).flexDirection === 'row'")) {
      if (Date.now() > deadline) throw new Error("Mobile nav fixture did not load");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    const result = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.rail__item')];
      const settings = buttons.find(button => button.getAttribute('aria-label') === '設定');
      const label = settings.querySelector('.rail__label'), rect = label.getBoundingClientRect();
      const bounds = settings.getBoundingClientRect();
      const range = document.createRange(); range.selectNodeContents(label);
      const text = range.getBoundingClientRect();
      return {
        count: buttons.length, more: buttons.some(button => button.getAttribute('aria-haspopup') === 'menu'),
        minWidth: Math.min(...buttons.map(button => button.getBoundingClientRect().width)),
        minHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)),
        clipped: text.left < rect.left - 1 || text.right > rect.right + 1 || bounds.right > innerWidth || bounds.left < 0,
        overflow: document.querySelector('.rail__items').scrollWidth > document.querySelector('.rail__items').clientWidth + 1,
      };
    })()`);
    if (result.count !== (compact ? 5 : 7) || result.more !== compact || result.clipped || result.overflow || result.minWidth < 44 || result.minHeight < 44) {
      throw new Error(`Mobile nav layout failed: ${JSON.stringify({ width, theme, result })}`);
    }
    passed++;
  }
  console.log(`${passed} mobile nav layouts passed; 0 failed (4 widths × 6 themes; phone 5 / iPad 7; settings fully visible; targets >=44px)`);
} finally {
  devtools?.socket?.close(); browser?.kill();
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  await server?.close(); rmSync(work, { recursive: true, force: true });
}

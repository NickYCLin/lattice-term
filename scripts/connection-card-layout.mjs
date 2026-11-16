// Synthetic real-component layout check. Requires an existing Chromium (CHROME
// or a Playwright cache); no connection is opened and no user profile is read.
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
const cached = existsSync(cache) ? readdirSync(cache).filter(name => name.startsWith("chromium_headless_shell-")).sort().reverse()
  .flatMap(name => [path.join(cache, name, "chrome-linux/headless_shell"), path.join(cache, name, "chrome-headless-shell-linux64/chrome-headless-shell")]) : [];
const chrome = [process.env.CHROME, ...cached, "/usr/bin/chromium", "/usr/bin/google-chrome"].find(file => file && existsSync(file));
if (!chrome) throw new Error("Set CHROME to an installed Chromium executable.");
const work = mkdtempSync(path.join(tmpdir(), "latticeterm-card-layout-"));
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
  server = await createServer({ root, configFile: false, plugins: [react(), { name: "card-layout-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith("/__card-layout")) return next();
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html data-theme="storybook"><head><link rel="stylesheet" href="/src/styles/index.css?direct"><style>body{padding:16px;overflow:auto}ul{padding:0;margin:0;list-style:none}</style></head><body>${markup}</body></html>`);
    });
  } }], define: { __APP_VERSION__: JSON.stringify("layout-fixture") }, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  const [{ ConnectionCard }, { I18nProvider }, { createConnectionProfile, emptyDraft }] = await Promise.all([
    server.ssrLoadModule("/src/components/connections/ConnectionCard.tsx"), server.ssrLoadModule("/src/i18n/index.tsx"), server.ssrLoadModule("/src/domain/connection.ts"),
  ]);
  const noop = () => {};
  const cards = Array.from({ length: 6 }, (_, i) => {
    const profile = createConnectionProfile({ ...emptyDraft("ssh"), name: i === 2 ? "A deliberately long synthetic project name" : `Fixture ${i + 1}`,
      hostname: i === 2 ? "long-synthetic-hostname-with-many-segments.example.invalid" : "host.example.invalid", username: "reviewer",
      tags: i === 3 ? ["synthetic long tag ".repeat(4), "second tag", "third tag"] : [],
    }, `fixture-${i}`);
    return createElement(ConnectionCard, { key: i, profile, selected: false, onSelect: noop, onEdit: noop, onDelete: noop, onDuplicate: noop, onToggleFavorite: noop,
      onConnect: i === 4 ? undefined : noop, unavailableReason: "runtime-unsupported",
      ...(i % 2 ? { onOpenSql: noop, databaseCount: 2, databaseNames: ["synthetic reporting database"] } : {}),
      ...(i === 0 || i === 3 ? { jumpOptions: [{ key: "direct", label: "直連", connect: noop }, { key: "jump", label: "經跳板：Synthetic Gateway", connect: noop }] } : {}),
      linked: i === 1 || i === 5 ? [{ profile: { ...profile, id: `linked-${i}` }, onConnect: noop }] : [],
    });
  });
  markup = renderToStaticMarkup(createElement(I18nProvider, { locale: "zh-TW" }, createElement("ul", { className: "connection-grid" }, cards)));
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
  await devtools.send("Page.navigate", { url: `http://127.0.0.1:${server.httpServer.address().port}/__card-layout` }, sessionId);
  const deadline = Date.now() + 20000;
  while (!await evaluate("document.querySelectorAll('.connection-card').length === 6 && getComputedStyle(document.querySelector('.connection-grid')).display === 'grid'")) {
    if (Date.now() > deadline) throw new Error("Fixture layout did not load");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const themes = ["dark", "light", "dusk", "linen", "storybook", "clarity"];
  const results = [];
  for (const mobile of [false, true]) for (const theme of themes) for (const density of ["comfortable", "compact"]) for (const width of [320, 760, 1280]) for (const scale of [1, 2]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height: 1400, deviceScaleFactor: 1, mobile: false }, sessionId);
    await evaluate(`document.body.classList.toggle("app--mobile",${mobile});document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.dataset.density=${JSON.stringify(density)};document.documentElement.style.setProperty('--interface-text-scale',${JSON.stringify(String(scale))});document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    const result = await evaluate(`(() => {
      const boxes = [...document.querySelectorAll('.connection-card')].map(card => {
        const rect = card.getBoundingClientRect(), action = card.querySelector('.connection-card__primary').getBoundingClientRect(), footer = card.querySelector('.connection-card__footer').getBoundingClientRect();
        const buttons = [...card.querySelectorAll('.connection-card__primary button, .connection-card__jump select')].map(button => button.getBoundingClientRect());
        const favorite = card.querySelector('.connection-card__favorite').getBoundingClientRect();
        const first = card.querySelector('.connection-card__primary').firstElementChild.getBoundingClientRect();
        const jump = card.querySelector('.connection-card__jump');
        const label = jump?.querySelector('.visually-hidden');
        const labelStyle = label && getComputedStyle(label);
        const launch = card.querySelector('.connection-card__go')?.getBoundingClientRect();
        const route = jump?.querySelector('select')?.getBoundingClientRect();
        const jumpAligned = !jump || !!launch && !!route && Math.abs(launch.top-route.top) <= 0.75 && Math.abs(launch.height-route.height) <= 0.75 && route.left >= launch.right-1 && labelStyle.position === 'absolute';
        return { jumpAligned, top:rect.top, height:rect.height, action:action.top, footer:footer.top, first:first.top, start:first.left-rect.left, favoriteRight:rect.right-favorite.right, buttonHeights:buttons.map(button=>button.height), overflow:card.scrollWidth>card.clientWidth+1 };
      });
      return { boxes, overflow:document.documentElement.scrollWidth>innerWidth+1 };
    })()`);
    const groups = Map.groupBy(result.boxes, box => Math.round(box.top));
    const near = values => Math.max(...values) - Math.min(...values) <= 0.75;
    if (result.overflow || result.boxes.some(box => box.overflow || !box.jumpAligned) || [...groups.values()].some(row =>
      ["height", "action", "footer", "first", "start", "favoriteRight"].some(key => !near(row.map(box => box[key])))
        || !near(row.flatMap(box => box.buttonHeights)))) {
      throw new Error(`Misalignment: ${JSON.stringify({ mobile, theme, density, width, scale, result })}`);
    }
    results.push({ mobile, theme, density, width, scale, rows:groups.size });
    if (!mobile && theme === "storybook" && density === "comfortable" && width === 1280 && scale === 1 && process.env.CARD_LAYOUT_SCREENSHOT) {
      const { data } = await devtools.send("Page.captureScreenshot", { format: "png" }, sessionId);
      writeFileSync(process.env.CARD_LAYOUT_SCREENSHOT, Buffer.from(data, "base64"));
    }
  }
  console.log(`${results.length} Chromium layouts passed; 0 failed (2 desktop/mobile modes × 6 themes × 2 densities × 3 widths × 2 text scales)`);
  if (process.env.CARD_LAYOUT_RESULTS) writeFileSync(process.env.CARD_LAYOUT_RESULTS, JSON.stringify(results, null, 2));
} finally {
  devtools?.socket?.close(); browser?.kill();
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  await server?.close(); rmSync(work, { recursive: true, force: true });
}

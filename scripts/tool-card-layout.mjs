// Synthetic real-component layout check. Requires an existing Chromium (CHROME
// or a Playwright cache); no external service is contacted and no user profile is read.
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
const work = mkdtempSync(path.join(tmpdir(), "latticeterm-tool-layout-"));
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
  const [{ ReadableToolCard }, { presentTool }, { I18nProvider }, { ConversationTimeline }] = await Promise.all([
    server.ssrLoadModule("/src/components/chat/ReadableToolCard.tsx"), server.ssrLoadModule("/src/app/toolPresentation.ts"), server.ssrLoadModule("/src/i18n/index.tsx"), server.ssrLoadModule("/src/components/chat/ConversationTimeline.tsx"),
  ]);
  const input = 'text(await tools.exec_command({cmd:"ls ' + "synthetic-long-path/".repeat(28) + '",workdir:"/synthetic/project"}));';
  const tools = [
    presentTool({ id:"command", aliases:["command"], name:"exec", input, output:"one\ntwo\nthree\nfour\n" + "long-output".repeat(80), done:true, isError:false }),
    presentTool({ id:"fallback", aliases:["fallback"], name:"unknown", input:"unparsed-argument".repeat(80), output:"raw result", done:true, isError:false }),
    presentTool({ id:"error", aliases:["error"], name:"command", input:"npm test", output:"failure".repeat(80), done:true, isError:true }),
    presentTool({ id:"diff", aliases:["diff"], name:"apply_patch", input:"--- a/synthetic\n+++ b/synthetic\n@@ -1 +1 @@\n+" + "line".repeat(80), output:"changed", done:true, isError:false }),
  ];
  markup = renderToStaticMarkup(createElement(I18nProvider, { locale:"zh-TW" }, createElement("main", {className:"tool-fixture"}, tools.map(tool => createElement(ReadableToolCard, {key:tool.id, tool, forceOpen:true})))));
  const rows = [
    {id:"user", aliases:["user"],user:true,process:false,node:createElement("p",null,"Synthetic question")},
    ...Array.from({length:50},(_,i)=>({id:String(i),aliases:[String(i)],user:false,process:true,node:createElement("p",null,"Synthetic process step")})),
    {id:"final",aliases:["final"],user:false,process:false,node:createElement("p",null,"Synthetic final answer")},
  ];
  markup += renderToStaticMarkup(createElement(I18nProvider,{locale:"zh-TW"},createElement("div",{className:"collapsed-proof"},createElement(ConversationTimeline,{rows,collapseDefault:true,latestFinished:true}))));
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
  while (!await evaluate("document.querySelectorAll('.chat-card--tool').length === 4")) {
    if (Date.now() > deadline) throw new Error("Fixture layout did not load");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const results = [];
  for (const mobile of [false, true]) for (const theme of ["dark", "light", "dusk", "linen", "storybook", "clarity"]) for (const width of [320,760,1280]) for (const expanded of [false,true]) {
    await devtools.send("Emulation.setDeviceMetricsOverride", { width, height:1400, deviceScaleFactor:1, mobile:false }, sessionId);
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.body.classList.toggle('app--mobile',${mobile});document.querySelectorAll('details').forEach(node=>node.open=${expanded});document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    const result = await evaluate(`(() => ({ page:document.documentElement.scrollWidth>innerWidth+1, collapsedHeight:document.querySelector(".collapsed-proof").getBoundingClientRect().height, cards:[...document.querySelectorAll('.chat-card--tool')].map(node=>({width:node.clientWidth,scroll:node.scrollWidth,overflow:node.scrollWidth>node.clientWidth+1})) }))()`);
    if(result.page || result.collapsedHeight > 250 || result.cards.some(card=>card.overflow)) throw new Error(`Tool layout failure: ${JSON.stringify({theme,width,mobile,expanded,result})}`);
    results.push({theme,width,mobile,expanded});
  }
  console.log(`${results.length} tool card layouts passed; 0 failed (6 themes x 3 widths x 2 UI modes x 2 detail states)`);

} finally {
  devtools?.socket?.close(); browser?.kill();
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  await server?.close(); rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

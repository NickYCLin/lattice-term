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
const work = mkdtempSync(path.join(tmpdir(), "latticeterm-composer-layout-"));
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
      res.end(`<!doctype html><html data-theme="storybook"><head><link rel="stylesheet" href="/src/styles/index.css?direct"><style>body{padding:16px;overflow:auto}.layout-fixture{display:flex;gap:16px;flex-wrap:wrap}.sidebar-fixture{width:min(18rem,100%);flex:none;min-width:0}.composer-fixture{flex:1;min-width:min(280px,100%)}.session-composer{width:100%}.menu-fixture{z-index:1000}</style></head><body>${markup}</body></html>`);
    });
  } }], define: { __APP_VERSION__: JSON.stringify("layout-fixture") }, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  const [{ ConversationComposerFrame }, { ComposerPermissionMenu }, { ConversationIdentity, ConversationListIdentity, ConversationMetadata }, { I18nProvider }] = await Promise.all([
    server.ssrLoadModule("/src/components/chat/ConversationComposer.tsx"), server.ssrLoadModule("/src/components/chat/ComposerPermissionMenu.tsx"),
    server.ssrLoadModule("/src/components/chat/ConversationPresentation.tsx"),server.ssrLoadModule("/src/i18n/index.tsx"),
  ]);
  const noop=()=>{};
  const sidebar=createElement("aside",{className:"sidebar-fixture"},["測試-子資料夾","測試-桃源水情","測試-航空城"].map(title=>createElement("div",{className:"chat-thread",key:title},createElement(ConversationListIdentity,{title},createElement(ConversationMetadata,{compact:true,at:1700000000000,labels:{provider:"OpenAI",source:"Codex CLI",model:"synthetic-model",endpoint:null,account:null,project:"Synthetic"}})))));
  const composer=createElement("section",{className:"composer-fixture"},
    createElement("header",{className:"chat-header"},createElement("div",{className:"chat-header__title"},createElement(ConversationIdentity,{title:"Synthetic long conversation title ".repeat(8),assistant:"Codex"},createElement("span",{className:"chat-chip"},"Codex · synthetic-model")))),
    createElement("form",{className:"chat-composer session-composer"},createElement(ConversationComposerFrame,{workingDirectory:"/synthetic/"+"long-project-name".repeat(12),directoryControls:{disabled:false,onChoose:noop,onChange:noop,candidates:[]}},
      createElement("div",{className:"chat-composer__box session-composer__box"},createElement("textarea",{className:"chat-composer__input",rows:2,defaultValue:"Synthetic message"}),
        createElement("div",{className:"session-composer__toolbar"},createElement(ComposerPermissionMenu,{value:"ask",disabled:false,onChange:noop,options:[{value:"ask",label:"每次詢問",description:"執行前先核准"}]}),createElement("button",{className:"session-composer__model",type:"button"},"synthetic-model"))))));
  markup=renderToStaticMarkup(createElement(I18nProvider,{locale:"zh-TW"},createElement("div",{className:"layout-fixture"},sidebar,composer)));
  markup+='<div class="composer-menu menu-fixture" style="display:none"><input class="input" placeholder="搜尋最近的專案">'+Array.from({length:8},(_,i)=>'<button class="composer-menu__item" role="menuitem"><span>Synthetic project '+i+'</span><small>/synthetic/'+"long-directory-segment/".repeat(12)+'</small></button>').join('')+'</div>';
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
  while (!await evaluate("document.querySelectorAll('.chat-thread__title').length === 3")) {
    if (Date.now() > deadline) throw new Error("Fixture layout did not load");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const results = [];
  for(const mobile of [false,true]) for(const theme of ["dark","light","dusk","linen","storybook","clarity"]) for(const width of [320,760,1280]) for(const expanded of [false,true]) for(const scale of [1,2]) {
    await devtools.send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:false},sessionId);
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.body.classList.toggle('app--mobile',${mobile});document.documentElement.style.setProperty('--interface-text-scale',${JSON.stringify(String(scale))});document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))`);
    const result=await evaluate(`(()=>{
      const menu=document.querySelector('.menu-fixture');menu.style.display=${expanded}? 'grid':'none';
      if(${expanded}){menu.style.width=Math.min(360,innerWidth-16)+'px';menu.style.maxHeight=(innerHeight-16)+'px';const rect=document.querySelector('.session-composer__directory-button').getBoundingClientRect(),height=menu.getBoundingClientRect().height;menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-menu.getBoundingClientRect().width-8))+'px';menu.style.top=Math.max(8,Math.min(rect.top-height-6,innerHeight-height-8))+'px';}
      const names=[...document.querySelectorAll('.chat-thread__title')].map(node=>{const range=document.createRange();range.selectNodeContents(node);return {width:node.clientWidth,full:range.getBoundingClientRect().width,minimum:4*parseFloat(getComputedStyle(node).fontSize)}});
      const popup=menu.getBoundingClientRect();
      return {page:document.documentElement.scrollWidth>innerWidth+1,names,composer:document.querySelector('.composer-fixture').scrollWidth>document.querySelector('.composer-fixture').clientWidth+1,
        menu:${expanded}&&(popup.left<7||popup.top<7||popup.right>innerWidth-7||popup.bottom>innerHeight-7||menu.scrollWidth>menu.clientWidth+1)};
    })()`);
    if(result.page||result.composer||result.menu||result.names.some(name=>name.width+.75<name.minimum||name.width+.75<name.full))throw new Error(`Composer/sidebar layout failure: ${JSON.stringify({theme,width,mobile,expanded,scale,result})}`);
    results.push({theme,width,mobile,expanded,scale});
  }
  console.log(`${results.length} composer/sidebar layouts passed; 0 failed (6 themes x 3 widths x 2 UI modes x 2 menu states x 2 text scales)`);

} finally {
  devtools?.socket?.close(); browser?.kill();
  if (browser && browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 3000); });
  await server?.close(); rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

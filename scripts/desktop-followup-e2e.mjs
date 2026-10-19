import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import { createServer } from "node:http";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(resolve(tmpdir(), "lattice-followup-gui-"));
const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));
let executable = process.env.LATTICETERM_E2E_CHROMIUM;
if (!executable) {
  const cache = resolve(homedir(), ".cache/ms-playwright");
  const candidates = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort();
  assert(candidates.length, "Existing isolated Chromium is required; no installation attempted");
  executable = resolve(cache, candidates.at(-1), "chrome-headless-shell-linux64/chrome-headless-shell");
}
await writeFile(resolve(temporary, "index.html"), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="root"></div><div class="agent-terminal-pane" style="position:fixed;bottom:0;height:180px;width:100%;pointer-events:none"><div id="terminal" class="terminal-pane agent-terminal"></div></div><script type="module" src="/fixture.tsx"></script>');
await writeFile(resolve(temporary, "fixture.tsx"), `import ${JSON.stringify(resolve(repo, "scripts/desktop-followup-e2e/fixture.tsx"))};`);
await build({ configFile: false, plugins: [react()], root: temporary, resolve: { alias: { "@tauri-apps/api/core": resolve(repo, "scripts/desktop-followup-e2e/mock-ipc.ts") } }, build: { outDir: resolve(temporary, "dist"), emptyOutDir: true } });
await mkdir(resolve(temporary, "profile"));
const browser = spawn(executable, ["--headless", "--remote-debugging-port=0", "--no-first-run", `--user-data-dir=${temporary}/profile`, "about:blank"], { stdio: "ignore" });
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const path = resolve(temporary, "dist", `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!path.startsWith(resolve(temporary, "dist") + "/")) { response.writeHead(403).end(); return; }
  try {
    response.setHeader("Content-Type", path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolveServer => server.listen(0, "127.0.0.1", resolveServer));
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { port = (await readFile(resolve(temporary, "profile/DevToolsActivePort"), "utf8")).split("\n")[0]; break; } catch { await wait(100); }
  }
  assert(port, "Isolated browser did not start");
  const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
  const page = targets.find(target => target.type === "page" && target.url === "about:blank");
  assert(page, "Fresh blank page not found in isolated browser");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolveSocket, reject) => { socket.onopen = resolveSocket; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  socket.onmessage = event => { const result = JSON.parse(event.data); if (result.method === "Runtime.exceptionThrown") console.error(JSON.stringify(result)); if (result.id) { pending.get(result.id)?.(result); pending.delete(result.id); } };
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, result => { clearTimeout(timeout); result.error ? reject(new Error(JSON.stringify(result.error))) : resolveCall(result.result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => { const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails)); return result.result.value; };
  const key = async (keyValue, code = keyValue) => {
    const windowsVirtualKeyCode = { Enter: 13, Escape: 27, Tab: 9 }[keyValue];
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: keyValue, code, windowsVirtualKeyCode });
    if (keyValue === "Enter") await call("Input.dispatchKeyEvent", { type: "char", text: "\r", key: keyValue, code, windowsVirtualKeyCode });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: keyValue, code, windowsVirtualKeyCode }); await wait(50);
  };
  const click = async selector => { const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'center'});const rect=element.getBoundingClientRect();return {x:rect.left+rect.width/2,y:rect.top+rect.height/2}})()`); await call("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }); await call("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }); await wait(150); };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate("typeof fixtureFit === 'function'")) break;
    await wait(100);
  }
  assert(await evaluate("typeof fixtureFit === 'function'"), await evaluate("document.documentElement.outerHTML"));
  const settingsGeometry = [];
  await evaluate("window.fixtureStartup={enabled:false,failure:true,writes:0}");
  await click("#startup");
  assert(await evaluate("!!document.querySelector('#startup-fixture [role=alert]')"));
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 760, 1000]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      await wait(350);
      const geometry = await evaluate(`Array.from(document.querySelectorAll('#startup-fixture > .panel')).map(panel=>{const rect=panel.getBoundingClientRect(),style=getComputedStyle(panel);return {width:${width},theme:${JSON.stringify(theme)},left:rect.left,right:rect.right,border:style.borderTopWidth,borderStyle:style.borderTopStyle,radius:style.borderRadius,padding:style.padding,background:style.backgroundColor,overflow:panel.scrollWidth-panel.clientWidth}})`);
      assert(geometry.every(panel => panel.left >= 0 && panel.right <= width && panel.overflow <= 1 && parseFloat(panel.border) > 0), JSON.stringify(geometry));
      assert.equal(geometry[0].radius, geometry[1].radius);
      assert.equal(geometry[0].padding, geometry[1].padding);
      assert(await evaluate("document.querySelector('#startup-fixture .setting__text').getBoundingClientRect().width >= 180"), JSON.stringify(geometry));
      settingsGeometry.push(...geometry);
      await evaluate("document.querySelector('#startup-fixture').scrollIntoView({block:'start'})");
      await writeFile(resolve(temporary, `settings-${theme}-${width}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
    }
  }
  await evaluate("fixtureStartup.failure=false");
  await click("#startup-fixture [role=alert] button");
  assert.equal(await evaluate("document.querySelectorAll('#startup-fixture [role=radio]')[1].getAttribute('aria-checked')"), "true");
  const settingsBefore = await evaluate("document.querySelector('#startup-fixture > .panel').getBoundingClientRect().height");
  await click("#startup-fixture [role=radio]");
  assert(await evaluate("Array.from(document.querySelectorAll('#startup-fixture [role=radio]')).every(button=>button.disabled)"));
  assert.equal(await evaluate("fixtureStartup.writes"), 1);
  assert.equal(await evaluate("document.querySelector('#startup-fixture > .panel').getBoundingClientRect().height"), settingsBefore);
  await evaluate("fixtureStartup.release()"); await wait(150);
  assert.equal(await evaluate("document.querySelector('#startup-fixture [role=radio]').getAttribute('aria-checked')"), "true");
  assert.equal(await evaluate("document.querySelector('#startup-fixture > .panel').getBoundingClientRect().height"), settingsBefore);
  await evaluate("document.querySelector('#startup-fixture [role=radio]').focus()"); await key("Tab");
  assert.equal(await evaluate("document.activeElement.getAttribute('role')"), "radio");
  await click("#startup");
  const archiveGeometry = [];
  for (const width of [320, 760, 1000]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    archiveGeometry.push(await evaluate(`(()=>{const main=document.querySelector('#archive-layout .chat-main').getBoundingClientRect(),aside=document.querySelector('#archive-layout .chat-threads').getBoundingClientRect();return {width:${width},main:{x:main.x,y:main.y,width:main.width},aside:{x:aside.x,y:aside.y,width:aside.width},overflow:document.querySelector('#archive-layout').scrollWidth-document.querySelector('#archive-layout').clientWidth}})()`));
    const selector = width <= 720 ? "#archive-layout .chat-archive-status--mobile" : "#archive-layout .chat-threads";
    assert(await evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width > 0`));
    await click(selector + " button");
    await evaluate(`document.querySelectorAll(${JSON.stringify(selector + " button")})[1].focus()`); await key("Enter");
  }
  assert(archiveGeometry.every(item=>item.main.width>0 && item.overflow<=1), JSON.stringify(archiveGeometry));
  assert.equal(await evaluate("fixtureEvidence.archiveRetries"), 3);
  assert.equal(await evaluate("fixtureEvidence.archiveRestores"), 3);
  const measurements = [];
  for (const width of [320, 760, 1280]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate("fixtureFit()"); await wait(150);
    measurements.push(await evaluate(`(()=>{const screen=document.querySelector('#terminal .xterm-screen').getBoundingClientRect();const bar=document.querySelector('#terminal .xterm-vertical').getBoundingClientRect();return {width:${width},overlap:Math.max(0,screen.right-bar.left),cols:document.querySelector('#terminal .xterm-screen').style.width}})()`));
  }
  assert(measurements.every(item => item.overlap === 0), JSON.stringify(measurements));
  await call("Emulation.setDeviceMetricsOverride", { width: 320, height: 480, deviceScaleFactor: 1, mobile: false });
  await click(".agents-skills__filters input"); await call("Input.insertText", { text: "fixture-19-" }); await wait(150);
  assert.equal(await evaluate("document.querySelectorAll('.agents-skills__list li').length"), 1);
  await key("Tab");
  assert.equal(await evaluate("document.activeElement.tagName"), "SELECT");
  await evaluate("document.querySelector('.agents-skills__filters select').value='project';document.querySelector('.agents-skills__filters select').dispatchEvent(new Event('change',{bubbles:true}))"); await wait(100);
  assert.equal(await evaluate("document.querySelectorAll('.agents-skills__list li').length"), 0);
  await click(".agents-skills__filters button");
  assert.equal(await evaluate("document.querySelectorAll('.agents-skills__list li').length"), 200);
  await click(".agents-skills__list summary");
  assert(await evaluate("document.querySelector('.agents-skills__list details').open"));
  await key("Enter");
  assert.equal(await evaluate("document.querySelector('.agents-skills__list details').open"), false);
  await click("#handoff");
  assert.equal(await evaluate("document.activeElement.textContent"), "取消");
  const dialogGeometry = await evaluate("(()=>{const rect=document.querySelector('[role=alertdialog]').getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom,height:innerHeight,width:rect.width}})()");
  await writeFile(resolve(temporary, "dialog-geometry.json"), JSON.stringify(dialogGeometry));
  assert(dialogGeometry.top >= 0 && dialogGeometry.bottom <= dialogGeometry.height, JSON.stringify(dialogGeometry));
  await click("textarea"); await call("Input.insertText", { text: "Synthetic goal and pending work" });
  await evaluate("document.querySelectorAll('.dialog__actions button')[1].focus()"); await key("Enter"); await wait(150);
  assert.equal(await evaluate("fixtureEvidence.confirmations"), 1);
  assert.equal(await evaluate("document.querySelector('textarea').value"), "Synthetic goal and pending work");
  await evaluate("document.querySelector('[role=alertdialog] select').value='claude:::';document.querySelector('[role=alertdialog] select').dispatchEvent(new Event('change',{bubbles:true}))"); await wait(100);
  await evaluate("document.querySelectorAll('.dialog__actions button')[1].focus()"); await key("Enter");
  assert.equal(await evaluate("fixtureEvidence.confirmations"), 2);
  assert.equal(await evaluate("fixtureEvidence.recipient"), "claude");
  assert.equal(await evaluate("document.querySelector('[role=alertdialog]') === null"), true);
  await click("#handoff");
  await key("Escape");
  assert.equal(await evaluate("document.querySelector('[role=alertdialog]') === null"), true);
  assert.equal(await evaluate("document.activeElement.id"), "handoff");
  await click(".agent-session-images__toolbar button");
  assert(await evaluate("document.body.textContent.includes('synthetic screenshot')"));
  await click(".agent-session-images__tile");
  await key("Escape"); await key("Escape");
  assert.equal(await evaluate("document.querySelector('[aria-modal=true]') === null"), true);
  const before = await evaluate("({...fixtureEvidence})");
  for (let index = 0; index < 20; index++) { await evaluate("fixtureWrite()"); await wait(100); }
  const afterStream = await evaluate("({...fixtureEvidence})");
  await wait(2200);
  const afterIdle = await evaluate("({...fixtureEvidence})");
  assert.equal(afterIdle.renders, afterStream.renders);
  assert(afterStream.fits - before.fits <= 2, JSON.stringify({ before, afterStream }));
  const modes = [];
  for (const theme of ["light", "dark"]) {
    for (const zoom of [1, 1.25, 1.5]) {
      await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};document.documentElement.style.zoom=${zoom};fixtureFit()`);
      await wait(350);
      modes.push(await evaluate(`(()=>{const screen=document.querySelector('#terminal .xterm-screen').getBoundingClientRect();const bar=document.querySelector('#terminal .xterm-vertical').getBoundingClientRect();return {theme:${JSON.stringify(theme)},zoom:${zoom},overlap:Math.max(0,screen.right-bar.left)}})()`));
    }
  }
  assert(modes.every(mode => mode.overlap < 1), JSON.stringify(modes));
  await evaluate("document.documentElement.style.zoom=1");
  const refreshBefore = await evaluate("({...fixtureEvidence})");
  for (let index = 0; index < 10; index++) await click("#background");
  const refreshAfter = await evaluate("({...fixtureEvidence})");
  assert.equal(refreshAfter.mounts, refreshBefore.mounts);
  assert.equal(refreshAfter.renders, refreshBefore.renders);
  const evidence = { scope: "Isolated Chromium; real React, xterm and keyboard/mouse; synthetic IPC only, not installed Windows/WebKit or full App navigation", settingsGeometry, settingsBefore, archiveGeometry, measurements, modes, dialogGeometry, before, afterStream, afterIdle, refreshBefore, refreshAfter };
  await writeFile(resolve(temporary, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`PASS ${temporary}/evidence.json`);
} finally { socket?.close(); browser.kill(); server.close(); }

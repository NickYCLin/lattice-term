// Captures docs/assets/chat-workspace.<locale>.png for every README language
// from scripts/product-screenshots/showcase.tsx.
//   npm run screenshots:product            all locales
//   npm run screenshots:product -- ja ko   only these
// CHROME may point at any Chromium-based browser. A Playwright Chromium is
// preferred when present: a managed Google Chrome can load policy extensions
// that keep a headless page from ever loading.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { build, preview } from "vite";

const root = fileURLToPath(new URL("../..", import.meta.url));
const LOCALES = ["zh-TW", "en", "zh-CN", "ja", "ko", "es", "fr", "de", "pt-BR"];
const WIDTH = 1200;
const HEIGHT = 780;
// Rendered once the sidebar and the open conversation are on screen.
const READY = "document.querySelector('.chat-thread') && document.querySelector('.chat-msg, .chat-settings') && document.fonts.status === 'loaded'";

function playwrightChromium() {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "ms-playwright")
      : process.platform === "darwin"
        ? path.join(homedir(), "Library/Caches/ms-playwright")
        : path.join(homedir(), ".cache/ms-playwright"));
  if (!existsSync(cache)) return undefined;
  const shells = readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const shell of shells) {
    for (const platform of readdirSync(path.join(cache, shell))) {
      const executable = path.join(cache, shell, platform,
        process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell");
      if (existsSync(executable)) return executable;
    }
  }
  return undefined;
}

const browserPath = [
  process.env.CHROME,
  playwrightChromium(),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((candidate) => candidate && existsSync(candidate));
if (!browserPath) throw new Error("No Chromium-based browser found; set CHROME.");

const wanted = process.argv.slice(2);
const locales = wanted.length ? wanted : LOCALES;
for (const locale of locales) {
  if (!LOCALES.includes(locale)) throw new Error(`Unknown locale: ${locale}`);
}

/** A minimal Chrome DevTools Protocol client over the browser's WebSocket. */
class DevTools {
  #socket;
  #next = 1;
  #pending = new Map();

  static async connect(url) {
    const client = new DevTools();
    client.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", reject, { once: true });
    });
    client.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiting = message.id && client.#pending.get(message.id);
      if (!waiting) return;
      client.#pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message));
      else waiting.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}, sessionId) {
    const id = this.#next++;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  close() {
    this.#socket.close();
  }
}

function launchBrowser(profile) {
  const child = spawn(browserPath, [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("The browser did not start.")), 30_000);
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on("exit", () => reject(new Error(`The browser exited:\n${output}`)));
  });
  return { child, endpoint };
}

async function capture(devtools, url, output) {
  const { targetId } = await devtools.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await devtools.send("Target.attachToTarget", { targetId, flatten: true });
  try {
    await devtools.send("Emulation.setDeviceMetricsOverride",
      { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, sessionId);
    await devtools.send("Page.enable", {}, sessionId);
    await devtools.send("Page.navigate", { url }, sessionId);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { result } = await devtools.send("Runtime.evaluate",
        { expression: `Boolean(${READY})`, returnByValue: true }, sessionId);
      if (result.value) break;
      if (Date.now() > deadline) throw new Error(`The sample page never finished rendering: ${url}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Let layout settle after the last font swap.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { data } = await devtools.send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(output, Buffer.from(data, "base64"));
  } finally {
    await devtools.send("Target.closeTarget", { targetId });
  }
}

const workDir = mkdtempSync(path.join(tmpdir(), "latticeterm-screenshots-"));
const config = {
  root: path.join(root, "scripts/product-screenshots"),
  publicDir: path.join(root, "public"),
  configFile: false,
  logLevel: "error",
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify("preview") },
  resolve: {
    alias: { vitest: path.join(root, "scripts/product-screenshots/vitest-shim.ts") },
  },
  build: { outDir: path.join(workDir, "site"), emptyOutDir: true, chunkSizeWarningLimit: 10_000 },
  preview: { port: 0, strictPort: false },
};
let browser;
let server;
try {
  await build(config);
  server = await preview(config);
  const { port } = server.httpServer.address();
  browser = launchBrowser(path.join(workDir, "profile"));
  const devtools = await DevTools.connect(await browser.endpoint);
  try {
    for (const locale of locales) {
      const output = path.join(root, "docs/assets", `chat-workspace.${locale}.png`);
      await capture(devtools, `http://localhost:${port}/?locale=${encodeURIComponent(locale)}${process.env.SCREENSHOT_THREAD ? `&thread=${encodeURIComponent(process.env.SCREENSHOT_THREAD)}` : ""}`, output);
      console.log(`${locale}: ${path.relative(root, output)} (${statSync(output).size} bytes)`);
    }
  } finally {
    devtools.close();
  }
} finally {
  browser?.child.kill();
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  // The browser may hold its profile a moment after being stopped.
  await new Promise((resolve) => setTimeout(resolve, 500));
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

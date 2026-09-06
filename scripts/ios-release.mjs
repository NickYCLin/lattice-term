import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apple = join(root, "src-tauri/gen/apple");

export function releaseConfig(version, buildNumber) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("App Store 版本必須是三段數字的正式版本，不能含 prerelease 標籤。");
  }
  // Apple's CFBundleVersion format: up to 4 digits, then two 2-digit parts.
  // Keep builds independent of the marketing version to allow resubmission.
  if (!/^[1-9]\d{0,3}(?:\.(?:0|[1-9]\d?)){0,2}$/.test(buildNumber ?? "")) {
    throw new Error("請指定 --build-number（例如 1、2 或 100.1；最多 9999.99.99），每次上傳必須遞增。");
  }
  return { version, bundle: { iOS: { bundleVersion: buildNumber } } };
}

export function releaseArguments(configPath) {
  return [
    "run", "tauri", "--", "ios", "build", "--ci", "--target", "aarch64",
    "--export-method", "app-store-connect", "--config", configPath,
  ];
}

export function unsignedDeviceArguments(configPath) {
  return ["run", "tauri", "--", "ios", "build", "--ci", "--target", "aarch64", "--no-sign", "--archive-only", "--config", configPath];
}

export function simulatorArguments(configPath, architecture, release = false) {
  const target = { arm64: "aarch64-sim", x64: "x86_64" }[architecture];
  if (!target) throw new Error(`不支援的模擬器主機架構：${architecture}`);
  return ["run", "tauri", "--", "ios", "build", ...(release ? [] : ["--debug"]), "--ci", "--target", target, "--no-sign", "--config", configPath];
}

export function preserveSimulatorOutput(appleDirectory, architecture) {
  const target = { arm64: "arm64-sim", x64: "x86_64" }[architecture];
  if (!target) throw new Error(`不支援的模擬器主機架構：${architecture}`);
  const build = join(appleDirectory, "build");
  const output = join(build, target);
  const app = join(output, "LatticeTerm.app");
  const staging = join(appleDirectory, ".release");
  // Tauri renames the completed simulator app into this directory. POSIX
  // rename cannot replace an existing non-empty app from a previous build.
  // Preserve the old bundle atomically; never recursively remove artifacts.
  for (const path of [build, output, app, staging]) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error(`Simulator 產物路徑必須是一般目錄，不能使用符號連結：${path}`);
    }
  }
  if (!lstatSync(app, { throwIfNoEntry: false })) return undefined;
  mkdirSync(staging, { recursive: true });
  const previous = join(mkdtempSync(join(staging, `previous-${target}-`)), "LatticeTerm.app");
  renameSync(app, previous);
  return previous;
}

export function simulatorXcodebuildScript(executable, architecture = process.arch) {
  const nativeArch = { arm64: "arm64", x64: "x86_64" }[architecture];
  if (!nativeArch) throw new Error(`不支援的模擬器主機架構：${architecture}`);
  // Pass arguments as an array to the real tool; never reinterpret paths as
  // shell code. Replace existing options too, since Xcode rejects two -sdk's.
  return `#!/usr/bin/env python3
import os
import sys
executable = ${JSON.stringify(executable)}
args = sys.argv[1:]
if any(arg in ("archive", "build") for arg in args):
    normalized = []
    index = 0
    while index < len(args):
        if args[index] in ("-sdk", "-destination", "-arch"):
            index += 2
        elif args[index].startswith("ARCHS="):
            index += 1
        else:
            normalized.append(args[index])
            index += 1
    args = normalized + ["-sdk", "iphonesimulator", "-destination", "generic/platform=iOS Simulator", "ARCHS=${nativeArch}"]
os.execv(executable, [executable] + args)
`;
}

export function apiSigningProblems({ key, issuer, path }) {
  const problems = [];
  if (!/^[A-Z0-9]{10}$/.test(key ?? "")) problems.push("APPLE_API_KEY 必須是 10 碼 Key ID。");
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(issuer ?? "")) problems.push("APPLE_API_ISSUER 必須是 Issuer ID 的 UUID。");
  try {
    const privateKey = createPrivateKey(readFileSync(path));
    if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("Invalid key");
  } catch {
    // Never include file contents or crypto errors in CI output.
    problems.push("APPLE_API_KEY_PATH 必須指向可讀取的 App Store Connect P-256 私密金鑰。");
  }
  return problems;
}

export function manualSigningProblems({ certificate, password, profile }) {
  const problems = [];
  // Tauri parses PKCS#12 and CMS after this input check. Do not log secrets.
  const isBase64 = (value) => typeof value === "string" && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && Buffer.from(value, "base64").toString("base64") === value;
  if (!isBase64(certificate)) problems.push("IOS_CERTIFICATE 必須是 P12 憑證的完整 Base64。");
  if (typeof password !== "string") problems.push("請提供 IOS_CERTIFICATE_PASSWORD。");
  if (!isBase64(profile)) problems.push("IOS_MOBILE_PROVISION 必須是描述檔的完整 Base64。");
  return problems;
}

export function environmentProblems({ platform, xcode, sdk, team, identities, api, manual }) {
  const problems = [];
  if (platform !== "darwin") problems.push("iOS 封裝需要 macOS。");
  const xcodeMajor = Number(/^Xcode (\d+)/m.exec(xcode)?.[1]);
  if (!(xcodeMajor >= 26)) problems.push("App Store Connect 需要 Xcode 26 或更新版本。");
  const sdkMajor = Number(/^(\d+)\./.exec(sdk.trim())?.[1]);
  if (!(sdkMajor >= 26)) problems.push("App Store Connect 需要 iOS 26 SDK 或更新版本。");
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) {
    problems.push("請設定 APPLE_DEVELOPMENT_TEAM（付費 Developer Program 的 10 碼 Team ID）。");
  }
  if (manual) {
    problems.push(...manualSigningProblems(manual));
  } else if (api) {
    problems.push(...apiSigningProblems(api));
  } else if (!/"(?:Apple Development|Apple Distribution|iPhone Developer|iPhone Distribution):/.test(identities)) {
    problems.push("鑰匙圈中找不到可用的 Apple 開發或發行簽章憑證。");
  }
  return problems;
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return "";
  }
}

function preflight() {
  const apiValues = [process.env.APPLE_API_KEY, process.env.APPLE_API_ISSUER, process.env.APPLE_API_KEY_PATH];
  const manualValues = [process.env.IOS_CERTIFICATE, process.env.IOS_CERTIFICATE_PASSWORD, process.env.IOS_MOBILE_PROVISION];
  const problems = environmentProblems({
    platform: process.platform,
    xcode: commandOutput("xcodebuild", ["-version"]),
    sdk: commandOutput("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]),
    team: process.env.APPLE_DEVELOPMENT_TEAM,
    identities: commandOutput("security", ["find-identity", "-v", "-p", "codesigning"]),
    api: apiValues.some((value) => value !== undefined) ? { key: apiValues[0], issuer: apiValues[1], path: apiValues[2] } : undefined,
    manual: manualValues.some((value) => value !== undefined) ? { certificate: manualValues[0], password: manualValues[1], profile: manualValues[2] } : undefined,
  });
  if (problems.length) throw new Error(problems.map((p) => `- ${p}`).join("\n"));
  console.log("工具與簽章輸入檢查通過；金鑰權限、會員資格、Bundle ID 與描述檔仍由 Apple 在封裝時驗證。");
}

export function synchronizeNativeVersions(project, plist, version, buildNumber = "1") {
  // Tauri updates Info.plist during a build. Keep the checked-in XcodeGen
  // definition in sync too, so regenerating the project cannot restore 0.34.0.
  const replaceRequired = (source, pattern, replacement) => {
    if (!pattern.test(source)) throw new Error("找不到 iOS 原生版本欄位，請檢查 Xcode 專案結構。");
    return source.replace(pattern, replacement);
  };
  project = replaceRequired(project, /CFBundleShortVersionString: [^\n]+/, `CFBundleShortVersionString: ${version}`);
  project = replaceRequired(project, /CFBundleVersion: [^\n]+/, `CFBundleVersion: "${buildNumber}"`);
  for (const [key, value] of [["CFBundleShortVersionString", version], ["CFBundleVersion", buildNumber]]) {
    plist = replaceRequired(plist, new RegExp(`(<key>${key}</key>\\s*<string>)[^<]+(</string>)`), (_match, start, end) => `${start}${value}${end}`);
  }
  return { project, plist };
}

function syncVersions(version) {
  const projectPath = join(apple, "project.yml");
  const plistPath = join(apple, "lattice-term_iOS/Info.plist");
  const ios = JSON.parse(readFileSync(join(root, "src-tauri/tauri.ios.conf.json"), "utf8"));
  const buildNumber = ios.bundle.iOS.bundleVersion;
  releaseConfig(version, buildNumber);
  const next = synchronizeNativeVersions(readFileSync(projectPath, "utf8"), readFileSync(plistPath, "utf8"), version, buildNumber);
  writeFileSync(projectPath, next.project);
  writeFileSync(plistPath, next.plist);
}

function main(args) {
  const [mode, ...options] = args;
  if (!["sync", "prepare", "preflight", "build", "simulator", "simulator-release", "device-unsigned"].includes(mode)) {
    throw new Error("用法：node scripts/ios-release.mjs sync | preflight | simulator | simulator-release | device-unsigned | prepare --build-number 1 | build --build-number 1");
  }
  const parsed = {};
  for (let i = 0; i < options.length; i += 2) {
    if (options[i] !== "--build-number" || !options[i + 1] || parsed.buildNumber) {
      throw new Error("只接受一次 --build-number 參數。");
    }
    parsed.buildNumber = options[i + 1];
  }
  if (mode === "preflight") return preflight();
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tauriVersion = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8")).version;
  if (version !== tauriVersion) throw new Error("package.json 與 Tauri 版本不一致，請先執行 npm run version:check。");
  if (mode === "sync") {
    syncVersions(version);
    console.log(`iOS 原生版本已同步為 ${version}。正式封裝時會另外套用指定的建置號。`);
    return;
  }
  const simulator = mode === "simulator" || mode === "simulator-release";
  const unsignedDevice = mode === "device-unsigned";
  if ((simulator || unsignedDevice) && process.platform !== "darwin") throw new Error("iOS 原生建置需要 macOS。");
  const buildNumber = parsed.buildNumber ?? (simulator || unsignedDevice ? "1" : undefined);
  const config = releaseConfig(version, buildNumber);
  if (mode === "build") preflight();
  if (simulator) {
    const previous = preserveSimulatorOutput(apple, process.arch);
    if (previous) console.log(`舊 Simulator App 已保留：${previous}（本次失敗時仍可從此位置取回）`);
  }
  syncVersions(version);
  const staging = join(apple, ".release");
  mkdirSync(staging, { recursive: true });
  const configPath = join(mkdtempSync(join(staging, "build-")), "tauri.conf.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  console.log(`已準備 ${version} (${buildNumber})：${configPath}`);
  if (mode === "prepare") return;
  // Export only: this command never uploads or submits the app for review.
  let childEnv = process.env;
  if (simulator) {
    // Tauri 2.11.4 drops XCODE_XCCONFIG_FILE from its Apple child environment
    // and can choose a device destination for a simulator archive. A process-local tool entry supplies those
    // arguments without changing Xcode, the native project or device builds.
    // Release otherwise builds every simulator architecture, while Tauri's
    // xcode-script emits libapp.a only for the host architecture.
    const executable = execFileSync("xcrun", ["--find", "xcodebuild"], { encoding: "utf8", timeout: 30_000 }).trim();
    if (!executable.startsWith("/")) throw new Error("找不到 Xcode 的 xcodebuild 絕對路徑。");
    const bin = join(dirname(configPath), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "xcodebuild"), simulatorXcodebuildScript(executable), { mode: 0o755, flag: "wx" });
    childEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
  }
  const buildArguments = simulator
    ? simulatorArguments(configPath, process.arch, mode === "simulator-release")
    : unsignedDevice ? unsignedDeviceArguments(configPath) : releaseArguments(configPath);
  const result = spawnSync("npm", buildArguments, {
    cwd: root, stdio: "inherit",
    env: childEnv,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`iOS 封裝失敗（${result.status ?? result.signal}）。`);
  console.log(simulator ? "Simulator App 已產生；請檢查 bundle 後安裝至模擬器。"
    : unsignedDevice ? "未簽章實機 archive 已產生，僅供 SDK 與產物檢查；不能直接安裝或上傳商店。"
    : "IPA 已匯出至 src-tauri/gen/apple/build/arm64；尚未上傳 App Store Connect。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

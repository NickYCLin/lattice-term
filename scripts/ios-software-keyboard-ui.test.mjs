import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const swift = readFileSync(new URL("./ios-layout-ui-tests/SoftwareKeyboardUITests.swift", import.meta.url), "utf8");
const project = readFileSync(new URL("./ios-layout-ui-tests/project.yml", import.meta.url), "utf8");
const smoke = readFileSync(new URL("./ios-simulator-smoke.py", import.meta.url), "utf8");
const runner = readFileSync(new URL("./run-ios-software-keyboard-tests.py", import.meta.url), "utf8");
const viewport = readFileSync(new URL("../src/app/useMobileViewport.ts", import.meta.url), "utf8");

describe("iOS 系統軟體鍵盤 XCUITest", () => {
  it("已加入 UI 測試目標，且既有 layout 互動仍只跑 LayoutUITests", () => {
    expect(project).toContain("SoftwareKeyboardUITests.swift");
    expect(project).toContain("LayoutUITests.swift");
    expect(smoke).toContain('-only-testing:LayoutUITests/LayoutUITests');
  });

  it("只點系統軟體鍵盤，不使用 typeText 或硬體鍵盤注入", () => {
    expect(swift).not.toMatch(/\.typeText\s*\(/);
    expect(swift).toContain("app.keyboards");
    expect(swift).toContain("Connect Hardware Keyboard");
    expect(swift).toContain("assertSoftwareKeyboardVisible");
    expect(runner).toContain("ConnectHardwareKeyboard");
    expect(runner).not.toMatch(/typeText\s*\(/);
  });

  it("覆蓋英文、數字符號、空白、刪除、換行、注音選字、首次開啟與鍵盤遮擋", () => {
    expect(swift).toContain("testSoftwareKeyboardAcceptance");
    expect(swift).toContain("assertFieldAboveKeyboard");
    expect(swift).toContain("fieldFrame.maxY");
    expect(swift).toContain("keyboardFrame.minY");
    expect(swift).toContain("intersection");
    expect(swift).toContain("keyboard-orientation-mismatch");
    expect(swift).toContain("isKeyboardCoordinateMismatchedWithApp");
    expect(swift).toContain("landscape");
    expect(swift).toContain("typeEnglishSymbolsOn");
    expect(swift).toContain("typeZhuyinOn");
    expect(swift).toContain("selectZhuyinCandidate");
    expect(swift).toContain("ㄏ");
    expect(swift).toContain("runConnectionForm");
    expect(swift).toContain("runSearchIfPresent");
    expect(swift).toContain("runQuickConnectIfPresent");
    expect(runner).toContain("zh_Hant-Hant@sw=Zhuyin");
    expect(swift).toContain("space");
    expect(swift).toContain("delete");
    expect(swift).toContain("Return");
  });

  it("鍵盤彈出時會把焦點輸入框捲到可視區，不只依賴 innerHeight 差", () => {
    expect(viewport).toContain("revealFocusedField");
    expect(viewport).toContain("restHeight");
    expect(viewport).toContain("scrollIntoView");
    expect(viewport).toContain("--app-viewport-width");
    expect(viewport).toContain("expected.width");
  });
});

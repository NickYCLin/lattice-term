import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../src-tauri/gen/apple/Sources/lattice-term/main.mm", import.meta.url), "utf8");
const listener = source.match(/evaluateJavaScript:@"(if\(!globalThis\.__latticeLayoutEvents[^\n]+)" completionHandler:nil/)[1];
let snapshot = source.match(/NSString \*script = @"([^\n]+)";/)[1];
for (const replacement of source.matchAll(/script stringByReplacingOccurrencesOfString:@"([^"]*)" withString:@"([^"]*)"/g)) {
  snapshot = snapshot.replaceAll(replacement[1], replacement[2]);
}

function fixture(hitMatches = true) {
  const handlers = {};
  const button = {
    tagName: "BUTTON",
    getAttribute: (name) => name === "class" ? "button button--primary" : null,
    closest: () => button,
    contains: (element) => element === button,
    getBoundingClientRect: () => ({ x: 482, y: 587, width: 155, height: 44 }),
  };
  const context = {
    innerWidth: 1376, innerHeight: 1032, devicePixelRatio: 2,
    screen: { width: 1376, height: 1032 }, visualViewport: null,
    getComputedStyle: () => ({ getPropertyValue: () => "1032px" }),
    document: {
      addEventListener: (kind, handler) => { handlers[kind] = handler; },
      elementFromPoint: (x, y) => hitMatches && x === 559.5 && y === 609 ? button : null,
      querySelector: () => button, querySelectorAll: () => [],
      activeElement: { tagName: "BODY" }, hasFocus: () => true,
      documentElement: { getAttribute: () => "false" },
    },
  };
  runInNewContext(listener, context);
  return { context, handlers, button };
}

describe("iOS 隔離觸點診斷", () => {
  it("保存實際觸點命中與取消事件，不把 pointerdown 當 click", () => {
    const { context, handlers, button } = fixture();
    for (const kind of ["pointerdown", "pointercancel", "touchcancel"]) {
      handlers[kind]({ target: button, clientX: 559.5, clientY: 609, isTrusted: true });
    }
    const events = context.__latticeLayoutEvents;
    expect(events.map((event) => event.kind)).toEqual(["pointerdown", "pointercancel", "touchcancel"]);
    expect(events[0]).toMatchObject({ x: 559.5, y: 609, hitTag: "BUTTON", hitButtonClass: "button button--primary" });
    expect(events.some((event) => event.kind === "click")).toBe(false);
    handlers.touchend({ target: button, changedTouches: [{ clientX: 559.5, clientY: 609 }] });
    expect(events.at(-1)).toMatchObject({ kind: "touchend", x: 559.5, y: 609 });
    expect(events.every((event) => !("value" in event) && !("text" in event))).toBe(true);
  });

  it.each([true, false])("用橫向 DOM 中心點獨立記錄實際命中：%s", (matches) => {
    const { context } = fixture(matches);
    const result = JSON.parse(runInNewContext(snapshot, context));
    const control = result.rects.find((rect) => rect.selector === ".connections--empty .button--primary");
    expect(control.center).toEqual({ x: 559.5, y: 609 });
    expect(control.centerHitsElement).toBe(matches);
    expect(result.innerWidth).toBe(1376);
  });

  it("保留有上限的事件序列，重複蒐證不重裝監聽器", () => {
    const { context, handlers, button } = fixture();
    const original = handlers.pointerup;
    runInNewContext(listener, context);
    expect(handlers.pointerup).toBe(original);
    for (let index = 0; index < 70; index += 1) {
      handlers.pointerup({ target: button, clientX: index, clientY: 609 });
    }
    expect(context.__latticeLayoutEvents).toHaveLength(64);
    expect(context.__latticeLayoutEvents[0].x).toBe(6);
    expect(context.__latticeLayoutEvents.at(-1).x).toBe(69);
  });
});

describe("XCUITest 觸控採證來源契約", () => {
  const swift = readFileSync(new URL("./ios-layout-ui-tests/LayoutUITests.swift", import.meta.url), "utf8");
  const evidence = swift.split("private func recordInput(")[1].split("private func tapCenter(")[0];
  const tap = swift.split("private func tapCenter(")[1].split("private func record(")[0];

  it("採證只接收已擷取值，不查詢可能在觸控後消失的控制項", () => {
    expect(evidence).toContain("beforeFrame: CGRect, beforeHittable: Bool");
    expect(evidence).not.toMatch(/XCUIElement|control\.|\.exists|\.isHittable/);
    expect(evidence).toContain('"beforeFrame":');
    expect(evidence).toContain('"beforeHittable": beforeHittable');
    expect(evidence).toContain("let window = app.frame");
    expect(evidence).toContain("XCUIScreen.main.screenshot()");
  });

  it("單次短按後只使用觸控前快照，不重新解參考原控制項", () => {
    const action = "control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)";
    expect(tap.split(action)).toHaveLength(2);
    const [before, after] = tap.split(action);
    expect(before).toContain("let beforeHittable = control.isHittable");
    expect(before).toContain("XCTAssertTrue(beforeHittable)");
    expect(before).toContain("let frame = control.frame");
    expect(before).toContain('recordInput("before", id: id, beforeFrame: frame, beforeHittable: beforeHittable)');
    expect(after).toContain('recordInput("after", id: id, beforeFrame: frame, beforeHittable: beforeHittable)');
    expect(after).not.toMatch(/\bcontrol\b/);
    expect(tap.match(/control\.frame/g)).toHaveLength(1);
  });
});

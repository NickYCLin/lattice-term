import XCTest

final class LayoutUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")

    private func recordInput(_ phase: String, id: String, beforeFrame: CGRect, beforeHittable: Bool) throws {
        let frame = beforeFrame
        let window = app.frame
        let observation: [String: Any] = [
            "id": id, "phase": phase, "at": Date().timeIntervalSince1970,
            "orientation": XCUIDevice.shared.orientation.rawValue,
            "beforeHittable": beforeHittable,
            "beforeFrame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
            "appFrame": ["x": window.minX, "y": window.minY, "width": window.width, "height": window.height]
        ]
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        print("LATTICE_LAYOUT_INPUT \(String(data: data, encoding: .utf8)!)")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "input-\(id)-\(phase)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private func tapCenter(_ control: XCUIElement) throws {
        let beforeHittable = control.isHittable
        XCTAssertTrue(beforeHittable)
        let id = UUID().uuidString
        let frame = control.frame
        try recordInput("before", id: id, beforeFrame: frame, beforeHittable: beforeHittable)
        print("LATTICE_LAYOUT_TAP x=\(frame.midX) y=\(frame.midY)")
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        try recordInput("after", id: id, beforeFrame: frame, beforeHittable: beforeHittable)
    }

    private func record(_ stage: String, controls: [XCUIElement] = []) throws {
        Thread.sleep(forTimeInterval: 8)
        let capturedAt = Date().timeIntervalSince1970
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "layout-\(stage)-\(capturedAt)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let keyboard = app.keyboards.firstMatch
        let frame = keyboard.exists ? keyboard.frame : .zero
        var observation: [String: Any] = [
            "stage": stage, "capturedAt": capturedAt,
            "captureFinishedAt": Date().timeIntervalSince1970,
            "keyboardVisible": keyboard.exists,
            "keyboardFrame": ["x": frame.minX, "y": frame.minY,
                              "width": frame.width, "height": frame.height],
            "controls": controls.map { control -> [String: Any] in
                XCTAssertTrue(control.isHittable)
                let rect = control.frame
                if keyboard.exists {
                    XCTAssertLessThanOrEqual(rect.maxY, frame.minY + 1)
                }
                return ["hittable": control.isHittable,
                        "frame": ["x": rect.minX, "y": rect.minY,
                                  "width": rect.width, "height": rect.height]]
            }
        ]
        Thread.sleep(forTimeInterval: 6)
        observation["captureStableUntil"] = Date().timeIntervalSince1970
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        print("LATTICE_LAYOUT_STAGE \(String(data: data, encoding: .utf8)!)")
    }

    func testKeyboardAndRotation() throws {
        continueAfterFailure = false
        addTeardownBlock {
            let hierarchy = XCTAttachment(string: self.app.debugDescription)
            hierarchy.name = "final-input-hierarchy"
            hierarchy.lifetime = .keepAlways
            self.add(hierarchy)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "final-input-screen"
            screenshot.lifetime = .keepAlways
            self.add(screenshot)
        }
        XCUIDevice.shared.orientation = .portrait
        app.activate()
        let add = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Add connection", "新增連線")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30))
        try tapCenter(add)
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR placeholderValue == %@", "For example: Production gateway", "例如：正式站主機")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertTrue(field.isHittable)
        try tapCenter(field)
        let focused = XCTAttachment(string: app.debugDescription)
        focused.name = "keyboard-focus-hierarchy"
        focused.lifetime = .keepAlways
        self.add(focused)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 15))
        XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 100)
        let tutorial = app.buttons["Continue"]
        if tutorial.waitForExistence(timeout: 3) {
            try tapCenter(tutorial)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: tutorial)], timeout: 5), .completed, "系統鍵盤教學未關閉")
            try tapCenter(field)
        }
        field.typeText("Layout check")
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "Layout check"), object: field)], timeout: 10), .completed)
        let close = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Close", "關閉")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        try record("keyboard-open", controls: [field, close])
        try tapCenter(close)
        let discard = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Discard changes", "放棄修改")).firstMatch
        XCTAssertTrue(discard.waitForExistence(timeout: 10))
        try tapCenter(discard)
        XCTAssertTrue(NSPredicate(format: "exists == false").evaluate(with: app.keyboards.firstMatch)
            || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 15) == .completed)
        try record("keyboard-closed", controls: [add])
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2)
        try record("landscape", controls: [add])
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        XCUIDevice.shared.orientation = .portrait
        try record("portrait-return", controls: [add])
        XCTAssertGreaterThan(app.frame.height, app.frame.width)
        XCTAssertTrue(add.exists)
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2)
        try tapCenter(add)
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        let landscapeForm = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        landscapeForm.name = "landscape-add-form"
        landscapeForm.lifetime = .keepAlways
        self.add(landscapeForm)
        try tapCenter(close)
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: field)], timeout: 10), .completed)
        XCUIDevice.shared.orientation = .portrait
    }
}

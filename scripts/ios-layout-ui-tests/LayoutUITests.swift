import XCTest

final class LayoutUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")

    private func tapCenter(_ control: XCUIElement) {
        XCTAssertTrue(control.isHittable)
        let frame = control.frame
        print("LATTICE_LAYOUT_TAP x=\(frame.midX) y=\(frame.midY)")
        control.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
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
        let observation: [String: Any] = [
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
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        print("LATTICE_LAYOUT_STAGE \(String(data: data, encoding: .utf8)!)")
        Thread.sleep(forTimeInterval: 6)
    }

    func testKeyboardAndRotation() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.activate()
        let add = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Add connection", "新增連線")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30))
        tapCenter(add)
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR placeholderValue == %@", "For example: Production gateway", "例如：正式站主機")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        XCTAssertTrue(field.isHittable)
        tapCenter(field)
        let focused = XCTAttachment(string: app.debugDescription)
        focused.name = "keyboard-focus-hierarchy"
        focused.lifetime = .keepAlways
        self.add(focused)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 15))
        XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 100)
        let tutorial = app.buttons["Continue"]
        if tutorial.waitForExistence(timeout: 3) {
            tapCenter(tutorial)
            tapCenter(field)
        }
        field.typeText("Layout check")
        XCTAssertEqual(field.value as? String, "Layout check")
        let close = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Close", "關閉")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        try record("keyboard-open", controls: [field, close])
        tapCenter(close)
        XCTAssertTrue(NSPredicate(format: "exists == false").evaluate(with: app.keyboards.firstMatch)
            || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 15) == .completed)
        try record("keyboard-closed", controls: [add])
        XCUIDevice.shared.orientation = .landscapeLeft
        try record("landscape", controls: [add])
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        XCUIDevice.shared.orientation = .portrait
        try record("portrait-return", controls: [add])
        XCTAssertGreaterThan(app.frame.height, app.frame.width)
        XCTAssertTrue(add.exists)
    }
}

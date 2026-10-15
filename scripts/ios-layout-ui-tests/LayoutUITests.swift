import XCTest

final class LayoutUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")

    private func record(_ stage: String) throws {
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
            "keyboardVisible": keyboard.exists,
            "keyboardFrame": ["x": frame.minX, "y": frame.minY,
                              "width": frame.width, "height": frame.height]
        ]
        let data = try JSONSerialization.data(withJSONObject: observation, options: [.sortedKeys])
        print("LATTICE_LAYOUT_STAGE \(String(data: data, encoding: .utf8)!)")
    }

    func testKeyboardAndRotation() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.activate()
        let add = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Add connection", "新增連線")).firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30))
        add.tap()
        let field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR placeholderValue == %@", "For example: Production gateway", "例如：正式站主機")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 15))
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 15))
        XCTAssertGreaterThan(app.keyboards.firstMatch.frame.height, 100)
        try record("keyboard-open")
        let close = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Close", "關閉")).firstMatch
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        close.tap()
        XCTAssertTrue(NSPredicate(format: "exists == false").evaluate(with: app.keyboards.firstMatch)
            || XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)], timeout: 15) == .completed)
        try record("keyboard-closed")
        XCUIDevice.shared.orientation = .landscapeLeft
        try record("landscape")
        XCTAssertGreaterThan(app.frame.width, app.frame.height)
        XCUIDevice.shared.orientation = .portrait
        try record("portrait-return")
        XCTAssertGreaterThan(app.frame.height, app.frame.width)
        XCTAssertTrue(add.exists)
    }
}

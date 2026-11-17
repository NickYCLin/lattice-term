import XCTest

/// Saved connection profiles must come back after a force-quit on device.
final class ConnectionPersistenceUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")
    private let profileName = "PersistCheck"
    private let hostValue = "persist.example.test"

    private func attachScreen(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    private func button(_ labels: String...) -> XCUIElement {
        var predicates: [NSPredicate] = []
        for label in labels {
            predicates.append(NSPredicate(format: "label == %@", label))
        }
        return app.buttons.matching(NSCompoundPredicate(orPredicateWithSubpredicates: predicates)).firstMatch
    }

    private func waitFor(_ element: XCUIElement, timeout: TimeInterval = 20) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "missing \(element)")
    }


    private func launchFresh() {
        if app.state != .notRunning {
            app.terminate()
        }
        XCUIDevice.shared.orientation = .portrait
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "App 未能進入前景")
        // Leftover drawers from a previous run hide 新增連線.
        let close = button("關閉", "Close", "取消", "Cancel")
        if close.waitForExistence(timeout: 2) { close.tap() }
        let discard = button("放棄修改", "Discard changes", "放棄", "Discard")
        if discard.waitForExistence(timeout: 2) { discard.tap() }
        let connections = button("我的連線", "My connections")
        if connections.waitForExistence(timeout: 5) {
            connections.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.6)
        }
    }

    private func revealAndTap(_ element: XCUIElement) {
        waitFor(element, timeout: 15)
        if element.isHittable {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            return
        }
        // Nudge the drawer body upward so a field or footer button is not
        // sitting under the sticky footer or the software keyboard.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.62))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.32))
        for _ in 0..<5 {
            start.press(forDuration: 0.05, thenDragTo: end)
            Thread.sleep(forTimeInterval: 0.3)
            if element.isHittable { break }
        }
        XCTAssertTrue(element.isHittable, "could not reveal \(element)")
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    }

    private func dismissKeyboard() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        for label in ["完成", "Done", "Return", "return", "Go"] {
            let key = keyboard.buttons[label]
            if key.exists && key.isHittable {
                key.tap()
                break
            }
        }
        if keyboard.exists {
            // Drag the form up-and-away; a keyboard still covering the footer
            // would otherwise intercept the Save tap.
            app.swipeDown()
            Thread.sleep(forTimeInterval: 0.4)
        }
    }

    private func typeInto(placeholder: String, alt: String? = nil, text: String) {
        var field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
        if !field.waitForExistence(timeout: 8), let alt = alt {
            field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", alt)).firstMatch
        }
        if !field.waitForExistence(timeout: 4) {
            // Some fields use the visible label as the accessibility name.
            field = app.textFields.matching(NSPredicate(format: "label == %@ OR placeholderValue == %@", placeholder, placeholder)).firstMatch
        }
        revealAndTap(field)
        let focused = NSPredicate(format: "hasKeyboardFocus == true")
        if XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: focused, object: field)], timeout: 3) != .completed {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: focused, object: field)], timeout: 5)
        }
        if let current = field.value as? String, !current.isEmpty, current != placeholder {
            let delete = String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)
            field.typeText(delete)
        }
        field.typeText(text)
        dismissKeyboard()
    }

    private func deleteProfileIfPresent() {
        let more = button("\(profileName)的更多操作", "More actions for \(profileName)")
        if !more.waitForExistence(timeout: 3) { return }
        revealAndTap(more)
        let del = button("刪除", "Delete")
        waitFor(del, timeout: 8)
        del.tap()
        let confirms = [
            "刪除「\(profileName)」",
            "刪除整張卡片",
            "Delete “\(profileName)”",
            "Delete the whole card",
            "刪除",
            "Delete",
        ]
        for label in confirms {
            let confirm = app.buttons[label]
            if confirm.waitForExistence(timeout: 2) {
                confirm.tap()
                break
            }
        }
        let gone = NSPredicate(format: "exists == false")
        _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: gone, object: more)], timeout: 8)
    }

    func testSavedConnectionSurvivesForceQuit() throws {
        continueAfterFailure = false
        launchFresh()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        deleteProfileIfPresent()

        revealAndTap(button("新增連線", "Add connection"))
        typeInto(placeholder: "例如：正式站主機", alt: "For example: Production gateway", text: profileName)
        typeInto(placeholder: "ssh.example.com", text: hostValue)
        typeInto(placeholder: "例如：operator", alt: "For example: operator", text: "tester")
        dismissKeyboard()

        let save = button("儲存", "Save")
        revealAndTap(save)
        // Saving a valid profile closes the drawer. Do not connect.
        waitFor(button("新增連線", "Add connection"), timeout: 20)
        let saved = app.staticTexts.matching(NSPredicate(format: "label == %@", profileName)).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 15), "saved profile did not appear in 我的連線")
        attachScreen("persist-before-kill")

        app.terminate()
        XCTAssertEqual(app.state, .notRunning, "app did not terminate")
        Thread.sleep(forTimeInterval: 2)
        app.activate()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        let restored = app.staticTexts.matching(NSPredicate(format: "label == %@", profileName)).firstMatch
        attachScreen("persist-after-relaunch")
        XCTAssertTrue(restored.waitForExistence(timeout: 15), "saved profile was missing after force-quit")

        deleteProfileIfPresent()
        attachScreen("persist-after-delete")
        XCTAssertFalse(restored.waitForExistence(timeout: 4), "test profile was not deleted")
    }
}

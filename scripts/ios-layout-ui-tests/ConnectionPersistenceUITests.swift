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

    /// WKWebView fields often report isHittable=false even when they are on screen.
    private func visiblyOnForm(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let rect = element.frame
        guard rect.width > 8, rect.height > 8 else { return false }
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists && keyboard.frame.height > 80 && rect.maxY > keyboard.frame.minY + 1 { return false }
        // Footer actions such as 儲存 sit near the bottom once the keyboard is gone.
        return rect.minY > 40 && rect.maxY <= app.frame.maxY - 2
    }

    private func revealAndTap(_ element: XCUIElement) {
        waitFor(element, timeout: 15)
        if visiblyOnForm(element) {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            return
        }
        // Drag from the left padding so we do not start a text selection.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.55))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.32))
        for _ in 0..<6 {
            start.press(forDuration: 0.05, thenDragTo: end)
            Thread.sleep(forTimeInterval: 0.3)
            if visiblyOnForm(element) { break }
        }
        XCTAssertTrue(visiblyOnForm(element), "could not reveal \(element) frame=\(NSCoder.string(for: element.frame))")
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    }

    private func dismissKeyboard() {
        let keyboard = app.keyboards.firstMatch
        guard keyboard.exists else { return }
        for label in ["完成", "Done", "return", "Return", "Go"] {
            let key = keyboard.buttons[label]
            if key.exists && key.isHittable {
                key.tap()
                Thread.sleep(forTimeInterval: 0.3)
                return
            }
            let toolbar = app.toolbars.buttons[label]
            if toolbar.exists {
                toolbar.tap()
                Thread.sleep(forTimeInterval: 0.3)
                return
            }
        }
        // Tap the drawer title to resign first responder without closing the sheet.
        let title = app.staticTexts["新增連線"]
        if title.exists {
            title.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.3)
        }
    }

    private func typeInto(label: String? = nil, placeholder: String, alt: String? = nil, text: String) {
        var field: XCUIElement
        if let label = label {
            field = app.textFields.matching(NSPredicate(format: "label == %@", label)).firstMatch
            if !field.waitForExistence(timeout: 8) {
                field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
            }
        } else {
            field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@", placeholder)).firstMatch
        }
        if !field.waitForExistence(timeout: 8), let alt = alt {
            field = app.textFields.matching(NSPredicate(format: "placeholderValue == %@ OR label == %@", alt, alt)).firstMatch
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
    }

    private func deleteProfileIfPresent() {
        // The card overflow control is exposed as Other, not Button.
        let predicates = [
            NSPredicate(format: "label == %@", "\(profileName)的更多操作"),
            NSPredicate(format: "label == %@", "More actions for \(profileName)"),
        ]
        let more = app.descendants(matching: .any).matching(NSCompoundPredicate(orPredicateWithSubpredicates: predicates)).firstMatch
        if !more.waitForExistence(timeout: 3) { return }
        more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 0.6)
        // The portal menu exposes items as menuItems, not always buttons.
        let deletePredicates = [
            NSPredicate(format: "label == %@", "刪除"),
            NSPredicate(format: "label == %@", "Delete"),
            NSPredicate(format: "label == %@", "刪除「\(profileName)」"),
        ]
        let del = app.descendants(matching: .any).matching(NSCompoundPredicate(orPredicateWithSubpredicates: deletePredicates)).firstMatch
        if !del.waitForExistence(timeout: 4) {
            more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            _ = del.waitForExistence(timeout: 6)
        }
        XCTAssertTrue(del.exists, "更多選單裡找不到刪除")
        if del.isHittable { del.tap() } else {
            del.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        }
        let confirms = [
            "刪除整張卡片",
            "刪除這項連線方式",
            "刪除「\(profileName)」",
            "Delete the whole card",
            "Delete this connection method",
            "Delete “\(profileName)”",
            "刪除",
            "Delete",
        ]
        var confirm: XCUIElement?
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline && confirm == nil {
            for label in confirms {
                let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
                let item = matches.element(boundBy: max(0, matches.count - 1))
                if item.exists, item.frame.height > 8 {
                    confirm = item
                    break
                }
            }
            if confirm == nil { Thread.sleep(forTimeInterval: 0.3) }
        }
        XCTAssertNotNil(confirm, "找不到刪除確認按鈕")
        confirm?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 0.8)
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
        typeInto(label: "顯示名稱", placeholder: "例如：正式站主機", alt: "For example: Production gateway", text: profileName)
        typeInto(label: "主機位址", placeholder: "ssh.example.com", text: hostValue)
        dismissKeyboard()
        typeInto(label: "使用者名稱", placeholder: "例如：operator", alt: "For example: operator", text: "tester")
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
        app.launch()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        let restored = app.staticTexts.matching(NSPredicate(format: "label == %@", profileName)).firstMatch
        attachScreen("persist-after-relaunch")
        XCTAssertTrue(restored.waitForExistence(timeout: 15), "saved profile was missing after force-quit")

        deleteProfileIfPresent()
        attachScreen("persist-after-delete")
        XCTAssertFalse(restored.waitForExistence(timeout: 4), "test profile was not deleted")
    }

    /// Safety net so a failed run does not leave PersistCheck on the phone.
    func testCleanupPersistCheckIfPresent() throws {
        continueAfterFailure = false
        launchFresh()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        deleteProfileIfPresent()
        attachScreen("persist-cleanup")
        let leftover = app.staticTexts.matching(NSPredicate(format: "label == %@", profileName)).firstMatch
        XCTAssertFalse(leftover.waitForExistence(timeout: 3), "test profile was not deleted")
    }
}

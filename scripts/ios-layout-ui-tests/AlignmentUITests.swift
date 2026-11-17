import XCTest

/// Header and chrome alignment on the iOS workspace pages.
final class AlignmentUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")

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



    private func labeled(_ labels: [String], type: XCUIElement.ElementType) -> XCUIElement {
        var predicates: [NSPredicate] = []
        for label in labels {
            predicates.append(NSPredicate(format: "label == %@", label))
        }
        return app.descendants(matching: type).matching(NSCompoundPredicate(orPredicateWithSubpredicates: predicates)).firstMatch
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

    /// The heading and the sidebar toggle should share one vertical center line.
    private func assertHeaderCentered(title: String, stage: String) {
        // WKWebView exposes the sidebar glyph as Other, not Button.
        let toggle = labeled(["顯示側欄", "隱藏側欄", "Show sidebar", "Hide sidebar"], type: .any)
        waitFor(toggle)
        // The tab bar also uses some of the same labels; pick the heading-sized
        // static text whose vertical center is nearest the sidebar toggle.
        let matches = app.staticTexts.matching(NSPredicate(format: "label == %@", title))
        XCTAssertGreaterThan(matches.count, 0, "no text titled \(title)")
        var best: XCUIElement?
        var bestDelta = CGFloat.greatestFiniteMagnitude
        for i in 0..<matches.count {
            let item = matches.element(boundBy: i)
            guard item.exists else { continue }
            // Ignore tiny or off-screen copies, and the bottom tab label
            // which sits far below the header toggle.
            if item.frame.height < 8 { continue }
            if abs(item.frame.midY - toggle.frame.midY) > 80 { continue }
            let delta = abs(item.frame.midY - toggle.frame.midY)
            if delta < bestDelta {
                bestDelta = delta
                best = item
            }
        }
        XCTAssertNotNil(best, "could not pair heading \(title) with the sidebar toggle")
        attachScreen("align-\(stage)")
        XCTAssertLessThanOrEqual(bestDelta, 4, "\(stage): heading midY and sidebar toggle midY differ by \(bestDelta)")
        if let titleFrame = best?.frame {
            print("LATTICE_ALIGN stage=\(stage) title=\(titleFrame) toggle=\(toggle.frame) delta=\(bestDelta)")
        }
    }

    func testHeaderAlignmentAcrossPages() throws {
        continueAfterFailure = false
        launchFresh()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        assertHeaderCentered(title: "我的連線", stage: "connections")

        let pages: [(label: String, titles: [String], stage: String)] = [
            ("工作階段", ["工作階段", "Sessions"], "sessions"),
            ("遠端助理", ["遠端 Agent Fleet", "AI Agent Fleet", "遠端助理"], "remote"),
            ("設定", ["設定", "Settings"], "settings"),
        ]
        for page in pages {
            let tab = button(page.label)
            waitFor(tab)
            tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1)
            if page.stage == "sessions" {
                // Mobile hides the workspace view-header on the terminal page.
                Thread.sleep(forTimeInterval: 0.5)
                attachScreen("align-sessions")
                continue
            }
            var checked = false
            for heading in page.titles {
                let matches = app.staticTexts.matching(NSPredicate(format: "label == %@", heading))
                if matches.count > 0 {
                    assertHeaderCentered(title: heading, stage: page.stage)
                    checked = true
                    break
                }
            }
            if !checked {
                attachScreen("align-\(page.stage)")
                XCTFail("no heading found for \(page.stage)")
            }
        }

        let more = button("更多", "More")
        waitFor(more)
        more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 1)
        attachScreen("align-more")

        // Return to connections and open the add-connection form and the
        // connect-by-ID dialog so those headers can be visually checked.
        button("我的連線", "My connections").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 1)
        let add = button("新增連線", "Add connection")
        waitFor(add)
        add.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        let close = button("關閉", "Close")
        waitFor(close, timeout: 15)
        Thread.sleep(forTimeInterval: 1)
        attachScreen("align-add-connection")
        close.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        // A clean form closes without a discard sheet.
        Thread.sleep(forTimeInterval: 1)
        if button("放棄修改", "Discard changes").waitForExistence(timeout: 2) {
            button("放棄修改", "Discard changes").tap()
        }

        let byId = button("以 ID 連線", "Connect by ID")
        waitFor(byId)
        byId.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        waitFor(button("關閉", "Close"), timeout: 15)
        Thread.sleep(forTimeInterval: 1)
        attachScreen("align-connect-by-id")
        button("關閉", "Close").coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 1)
        XCUIDevice.shared.orientation = .portrait
    }
}

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


    private func sidebarToggleVisible() -> Bool {
        let toggle = labeled(["顯示側欄", "隱藏側欄", "Show sidebar", "Hide sidebar"], type: .any)
        return toggle.exists && toggle.frame.height > 8 && toggle.frame.minY < app.frame.midY
    }

    /// True when the element sits in the bottom tab rail, not a page row.
    private func isTabBarElement(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        return element.frame.minY > app.frame.maxY - 140
    }

    private func openSessionInnerIfPresent() {
        let tabLabels: Set<String> = ["工作階段", "Sessions", "我的連線", "My connections", "設定", "Settings", "更多", "More", "遠端助理", "遠端 Agent Fleet", "AI Agent Fleet", "Remote assistant"]
        let excluded: Set<String> = [
            "選擇檔案", "Choose file", "Choose File", "Browse", "瀏覽",
            "關閉", "Close", "新增", "Add", "取消", "Cancel",
            "新增連線", "Add connection", "以 ID 連線", "Connect by ID",
            "刪除", "Delete", "搜尋", "Search", "儲存", "Save",
            "顯示側欄", "隱藏側欄", "Show sidebar", "Hide sidebar",
        ]
        let cells = app.cells
        for i in 0..<min(cells.count, 8) {
            let cell = cells.element(boundBy: i)
            if cell.exists && cell.isHittable && !isTabBarElement(cell) && !excluded.contains(cell.label) {
                cell.tap()
                Thread.sleep(forTimeInterval: 1)
                attachScreen("align-session-inner")
                inspectCommandPaneIfVisible()
                return
            }
        }
        let buttons = app.buttons
        for i in 0..<min(buttons.count, 24) {
            let item = buttons.element(boundBy: i)
            guard item.exists && item.isHittable && !isTabBarElement(item) else { continue }
            let label = item.label
            if tabLabels.contains(label) || excluded.contains(label) { continue }
            if label.count < 2 { continue }
            item.tap()
            Thread.sleep(forTimeInterval: 1)
            attachScreen("align-session-inner")
            inspectCommandPaneIfVisible()
            return
        }
        attachScreen("align-session-inner-none")
        print("LATTICE_ALIGN no session inner page available to open")
    }

    /// Leave a terminal / session inner page so other workspace pages show their view-header.
    private func leaveTerminalView() {
        if sidebarToggleVisible() { return }
        // Prefer a page that always has the mobile view-header.
        let connections = button("我的連線", "My connections")
        if connections.waitForExistence(timeout: 3) && connections.isHittable {
            connections.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.8)
            if sidebarToggleVisible() { return }
        }
        for label in ["返回", "Back", "關閉", "Close"] {
            let item = button(label)
            if item.exists && item.isHittable && !isTabBarElement(item) && item.frame.minY < app.frame.midY {
                item.tap()
                Thread.sleep(forTimeInterval: 0.6)
                if sidebarToggleVisible() { return }
            }
        }
        // Last resort: tap the sessions tab only after visiting connections,
        // then connections again so later stages start from a headed page.
        let sessions = button("工作階段", "Sessions")
        if sessions.exists && sessions.isHittable {
            sessions.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.6)
        }
        if connections.exists && connections.isHittable {
            connections.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.8)
        }
        attachScreen("align-leave-terminal")
        XCTAssertTrue(sidebarToggleVisible(), "離開工作階段內頁後仍看不到側欄按鈕，後續頁面的標題對齊無法檢查")
    }

    /// When a connected remote session already has the 命令 pane, confirm the
    /// run button is not covered by the tab bar. Skip quietly if not connected.
    private func inspectCommandPaneIfVisible() {
        let commandTab = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ OR label == %@", "命令", "Commands")).firstMatch
        guard commandTab.exists && commandTab.isHittable && !isTabBarElement(commandTab) else { return }
        commandTab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
        Thread.sleep(forTimeInterval: 0.8)
        let run = button("執行", "Run")
        attachScreen("align-command-pane")
        if run.waitForExistence(timeout: 3) {
            let railTop = app.frame.maxY - 140
            let visible = run.exists && run.frame.maxY <= railTop + 8 && run.frame.height > 8
            print("LATTICE_ALIGN command-run frame=\(NSCoder.string(for: run.frame)) railTop=\(railTop) visible=\(visible)")
            XCTAssertTrue(visible || run.isHittable, "命令頁「執行」被底部分頁列擋住。frame=\(NSCoder.string(for: run.frame))")
        }
    }

    func testHeaderAlignmentAcrossPages() throws {
        continueAfterFailure = false
        launchFresh()
        waitFor(button("新增連線", "Add connection"), timeout: 30)
        Thread.sleep(forTimeInterval: 1)
        assertHeaderCentered(title: "我的連線", stage: "connections")

        let pages: [(labels: [String], titles: [String], stage: String)] = [
            (["工作階段", "Sessions"], ["工作階段", "Sessions"], "sessions"),
            (["遠端助理", "遠端 Agent Fleet", "AI Agent Fleet", "Remote assistant"], ["遠端 Agent Fleet", "AI Agent Fleet", "遠端助理"], "remote"),
            (["設定", "Settings"], ["設定", "Settings"], "settings"),
        ]
        for page in pages {
            let tab = button(page.labels[0], page.labels[1], page.labels.count > 2 ? page.labels[2] : page.labels[0], page.labels.count > 3 ? page.labels[3] : page.labels[0])
            waitFor(tab)
            tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1)
            if page.stage == "sessions" {
                // Mobile hides the workspace view-header on the terminal page.
                Thread.sleep(forTimeInterval: 0.5)
                attachScreen("align-sessions")
                openSessionInnerIfPresent()
                // Always leave the terminal / session inner page before later
                // tabs. Otherwise the missing view-header makes the sidebar
                // toggle invisible and settings / more / command checks never run.
                leaveTerminalView()
                continue
            }
            // If a previous session page is still covering the workspace header,
            // leave it and re-tap this tab before asserting alignment.
            if !sidebarToggleVisible() {
                inspectCommandPaneIfVisible()
                leaveTerminalView()
                tab.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
                Thread.sleep(forTimeInterval: 1)
            }
            // A connected remote session may open a header-less workspace.
            // Do not block settings / more because of that; record and continue.
            if !sidebarToggleVisible() {
                inspectCommandPaneIfVisible()
                attachScreen("align-\(page.stage)-no-header")
                print("LATTICE_ALIGN skip \(page.stage): no view-header after opening the page")
                leaveTerminalView()
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

        // Always return to 我的連線 before checking 更多 / forms. A connected
        // remote session can hide the view-header and the 更多 tab.
        leaveTerminalView()
        waitFor(button("新增連線", "Add connection"), timeout: 15)
        let settings = button("設定", "Settings")
        if settings.waitForExistence(timeout: 3) && settings.isHittable {
            settings.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1)
            if sidebarToggleVisible() {
                assertHeaderCentered(title: "設定", stage: "settings")
            } else {
                attachScreen("align-settings-no-header")
                print("LATTICE_ALIGN settings still has no view-header")
            }
            leaveTerminalView()
            waitFor(button("新增連線", "Add connection"), timeout: 10)
        }
        let more = button("更多", "More")
        if more.waitForExistence(timeout: 5) && more.isHittable {
            more.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1)
            attachScreen("align-more")
            inspectCommandPaneIfVisible()
            leaveTerminalView()
        } else {
            attachScreen("align-more-missing")
            print("LATTICE_ALIGN more tab not visible from the connections page")
        }

        // Open the add-connection form and the connect-by-ID dialog so those
        // headers can be visually checked.
        waitFor(button("新增連線", "Add connection"), timeout: 15)
        let add = button("新增連線", "Add connection")
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

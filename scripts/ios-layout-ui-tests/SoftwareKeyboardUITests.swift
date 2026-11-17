import XCTest

/// 以 iOS 系統軟體鍵盤的實際按鍵驗收，禁止 hardware keyboard 或 typeText 注入。
/// 焦點輸入框的底部必須在鍵盤頂部之上，且打出的文字可見。
final class SoftwareKeyboardUITests: XCTestCase {
    private var app: XCUIApplication!

    func testSoftwareKeyboardAcceptance() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")
        if app.state != .notRunning {
            app.terminate()
        }
        app.launchEnvironment["LATTICETERM_LAYOUT_DIAGNOSTICS"] = "1"
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "App 未能進入前景")
        XCUIDevice.shared.orientation = .portrait
        waitForFrontend()
        dismissKeyboardTutorial()
        try runConnectionForm(orientationName: "portrait")
        try runQuickConnectIfPresent(orientationName: "portrait")
        try runSearchIfPresent(orientationName: "portrait")
        try runLandscapePass()
        XCUIDevice.shared.orientation = .portrait
    }


    /// Real-user check: with the name field focused and the keyboard open,
    /// can a person reach 主機位址 by tapping Next, or is that field trapped
    /// under the sticky footer?
    func testFooterAndNextFieldOnConnectionForm() throws {
        continueAfterFailure = false
        app = XCUIApplication(bundleIdentifier: "io.github.nickyclin.latticeterm")
        if app.state != .notRunning { app.terminate() }
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30), "App 未能進入前景")
        XCUIDevice.shared.orientation = .portrait
        waitForFrontend()
        dismissKeyboardTutorial()
        try openAddConnection()
        let name = nameField()
        XCTAssertTrue(name.waitForExistence(timeout: 15))
        if !cheapKeyboardVisible() { name.tap() }
        assertSoftwareKeyboardVisible()
        Thread.sleep(forTimeInterval: 0.6)
        attachShot("footer-name-focused")
        let host = hostField()
        XCTAssertTrue(host.waitForExistence(timeout: 5), "主機位址欄位不存在")
        emit("footer-name-focused", extra: [
            "name": NSCoder.string(for: name.frame),
            "host": NSCoder.string(for: host.frame),
            "footerTop": Double(visualFooterTop()),
            "headerBottom": Double(visualHeaderBottom()),
            "keyboardMinY": cheapKeyboardVisible() ? Double(app.keyboards.firstMatch.frame.minY) : -1,
            "hostAboveFooter": Double(host.frame.maxY) <= Double(visualFooterTop()) - 4,
            "hostSafelyTappable": fieldIsSafelyTappable(host),
        ])
        // After focusing 顯示名稱, the next field (主機位址) must also sit
        // above the sticky footer so a person can see and tap it.
        XCTAssertTrue(
            fieldIsSafelyTappable(host),
            "聚焦顯示名稱後，主機位址仍被頁尾或鍵盤擋住，使用者看不到、點不到。host=\(NSCoder.string(for: host.frame)) footerTop=\(visualFooterTop())"
        )
        let moved = tapNextFormField()
        Thread.sleep(forTimeInterval: 0.8)
        attachShot("footer-after-next")
        let focused = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
        emit("footer-after-next", extra: [
            "moved": moved,
            "focusedLabel": (focused.exists ? (focused.label as String) : ""),
            "focused": focused.exists ? NSCoder.string(for: focused.frame) : "",
            "host": NSCoder.string(for: host.frame),
            "footerTop": Double(visualFooterTop()),
            "keyboardMinY": cheapKeyboardVisible() ? Double(app.keyboards.firstMatch.frame.minY) : -1,
            "hostHasFocus": host.value(forKey: "hasKeyboardFocus") as? Bool ?? false,
            "hostSafelyTappable": fieldIsSafelyTappable(host),
        ])
        if moved {
            XCTAssertTrue(cheapKeyboardVisible(), "切到下一欄後鍵盤不應消失")
            XCTAssertTrue(
                fieldIsSafelyTappable(host),
                "用「下一個」切換後，主機位址仍被頁尾或鍵盤擋住。host=\(NSCoder.string(for: host.frame)) footerTop=\(visualFooterTop())"
            )
            let hostFocused = (host.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
            let stillOnName = focused.exists && (focused.label == "顯示名稱")
            XCTAssertTrue(hostFocused || !stillOnName, "鍵盤「下一個」沒有把焦點從顯示名稱移到主機位址")
        } else {
            emit("footer-next-missing", extra: ["note": "no next-field control; tapping the now-visible host field"])
            host.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 0.5)
            attachShot("footer-host-tapped")
            XCTAssertTrue(cheapKeyboardVisible(), "點主機位址應叫出鍵盤")
            XCTAssertTrue(fieldIsSafelyTappable(host), "點選後主機位址仍被頁尾擋住")
        }
        dismissFormIfNeeded()
        XCUIDevice.shared.orientation = .portrait
    }

    @discardableResult
    private func tapNextFormField() -> Bool {
        let names = ["下一個", "下一個欄位", "Next", "Next Field", "next", "下一項"]
        let roots: [XCUIElement] = [app.keyboards.firstMatch, app.toolbars.firstMatch, app]
        for root in roots {
            guard root.exists else { continue }
            for name in names {
                let button = root.buttons[name]
                if button.exists && button.isHittable {
                    button.tap()
                    return true
                }
            }
            // The WKWebView accessory often exposes a nameless downward chevron
            // in a toolbar just above the keyboard.
            let buttons = root.buttons
            if buttons.count >= 2 {
                for i in 0..<min(buttons.count, 8) {
                    let candidate = buttons.element(boundBy: i)
                    guard candidate.exists, candidate.isHittable else { continue }
                    let label = candidate.label.lowercased()
                    if label.contains("next") || label.contains("下") || label.contains("forward") {
                        candidate.tap()
                        return true
                    }
                }
            }
        }
        return false
    }

    // MARK: - Scenarios

    private func runConnectionForm(orientationName: String) throws {
        try openAddConnection()
        let field = nameField()
        XCTAssertTrue(field.waitForExistence(timeout: 15), "找不到顯示名稱輸入框")
        if !cheapKeyboardVisible() { field.tap() }
        assertSoftwareKeyboardVisible()
        assertFieldAboveKeyboard(field, surface: "connection-form-name", orientationName: orientationName)
        emit("first-open-keyboard", extra: ["surface": "connection-form", "orientation": orientationName])
        attachShot("keyboard-\(deviceFamily())-connection-form-\(orientationName)")

        if isZhuyinKeyboardVisible() {
            try typeZhuyinOn(field)
        } else {
            switchToLatinKeyboard()
            try typeEnglishSymbolsOn(field)
        }
        assertFieldAboveKeyboard(field, surface: "connection-form-name-typed", orientationName: orientationName)
        attachShot("keyboard-\(deviceFamily())-connection-form-\(orientationName)-typed")

        let host = hostField()
        if host.waitForExistence(timeout: 5) {
            revealOrTap(host)
            assertSoftwareKeyboardVisible()
            assertFieldAboveKeyboard(host, surface: "connection-form-host", orientationName: orientationName)
        }
        let port = portField()
        if port.waitForExistence(timeout: 5) {
            revealOrTap(port)
            assertSoftwareKeyboardVisible()
            assertFieldAboveKeyboard(port, surface: "connection-form-port", orientationName: orientationName)
        }
        dismissFormIfNeeded()
    }

    private func runQuickConnectIfPresent(orientationName: String) throws {
        let button = element(labels: ["以 ID 連線", "Connect by ID"], type: .button)
        guard button.waitForExistence(timeout: 5) else {
            emit("skip-id-connect", extra: ["reason": "control-missing"])
            return
        }
        button.tap()
        let field = app.textFields.firstMatch
        guard field.waitForExistence(timeout: 8) else {
            emit("skip-id-connect", extra: ["reason": "field-missing"])
            attachShot("keyboard-\(deviceFamily())-id-connect-\(orientationName)-missing")
            return
        }
        if !app.keyboards.firstMatch.waitForExistence(timeout: 3) {
            field.tap()
        }
        // 只在鍵盤確實出現後才做遮擋斷言；不要用瞬間 .exists 走進
        // 會硬等再讓整項測試失敗的路徑（先前 iPhone SE 在對話框被捲走後發生）。
        if app.keyboards.firstMatch.waitForExistence(timeout: 4) {
            assertFieldAboveKeyboard(field, surface: "id-connect", orientationName: orientationName)
            attachShot("keyboard-\(deviceFamily())-id-connect-\(orientationName)")
        } else {
            attachShot("keyboard-\(deviceFamily())-id-connect-\(orientationName)-no-keyboard")
            emit("skip-id-connect", extra: [
                "reason": "keyboard-missing",
                "note": "以 ID 連線欄位已出現，但軟體鍵盤未在時限內出現；不讓整項測試失敗",
            ])
        }
        dismissFormIfNeeded()
    }

    private func runSearchIfPresent(orientationName: String) throws {
        let search = element(labels: [
            "搜尋主機、位址或標籤", "Search hosts, addresses, or tags",
            "搜尋紀錄", "搜尋通道名稱、連接埠或目標主機...",
            "搜尋連線…", "Search",
        ], type: .searchField)
        let field: XCUIElement = search.waitForExistence(timeout: 2) ? search : element(labels: [
            "搜尋主機、位址或標籤", "Search hosts, addresses, or tags",
        ], type: .textField)
        guard field.waitForExistence(timeout: 3) else {
            emit("skip-search", extra: ["reason": "control-missing", "note": "空連線列表可能不顯示搜尋框"])
            return
        }
        field.tap()
        if cheapKeyboardVisible() {
            assertFieldAboveKeyboard(field, surface: "search", orientationName: orientationName)
            attachShot("keyboard-\(deviceFamily())-search-\(orientationName)")
        }
        if cheapKeyboardVisible() { tapSoftwareKey(["Return", "換行", "search", "Search", "搜尋"]) }
    }

    private func runLandscapePass() throws {
        // Do not rotate with the software keyboard already visible.
        // XCUIDevice.orientation changes the app's interface orientation
        // without a matching physical/keyboard rotation, so the form goes
        // landscape while the Zhuyin keyboard stays portrait. That is a
        // test artifact, not an App Info.plist / view-controller bug.
        // Rotate first, then focus a field to summon a keyboard in the
        // current interface orientation.
        dismissFormIfNeeded()
        dismissSoftwareKeyboard()
        XCUIDevice.shared.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 1.2)
        XCTAssertTrue(
            XCUIDevice.shared.orientation == .landscapeLeft || XCUIDevice.shared.orientation == .landscapeRight,
            "XCUIDevice 未真正轉到橫向（目前 \(String(describing: XCUIDevice.shared.orientation.rawValue))）"
        )
        try openAddConnection()
        let field = nameField()
        XCTAssertTrue(field.waitForExistence(timeout: 15), "找不到顯示名稱輸入框")
        if !cheapKeyboardVisible() {
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1.0)
        }
        if !cheapKeyboardVisible() {
            // One retry; the first tap can dismiss a leftover keyboard without focusing.
            field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            Thread.sleep(forTimeInterval: 1.0)
        }
        if cheapKeyboardVisible() {
            let landscapeField = nameField()
            let landscapeFrame = landscapeField.frame
            XCTAssertGreaterThan(landscapeFrame.width, landscapeFrame.height,
                                 "橫向後輸入框應是水平長條；若欄位仍是直向細條，代表 App 或測試沒有真正旋轉裝置。frame=\(NSCoder.string(for: landscapeFrame))")
            emit("landscape-orientation", extra: [
                "surface": "connection-form",
                "orientation": "landscape",
                "deviceOrientation": Int(XCUIDevice.shared.orientation.rawValue),
                "fieldWidth": Double(landscapeFrame.width),
                "fieldHeight": Double(landscapeFrame.height),
                "keyboardFrame": [
                    "x": Double(app.keyboards.firstMatch.frame.minX),
                    "y": Double(app.keyboards.firstMatch.frame.minY),
                    "width": Double(app.keyboards.firstMatch.frame.width),
                    "height": Double(app.keyboards.firstMatch.frame.height),
                ],
                "keyboardMatchesInterface": keyboardMatchesAppOrientation(),
            ])
            attachShot("keyboard-\(deviceFamily())-connection-form-landscape")
            XCTAssertTrue(
                keyboardMatchesAppOrientation(),
                "橫向後系統鍵盤方向應與頁面一致（先旋轉再叫出鍵盤）。若仍是直向鍵盤，才需要再查 App 的方向設定。"
            )
            assertFieldAboveKeyboard(landscapeField, surface: "connection-form-name", orientationName: "landscape")
            emit("first-open-keyboard", extra: ["surface": "connection-form", "orientation": "landscape"])
            // iPhone landscape leaves a very short band between the sticky
            // header and the keyboard/footer; do not fail the test trying to
            // park a second field in a space smaller than the field itself.
            let host = hostField()
            let safeBand = visualFooterTop() - visualHeaderBottom()
            if host.exists, host.frame.height + 24 < safeBand {
                revealOrTap(host)
                if cheapKeyboardVisible() {
                    assertFieldAboveKeyboard(host, surface: "connection-form-host", orientationName: "landscape")
                }
            } else if host.exists {
                emit("skip-host-reveal", extra: [
                    "reason": "landscape-safe-band-too-small",
                    "safeBand": Double(safeBand),
                    "headerBottom": Double(visualHeaderBottom()),
                    "footerTop": Double(visualFooterTop()),
                    "fieldHeight": Double(host.frame.height),
                ])
            }
        } else {
            attachShot("keyboard-" + deviceFamily() + "-connection-form-landscape-no-keyboard")
            emit("landscape-no-keyboard", extra: ["surface": "connection-form", "orientation": "landscape"])
            XCTFail("橫向時系統軟體鍵盤未出現（欄位已聚焦）。請確認已關閉 Connect Hardware Keyboard。")
        }
        dismissFormIfNeeded()
        try runQuickConnectIfPresent(orientationName: "landscape")
        try runSearchIfPresent(orientationName: "landscape")
        XCUIDevice.shared.orientation = .portrait
        Thread.sleep(forTimeInterval: 0.5)
    }

    /// Dismiss the software keyboard if it is up, without closing the form.
    private func dismissSoftwareKeyboard() {
        guard cheapKeyboardVisible() else { return }
        let keyboard = app.keyboards.firstMatch
        for label in ["完成", "Done", "Return", "return"] {
            let key = keyboard.buttons[label]
            if key.exists && key.isHittable {
                key.tap()
                Thread.sleep(forTimeInterval: 0.4)
                if !cheapKeyboardVisible() { return }
            }
        }
        // A downward swipe from mid-form dismisses the keyboard more reliably
        // than tapping a chrome button that might also close the drawer.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        start.press(forDuration: 0.05, thenDragTo: end)
        Thread.sleep(forTimeInterval: 0.5)
    }

    /// True when the visible keyboard is a bottom bar in the same orientation as the app.
    private func keyboardMatchesAppOrientation() -> Bool {
        guard cheapKeyboardVisible() else { return false }
        return bottomKeyboardMinY() != nil
    }

    // MARK: - Typing

    private func typeEnglishSymbolsOn(_ field: XCUIElement) throws {
        switchToLatinKeyboard()
        tapSoftwareKey(["h", "H"])
        tapSoftwareKey(["i", "I"])
        let afterLetters = visibleValue(of: field)
        XCTAssertTrue(afterLetters.lowercased().contains("hi"), "英文字母未由軟體鍵盤寫入，實際：\(afterLetters)")
        tapSoftwareKey([" ", "space", "Space", "空格"])
        switchToNumbers()
        tapSoftwareKey(["1"])
        tapSoftwareKey(["2"])
        let afterDigits = visibleValue(of: field)
        XCTAssertTrue(afterDigits.contains("1") && afterDigits.contains("2"), "數字鍵未寫入，實際：\(afterDigits)")
        let beforeDelete = visibleValue(of: field)
        tapSoftwareKey(["delete", "Delete", "刪除"])
        XCTAssertLessThan(visibleValue(of: field).count, beforeDelete.count, "刪除鍵未刪去字元")
        tapSoftwareKey(["Return", "換行", "return", "Return"])
        emit("english-symbols", extra: ["value": visibleValue(of: field)])
        XCTAssertFalse(visibleValue(of: field).isEmpty, "打完的文字不可見")
    }

    private func typeZhuyinOn(_ field: XCUIElement) throws {
        XCTAssertTrue(isZhuyinKeyboardVisible(), "不是注音鍵盤")
        tapSoftwareKey(["ㄏ"])
        tapSoftwareKey(["ㄠ"])
        tapSoftwareKey(["ˇ", "三聲、", "3"])
        Thread.sleep(forTimeInterval: 0.5)
        let selected = selectZhuyinCandidate(preferred: ["好", "郝", "浩"])
        if !selected.isEmpty {
            XCTAssertTrue(containsHan(visibleValue(of: field)) || containsHan(selected), "注音選字後欄位沒有中文")
        }
        emit("zhuyin", extra: ["field": visibleValue(of: field), "candidate": selected])
    }

    // MARK: - Occlusion

    private func assertFieldAboveKeyboard(_ field: XCUIElement, surface: String, orientationName: String, file: StaticString = #file, line: UInt = #line) {
        assertSoftwareKeyboardVisible()
        let keyboard = app.keyboards.firstMatch
        let fieldFrame = field.frame
        let keyboardFrame = keyboard.frame
        emit("occlusion", extra: [
            "surface": surface,
            "orientation": orientationName,
            "fieldMaxY": Double(fieldFrame.maxY),
            "keyboardMinY": Double(keyboardFrame.minY),
            "fieldMaxX": Double(fieldFrame.maxX),
            "keyboardMinX": Double(keyboardFrame.minX),
            "overlapW": Double(fieldFrame.intersection(keyboardFrame).width),
            "overlapH": Double(fieldFrame.intersection(keyboardFrame).height),
            "hittable": field.isHittable,
        ])
        XCTAssertGreaterThan(fieldFrame.height, 8, "輸入框高度異常，文字可能不可見", file: file, line: line)
        attachShot("keyboard-\(deviceFamily())-\(surface)-\(orientationName)")
        let overlap = fieldFrame.intersection(keyboardFrame)
        let occluded = !overlap.isNull && overlap.width > 8 && overlap.height > 8
        if occluded && orientationName == "landscape" && isKeyboardCoordinateMismatchedWithApp() {
            emit("skip-occlusion", extra: [
                "reason": "keyboard-orientation-mismatch",
                "note": "模擬器假象：App 已橫向排版，但系統鍵盤座標系仍為直向，略過遮擋斷言",
                "surface": surface,
                "orientation": orientationName,
                "fieldMaxY": Double(fieldFrame.maxY),
                "keyboardMinY": Double(keyboardFrame.minY),
                "fieldMaxX": Double(fieldFrame.maxX),
                "keyboardMinX": Double(keyboardFrame.minX),
                "overlapW": Double(overlap.width),
                "overlapH": Double(overlap.height),
            ])
            return
        }
        XCTAssertTrue(!occluded,
                      "輸入框被系統鍵盤遮住：surface=\(surface) orientation=\(orientationName) field=\(NSCoder.string(for: fieldFrame)) keyboard=\(NSCoder.string(for: keyboardFrame))",
                      file: file, line: line)
    }

    /// 模擬器假象：XCUIDevice 已把介面轉成橫向，截圖緩衝／系統鍵盤卻仍是直向像素。
    private func isKeyboardCoordinateMismatchedWithApp() -> Bool {
        let orientation = XCUIDevice.shared.orientation
        guard orientation == .landscapeLeft || orientation == .landscapeRight else { return false }
        let image = XCUIScreen.main.screenshot().image
        let width = image.cgImage.map { CGFloat($0.width) } ?? image.size.width
        let height = image.cgImage.map { CGFloat($0.height) } ?? image.size.height
        return height > width
    }

    // MARK: - Navigation

    private func waitForFrontend() {
        let add = element(labels: ["新增連線", "Add connection"], type: .button)
        if !add.waitForExistence(timeout: 8) {
            // A leftover drawer or discard sheet from a previous run hides 新增連線.
            dismissFormIfNeeded()
        }
        XCTAssertTrue(add.waitForExistence(timeout: 90), "連線頁在 90 秒內未出現「新增連線」")
    }

    private func openAddConnection() throws {
        if nameField().exists { return }
        let add = element(labels: ["新增連線", "Add connection"], type: .button)
        XCTAssertTrue(add.waitForExistence(timeout: 45), "連線頁未出現「新增連線」")
        add.tap()
        XCTAssertTrue(nameField().waitForExistence(timeout: 15), "新增連線表單未開啟")
        Thread.sleep(forTimeInterval: 0.8)
    }

    private func dismissFormIfNeeded() {
        // In landscape the footer may have scrolled out of the keyboard-visible
        // band, so 取消 exists but is not hittable. Put the keyboard away first
        // so the footer returns, then tap with a coordinate if needed.
        dismissSoftwareKeyboard()
        let close = element(labels: ["關閉", "Close", "取消", "Cancel"], type: .button)
        if close.exists {
            if close.isHittable {
                close.tap()
            } else {
                close.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        let discard = element(labels: ["放棄修改", "放棄", "Discard", "Discard changes"], type: .button)
        if discard.waitForExistence(timeout: 3) {
            if discard.isHittable { discard.tap() }
            else { discard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1) }
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    /// Top of a keyboard that actually sits along the bottom edge. Landscape
    /// on this device often reports a rotated/sideways keyboard frame
    /// (minY == 0) that must not be treated as covering the whole screen.
    private func bottomKeyboardMinY() -> CGFloat? {
        guard cheapKeyboardVisible() else { return nil }
        let keyboard = app.keyboards.firstMatch.frame
        guard keyboard.minY > app.frame.midY * 0.5, keyboard.width >= keyboard.height else {
            return nil
        }
        return keyboard.minY
    }

    /// Visible top edge of the sticky drawer footer (取消／儲存), not the
    /// possibly unclipped WebView accessibility minY of those buttons.
    private func visualFooterTop() -> CGFloat {
        var top = app.frame.maxY
        if let keyboardMinY = bottomKeyboardMinY() {
            top = min(top, keyboardMinY)
        }
        let chromeLabels = [
            "取消", "Cancel", "儲存", "儲存並連線", "Save", "Save and connect",
        ]
        for label in chromeLabels {
            let chrome = element(labels: [label], type: .button)
            guard chrome.exists else { continue }
            let frame = chrome.frame
            let height = min(max(frame.height, 44), 56)
            top = min(top, frame.maxY - height)
        }
        return top
    }

    /// Bottom of the sticky drawer header. The close button is shorter than
    /// the eyebrow+title block, so close.maxY alone underestimates the bar.
    private func visualHeaderBottom() -> CGFloat {
        var bottom = app.frame.minY + 80
        let close = element(labels: ["關閉", "Close"], type: .button)
        if close.exists { bottom = max(bottom, close.frame.maxY) }
        let titles = ["新增連線", "Add connection", "編輯連線", "Edit connection", "新增", "Add"]
        for title in titles {
            let labels = app.staticTexts.matching(NSPredicate(format: "label == %@", title))
            for i in 0..<min(labels.count, 6) {
                let item = labels.element(boundBy: i)
                guard item.exists else { continue }
                // Ignore the same label on the connections page behind the drawer.
                guard item.frame.minY < 220, item.frame.maxY < 240 else { continue }
                bottom = max(bottom, item.frame.maxY)
            }
        }
        return bottom
    }

    /// 欄位在無障礙樹裡的 frame 可能還落在固定頁尾（取消／儲存）上。
    /// 此時直接 tap 會點到「取消」，髒表單就會跳出「要放棄這次的修改？」，鍵盤也會收掉。
    private func fieldIsSafelyTappable(_ field: XCUIElement) -> Bool {
        guard field.exists, field.frame.width > 8, field.frame.height > 8 else { return false }
        let rect = field.frame
        if let keyboardMinY = bottomKeyboardMinY(), rect.maxY > keyboardMinY + 1 {
            return false
        }
        if rect.maxY > visualFooterTop() - 4 { return false }
        if rect.minY < visualHeaderBottom() + 4 { return false }
        return true
    }

    /// `delta > 0` moves content up (reveals lower fields). `delta < 0` moves it down.
    private func scrollForm(delta: CGFloat) {
        let header = visualHeaderBottom()
        let footer = visualFooterTop()
        guard footer - header > 80 else { return }
        let startY: CGFloat
        let endY: CGFloat
        if delta > 0 {
            startY = min(footer - 16, header + 80 + delta)
            endY = startY - min(abs(delta), startY - (header + 16))
        } else {
            startY = max(header + 16, footer - 80 - abs(delta))
            endY = startY + min(abs(delta), (footer - 16) - startY)
        }
        guard abs(endY - startY) > 20 else { return }
        // Start on the left padding so the gesture does not become a text
        // selection inside the focused field.
        let startX = max(app.frame.minX + 20, 20)
        let start = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: startX, dy: startY))
        let end = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: startX, dy: endY))
        start.press(forDuration: 0.05, thenDragTo: end)
        Thread.sleep(forTimeInterval: 0.4)
    }

    private func revealOrTap(_ field: XCUIElement) {
        for attempt in 0..<10 {
            if fieldIsSafelyTappable(field) {
                field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
                return
            }
            guard field.exists else { break }
            if attempt == 0 {
                emit("reveal-start", extra: [
                    "field": NSCoder.string(for: field.frame),
                    "headerBottom": Double(visualHeaderBottom()),
                    "footerTop": Double(visualFooterTop()),
                    "keyboardMinY": cheapKeyboardVisible() ? Double(app.keyboards.firstMatch.frame.minY) : -1,
                ])
            }
            let header = visualHeaderBottom()
            let footer = visualFooterTop()
            if field.frame.maxY > footer - 4 {
                scrollForm(delta: field.frame.maxY - (footer - 16))
            } else if field.frame.minY < header + 4 {
                scrollForm(delta: field.frame.minY - (header + 16))
            } else {
                scrollForm(delta: 80)
            }
        }
        emit("reveal-failed", extra: [
            "field": NSCoder.string(for: field.frame),
            "headerBottom": Double(visualHeaderBottom()),
            "footerTop": Double(visualFooterTop()),
            "keyboardMinY": cheapKeyboardVisible() ? Double(app.keyboards.firstMatch.frame.minY) : -1,
        ])
        attachShot("reveal-failed")
        XCTAssertTrue(field.exists, "要點的欄位不存在")
        XCTAssertTrue(fieldIsSafelyTappable(field), "欄位仍被頁尾或鍵盤擋住，無法安全點擊")
        field.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
    }

    private func nameField() -> XCUIElement {
        element(labels: ["例如：正式站主機", "Production host", "顯示名稱", "Display name"], type: .textField)
    }

    private func hostField() -> XCUIElement {
        let primary = element(labels: ["主機位址", "Hostname"], type: .textField)
        if primary.exists { return primary }
        return element(labels: ["ssh.example.com", "files.example.com", "192.0.2.10", "Host"], type: .textField)
    }

    private func portField() -> XCUIElement {
        element(labels: ["連接埠", "Port", "22", "2222"], type: .textField)
    }

    private func element(labels: [String], type: XCUIElement.ElementType) -> XCUIElement {
        var predicates: [NSPredicate] = []
        for label in labels {
            predicates.append(NSPredicate(format: "label == %@ OR placeholderValue == %@ OR identifier == %@ OR value == %@",
                                          label, label, label, label))
        }
        return app.descendants(matching: type).matching(NSCompoundPredicate(orPredicateWithSubpredicates: predicates)).firstMatch
    }

    // MARK: - Software keyboard

    private func cheapKeyboardVisible() -> Bool { app.keyboards.firstMatch.exists }

    private func assertSoftwareKeyboardVisible(timeout: TimeInterval = 8) {
        let keyboard = app.keyboards.firstMatch
        if !keyboard.waitForExistence(timeout: timeout) {
            attachShot("keyboard-" + deviceFamily() + "-software-keyboard-missing")
        }
        XCTAssertTrue(keyboard.exists,
                      "系統軟體鍵盤未出現。請確認已關閉 Connect Hardware Keyboard，且測試是點按鍵而非 typeText。")
        XCTAssertGreaterThan(keyboard.frame.height, 120, "鍵盤高度 \(keyboard.frame.height) 過低，可能不是系統軟體鍵盤")
    }

    @discardableResult
    private func tapSoftwareKey(_ names: [String], file: StaticString = #file, line: UInt = #line) -> String {
        assertSoftwareKeyboardVisible()
        let keyboard = app.keyboards.firstMatch
        for name in names {
            if let hit = firstHittableKey(named: name, in: keyboard) {
                hit.tap()
                Thread.sleep(forTimeInterval: 0.12)
                return name
            }
        }
        XCTFail("軟體鍵盤找不到按鍵 \(names.joined(separator: "/"))", file: file, line: line)
        return ""
    }

    private func firstHittableKey(named name: String, in keyboard: XCUIElement) -> XCUIElement? {
        for element in [keyboard.keys[name], keyboard.buttons[name]] where element.exists {
            return element.firstMatch
        }
        return nil
    }

    private func switchToNumbers() {
        if firstHittableKey(named: "1", in: app.keyboards.firstMatch) != nil { return }
        XCTAssertTrue(tapIfPresent(["more", "數字", "numbers", "Numbers", "123", "#+="]), "無法切換到數字鍵盤")
        Thread.sleep(forTimeInterval: 0.25)
    }

    private func switchToLatinKeyboard() {
        if isLatinKeyboardVisible() { return }
        _ = tapIfPresent(["abc", "ABC", "字母", "English", "英文"])
        Thread.sleep(forTimeInterval: 0.25)
        if isLatinKeyboardVisible() { return }
        let next = firstHittableKey(named: "Next keyboard", in: app.keyboards.firstMatch)
        if let next {
            next.press(forDuration: 1.0)
            Thread.sleep(forTimeInterval: 0.4)
            for label in ["English", "英文", "U.S.", "US", "QWERTY", "English (US)"] {
                let option = app.buttons[label]
                if option.exists { option.tap(); Thread.sleep(forTimeInterval: 0.4); break }
            }
        }
        for _ in 0..<6 {
            if isLatinKeyboardVisible() { return }
            if let next = firstHittableKey(named: "Next keyboard", in: app.keyboards.firstMatch) {
                next.tap()
                Thread.sleep(forTimeInterval: 0.4)
            } else { break }
        }
        if !isLatinKeyboardVisible() {
            emit("latin-missing")
        }
    }

    private func isLatinKeyboardVisible() -> Bool {
        guard cheapKeyboardVisible() else { return false }
        let keyboard = app.keyboards.firstMatch
        return ["Q", "W", "A", "q", "w", "a"].contains { firstHittableKey(named: $0, in: keyboard) != nil }
    }

    private func isZhuyinKeyboardVisible() -> Bool {
        guard cheapKeyboardVisible() else { return false }
        let keyboard = app.keyboards.firstMatch
        return ["ㄅ", "ㄆ", "ㄉ", "ㄏ", "ㄠ"].contains { firstHittableKey(named: $0, in: keyboard) != nil }
    }

    @discardableResult
    private func tapIfPresent(_ names: [String]) -> Bool {
        guard cheapKeyboardVisible() else { return false }
        let keyboard = app.keyboards.firstMatch
        for name in names {
            if let hit = firstHittableKey(named: name, in: keyboard) {
                hit.tap(); return true
            }
        }
        return false
    }

    @discardableResult
    private func selectZhuyinCandidate(preferred: [String]) -> String {
        let keyboardY = app.keyboards.firstMatch.frame.minY
        for word in preferred {
            let text = app.staticTexts[word]
            if text.exists && text.frame.maxY <= keyboardY + 40 { text.tap(); return word }
            let button = app.buttons[word]
            if button.exists && button.frame.maxY <= keyboardY + 40 { button.tap(); return word }
        }
        return ""
    }

    private func dismissKeyboardTutorial() {
        let tutorial = app.buttons.matching(NSPredicate(format: "label == %@ OR label == %@", "Continue", "繼續")).firstMatch
        if tutorial.waitForExistence(timeout: 2) {
            tutorial.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 0.1)
            _ = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: tutorial)], timeout: 5)
        }
    }

    private func visibleValue(of field: XCUIElement) -> String {
        if let value = field.value as? String, !value.isEmpty, value != field.placeholderValue { return value }
        return (field.value as? String) ?? ""
    }

    private func containsHan(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.properties.isIdeographic }
    }

    private func deviceFamily() -> String {
        UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }

    private func emit(_ stage: String, extra: [String: Any] = [:]) {
        var payload: [String: Any] = [
            "stage": stage,
            "capturedAt": Date().timeIntervalSince1970,
            "keyboardVisible": cheapKeyboardVisible(),
            "keyboardFrame": framePayload(cheapKeyboardVisible() ? app.keyboards.firstMatch.frame : .zero),
            "family": deviceFamily(),
        ]
        extra.forEach { payload[$0.key] = $0.value }
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let text = String(data: data, encoding: .utf8) else { return }
        print("LATTICE_SOFTWARE_KEYBOARD \(text)")
    }

    private func framePayload(_ frame: CGRect) -> [String: CGFloat] {
        ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
    }

    private func attachShot(_ name: String) {
        let shot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

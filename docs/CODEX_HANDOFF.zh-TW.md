# Codex 對話換手（待實機驗收）

此分支保留同一 native conversation ID，不複製／改寫 rollout，不刪除鎖檔。

## 版本與調查依據

對照官方 `rust-v0.169.0` 原始碼（本工作複本與 Cargo checkout 沒有 Codex 原始碼）：

- [rollout writer_lock.rs](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/rollout/src/writer_lock.rs)：
  寫入者持有 `thread-writer-locks/<thread>.lock` 的排他檔案鎖；rollout FD 並非充分依據。
- [app-server message_processor.rs](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/app-server/src/message_processor.rs)：
  `thread/unsubscribe` 分派到 thread processor 並停止連線的事件串流；本次未證實它在所有
  客戶端情況都會卸載 writer，因此沒有將 unsubscribe 當成釋放鎖的充分收據。
  沒有使用未確認存在的 `thread/close`。
- [TUI slash_command.rs](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/tui/src/slash_command.rs)：
  `Exit` 與 `Quit` 是正常退出命令。本分支只對自己的已驗證空白 TUI 送 `/exit`。

內建對話沿用既有每輪完成後關閉自有 app-server stdin 的機制；沒有改動 Desktop。

## 放手與取回

預設兩分鐘，可設 0（關閉）或 5／10 分鐘。前端回報目前實際前景的工作階段；
前景紀錄在失聯時保守保留，不因 heartbeat 消失便當作背景。只有 desktop-owned
Codex PTY 符合 idle/done、正式完成證據、靜止且空白提示、無人類輸入／核准／
待送訊息時才計時。背景 daemon 工作階段目前排除，避免缺少前景／設定同步時誤放手。

在輸入鎖內送 `/exit`，不送 interrupt，不用 kill fallback。
只在子行程成功退出後標示 `writerReleased`，保留 conversation/group/session ID。
下一次 GUI 真正輸入或 MCP prompt 會以原啟動政策 resume；等待可輸入畫面後才送出。
保留輸出 offset、授權 epoch 與分享 identity；停止／撤權不會因重建程序而復活。
已放手程序的舊 PID 不再用於終止操作。

## 占用者與接手

Linux 只讀 `/proc/<pid>/exe` 與 `fd` 連結，比對正確 Codex home 的 thread lock。
不讀 environ、FD 內容或 argv，更不輸出帳密。
Desktop executable 精確匹配 `/usr/lib/chatgpt/resources/codex`；本 registry PID
標示 latticeterm，其餘 unknown。此為保守的 FD 持有者辨識，不是跨平台完整鎖所有權證明。

對話鎖錯誤提供重試，以及最多兩分鐘的等待／取消。等待只探測現有鎖的可取得性，
不建立或刪除鎖檔、不送訊息當探針；可取得後只執行一次明確請求的重試。
鎖探測到 resume 之間仍可能競爭，屆時正常顯示鎖錯誤，不自動循環重送。

**未實作「結束占用方」與其確認對話框**：單一 thread 完成／無寫入，不能證明
共享 app-server 的其他 thread 都閒置。本版本沒有外部 SIGTERM 路徑。

## MCP

`desktop_agent state` 提供 `writerReleased`、`writerHolder {kind,pid}` 與 `writerAdvice`。
已放手且無其他 writer 時 readiness basis 是 `writer_released`，可送出並自動 resume。
發現其他 writer 時 blocker 是 `thread_locked_by_other_writer`，prompt 回 not_ready。
既有控制授權與 requestId 收據機制保留；新程序不繞過就緒判斷。

## 驗證界線

單元測試涵蓋放手條件／計時／前景／回合／草稿／佇列、續接參數、MCP 狀態與
占用者 blocker、假 proc 辨識、鎖探測、前端等待／取消／逾時／單次重試。
沒有啟動或終止任何既有 Codex、Desktop、LatticeTerm 或 daemon。
正常 TUI 退出後實際 resume 的完整循環、Windows/macOS 與 Desktop 0.167
互通仍需隔離環境實測，不能以這些單元測試宣稱已驗收。

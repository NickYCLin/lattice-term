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
  `Exit` 與 `Quit` 是正常退出命令。不再對空白 TUI 自動送 `/exit`；使用者仍可自己輸入該指令結束。

內建對話沿用既有每輪完成後關閉自有 app-server stdin 的機制；沒有改動 Desktop。

## 放手與取回

自動對閒置 TUI 送 `/exit` 的行為已移除：會把側欄留在完成狀態，終端卻變成死輸入。程序若自行結束，會保留同一 conversation，並提供「重新啟動並接續」；非使用者主動退出時，下一次輸入會自動續接。

LatticeTerm 不再對閒置 TUI 自動送 `/exit`。子行程結束且仍有 native conversation ID 時，
會標示 `writerReleased`、保留 conversation/group/session ID，並讓側欄顯示「已結束」。
若結束不是使用者主動的 `/exit` 或 `/quit`，下一次 GUI 輸入或 MCP prompt 會以原啟動政策
自動 resume；使用者主動退出則提供「重新啟動並接續」，不自動重開。
保留輸出 offset、授權 epoch 與分享 identity；停止／撤權不會因重建程序而復活。
已結束程序的舊 PID 不再用於終止操作。

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

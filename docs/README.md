# LatticeTerm 程式碼與文件導覽

這份索引讓第一次進入專案的工程師或程式型 Agent，能先找到真正負責功能的入口，不必只靠全文猜測。

第一次使用請先看 [試用步驟](FIRST_RUN.zh-TW.md) 或 [English quick start](../README.en.md#get-started)。
對話頁的公開介面與待補功能見 [Codex Desktop 功能對照](CHAT_DESKTOP_PARITY.zh-TW.md)。

[完整功能與限制](FEATURES.zh-TW.md) · [本地開發與驗證](DEVELOPMENT.zh-TW.md) · [產品介紹參考](PRODUCT_PRESENTATION.zh-TW.md)

## 從需求找程式碼

| 想了解或修改的範圍 | 前端入口 | Rust／協定入口 | 延伸文件 |
| --- | --- | --- | --- |
| 應用程式導覽、頁面切換與全域狀態 | `src/App.tsx`、`src/views/` | `src-tauri/src/lib.rs` | [介面實作現況](UI_IMPLEMENTATION.zh-TW.md) |
| 本機 AI CLI、Agent Fleet、PTY 與狀態回報 | `src/views/AgentsView.tsx`、`src/app/useAgentSessions.ts`、`src/components/agents/` | `src-tauri/src/agent.rs`、`src-tauri/src/agent_plans.rs` | [Agent Fleet 架構](AGENT_FLEET_ARCHITECTURE.zh-TW.md) |
| 讓外部 AI 透過 MCP 唯讀查看分享的背景工作階段 | `src/views/AgentsView.tsx`（分享開關與設定片段）、`src/app/agentMcpConfig.ts` | `src-tauri/src/agent_daemon/mcp.rs`、`agent_daemon/server.rs`（observer 角色） | [MCP Server](MCP.zh-TW.md) |
| 對話模式（聊天視窗、逐項核准、排程任務、多帳號、對話資料夾） | `src/views/ChatView.tsx`、`src/components/chat/`、`src/app/agentChat.ts`、`agentAutomations.ts`、`chatAccountProfiles.ts`、`chatThreadLayout.ts` | `src-tauri/src/agent_chat.rs` | [Agent Fleet 架構](AGENT_FLEET_ARCHITECTURE.zh-TW.md#對話模式) |
| 工作階段、專案與自訂資料夾 | `src/views/SessionsView.tsx`、`src/components/sessions/`、`src/app/sessionSidebarLayout.ts` | 各工作階段後端模組 | [介面設計摘要](UI_UX_DESIGN_BRIEF.zh-TW.md) |
| SSH 終端、SFTP 與 Tunnel | `src/components/terminal/`、`src/components/sftp/`、`src/views/TunnelsView.tsx` | `src-tauri/src/ssh.rs`、`sftp.rs`、`sftp_transfers.rs`、`tunnel.rs` | [儲存與安全決策](STORAGE_SECURITY_DECISION.zh-TW.md) |
| Lattice Remote 畫面／純終端、控制、檔案傳輸與中繼 | `src/components/remote/` | `src-tauri/src/remote.rs`、`remote_host.rs`、`remote_files.rs`、`crates/lattice-remote/` | [中繼部署與安全](RELAY_SERVER.zh-TW.md)、[介面實作現況](UI_IMPLEMENTATION.zh-TW.md) |
| RDP 與 VNC | `src/components/rdp/`、`src/components/vnc/` | `src-tauri/src/rdp.rs`、`vnc.rs`、`crates/lattice-rdp/`、`crates/lattice-vnc/` | [介面實作現況](UI_IMPLEMENTATION.zh-TW.md) |
| 保管庫、認證資料、備份與本機儲存 | `src/components/vault/`、`src/components/settings/` | `src-tauri/src/vault.rs`、`backup.rs`、`storage.rs` | [儲存與安全決策](STORAGE_SECURITY_DECISION.zh-TW.md) |
| 自動更新、版本與發行檔 | `src/app/useAppUpdater.ts`、`src/app/version.ts`、`src/views/SettingsView.tsx` | `src-tauri/tauri.conf.json`、`.github/workflows/release.yml` | [Release 自動化](RELEASE_AUTOMATION.zh-TW.md)、[更新紀錄](../CHANGELOG.md) |
| iOS 簽章、TestFlight 與 App Store 準備 | `src/components/settings/PrivacyNotice.tsx`、`web/` | `scripts/ios-release.mjs`、`scripts/verify-ios-app.py`、`src-tauri/gen/apple/` | [iOS 發布流程](IOS_RELEASE.zh-TW.md)、[商店文案與待補資料](IOS_APP_STORE_METADATA.zh-TW.md) |

## 技術輪廓

- 桌面殼層：Tauri 2。
- 前端：React、TypeScript、Vite、xterm.js。
- 原生後端：Rust；桌面命令集中在 `src-tauri/src/`。
- 獨立引擎：`crates/lattice-remote`、`crates/lattice-rdp`、`crates/lattice-vnc`。
- 測試：Vitest 與 Rust `cargo test`；完整指令列在 [本地開發](DEVELOPMENT.zh-TW.md#專案驗證)。

## 專案邊界

- LatticeTerm 會啟動本機 AI CLI，但不接管它們的 API key、登入 token 或雲端帳號；對話模式也只是以各 CLI 的 headless 模式逐輪執行，逐字稿仍由 CLI 自己保存。
- Linux 上的 Agent 沙箱是 bubblewrap 的檔案範圍策略，不是完整容器；沒有 bwrap 或系統禁止非特權 user namespace 時不提供該選項。
- SSH、SFTP、RDP、VNC 與 Lattice Remote 都是真實工作階段，不以假資料模擬已完成能力。
- Lattice Remote 支援兩種模式：區網一次性加密直連，或透過自架 `lattice-relay` 以九位數裝置 ID 跨網路連線；可分享主螢幕或純終端，輸入與單一檔案根目錄分開授權。中繼位址只在首次／修改時展開，並非安全機密；多人租戶服務與 NAT 直連穿透仍是後續階段（見 [中繼部署與安全](RELAY_SERVER.zh-TW.md)）。
- 桌面版是主要完成範圍；需要 sidecar 或本機 PTY 的功能不會假裝可在瀏覽器、Android 或 iOS 使用。

安全問題請依 [SECURITY.md](../SECURITY.md) 私下回報；一般修改流程與提交規則請見 [CONTRIBUTING.md](../CONTRIBUTING.md)。

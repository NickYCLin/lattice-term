# GLib 嚴格 Clippy 清理與完整驗證

## 範圍與修正

在 `fix/glib-clippy-20261029`、`9eac8c7c` 基準上先執行
`git pull --rebase origin main`。只調整 vendored GLib 的等價寫法，
並在 Linux CI 加入 GLib 的 `cargo clippy --all-targets -- -D warnings`。
沒有修改依賴版本、已追蹤鎖檔或 CLIProxyAPI 服務端與設定。

Rust 1.99.0 首輪嚴格 Clippy 共 65 個不同診斷位置：

| 診斷 | 數量 | 處理 |
| --- | ---: | --- |
| needless_lifetimes | 28 | 省略不參與其他 lifetime 關係的參數 |
| question_mark | 13 | 保留原本 None 提早返回，改用 `?` |
| missing_transmute_annotations | 9 | 明列原本推導的來源及目的型別 |
| useless_conversion | 5 | 移除 IntoIterator 參數多餘轉換 |
| macro_metavars_in_unsafe | 4 | 保留公開 macro 契約，逐處局部 allow |
| multiple_bound_locations | 3 | 合併 bound；移除預設成立的 Sized |
| needless_maybe_sized | 2 | 移除已由 Into 要求 Sized 的無效 ?Sized |
| empty_line_after_doc_comments | 1 | 移除文件與 macro 之間的空行 |

## 局部 allow

四處新增的 allow 都只有 `clippy::macro_metavars_in_unsafe`，
直接標在 `StaticType::static_type` 的型別註冊 unsafe 運算式上：

- `vendor/glib-0.18.5/src/boxed.rs`：`glib_boxed_wrapper!`。
- `vendor/glib-0.18.5/src/boxed_inline.rs`：`glib_boxed_inline_wrapper!`。
- `vendor/glib-0.18.5/src/object.rs`：`glib_object_wrapper!`。
- `vendor/glib-0.18.5/src/shared.rs`：`glib_shared_wrapper!`。

`wrapper!` 文件明訂 match fn 運算式在 unsafe 上下文求值，
讓呼叫端直接提供 unsafe FFI 型別註冊函式。把參數移出 unsafe
會改變既有呼叫端契約，因此保留原本行為，每處附上理由註解。
沒有新增 crate 層級 allow，也沒有擴大既有 unsafe 範圍。

## 驗證結果

七個 manifest 都執行 `cargo fmt --all -- --check`、
`cargo check --all-targets`、完整 `cargo test` 與
`cargo clippy --all-targets -- -D warnings`，全部通過。
Remote 啟用 `agent client-cli relay-server`；桌面測試啟用
`LATTICETERM_REQUIRE_SANDBOX_TEST=1`。

| Manifest | 通過 | 既有略過 | check／fmt／嚴格 Clippy |
| --- | ---: | ---: | --- |
| 桌面 | 1087 | 58 | 全部通過 |
| Remote | 179 | 11 | 全部通過 |
| RDP | 7 | 0 | 全部通過 |
| VNC | 9 | 0 | 全部通過 |
| 更新簽章相容工具 | 7 | 1 | 全部通過 |
| vendored RDPDR | 35 | 0 | 全部通過 |
| vendored GLib | 279 | 34 | 全部通過 |

前端 `npm run check` 通過，包含版本同步、Actions pinning、
tsc、Vitest（2115 通過、3 項既有略過）、正式建置與入口大小檢查。
三組 debug sidecar 建置成功。額外檢查包含 GLib release
`variant_iter::tests`（11 通過）、真實本機 OpenSSH（22 通過）、
Remote 加密文字 E2E（1 通過）及更新簽章 `--locked --offline` 測試通過。
測試產生的未追蹤 lock 只用於本機解析，不納入交付；
既有略過宣告與依賴版本均保留。

## 真機驗證邊界

本次為 Linux 原始碼檢查，未執行以下人工驗收：

- Windows 安裝版 GUI、ConPTY、原生主控台隱藏及 `.cmd` shim。
- macOS 安裝版 GUI、原生退出路徑與檔案系統權限行為。
- Windows／macOS 真實 CLI 啟動、對話續接、背景啟動與撤權。

CI 與本機檢查結果不能代替安裝版及真機人工驗收。

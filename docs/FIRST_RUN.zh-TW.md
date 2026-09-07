# 第一次使用 LatticeTerm

先完成一件小事：用一個 AI 助理讀取範例筆記，再切換到另一個工作階段。
這條流程使用已發行桌面版的 Agent Fleet，不需要遠端主機或自架服務。

## 1. 安裝與準備

到 [Releases](https://github.com/NickYCLin/lattice-term/releases/latest) 下載符合電腦平台的安裝檔。
Windows 使用 `x64-setup.exe`；Apple Silicon 選 `aarch64.dmg`，Intel Mac 選 `x64.dmg`；
Linux 依處理器選 x64 或 arm64 的套件。

AI 功能需要一個已安裝、已登入的 CLI，例如 Codex 或 Claude Code。
開啟「AI Agent Fleet」查看工具是否已偵測到；缺少工具時，介面會顯示安裝入口與要執行的指令。
安裝及登入由各工具自己的流程完成，LatticeTerm 不另收模型費用。

若只想使用 SSH／SFTP，可直接到「我的連線」新增連線，不必安裝 AI CLI。

## 2. 用範例開始

建立一個空資料夾，把 [project-notes.md](../examples/first-session/project-notes.md) 的內容另存進去。
這份筆記使用虛構專案，不需要放入自己的程式碼或帳號資料。

在 Agent Fleet 選擇已安裝的助理，把工作目錄設成這個資料夾，再按「啟動」。
看到助理自己的輸入畫面後，貼上：

```text
請閱讀 project-notes.md，用繁體中文列出三個待辦事項，
依優先順序排序，並說明每項完成時應該看到什麼結果。
這次只整理資訊，不要修改檔案。
```

完成後，你應該看到三項待辦與各自的驗收方式。實際措辭依助理而異。
從工作階段側欄切到別處再切回，原本的終端內容仍會保留。

## 3. 再加一個助理

如果已安裝第二個 CLI，可以在同一個專案再開一個工作階段，交給它同一份筆記，請它找出需求中尚未說清楚的地方。
兩個工作階段會各自保留輸出；你可以比較整理結果，不必在桌面上找兩個終端視窗。

資料夾整理、分頁名稱、收合與搜尋都在工作階段側欄。
「留在背景」適合需要關閉視窗後繼續執行的工作，第一次試用可以先保持預設。

## 遇到問題時

| 畫面或狀況 | 可以先做的事 |
| --- | --- |
| 找不到剛安裝的 CLI | 重新開啟 LatticeTerm，再確認工具自己的命令能否啟動。 |
| 助理要求登入 | 在該工具自己的終端流程完成登入，再回到 LatticeTerm。 |
| 顯示需要回覆 | 查看目前終端是否真的出現授權或選項；狀態燈是輔助，終端內容才是依據。 |
| 回覆沒有繼續 | 先查看授權提示、登入狀態及模型額度，再回報可重現的操作步驟。 |

[回報第一次使用的問題](https://github.com/NickYCLin/lattice-term/issues/new?template=first-run.yml)：
告訴我們作業系統、LatticeTerm 與 CLI 版本、卡在哪一步，以及預期看到什麼。
截圖先遮住帳號、主機位址、提示內容與憑證。

[回到專案介紹](../README.md) · [English quick start](../README.en.md#get-started)

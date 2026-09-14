# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

**AI アシスタントとリモート接続を、ひとつのデスクトップワークスペースで。**

使い慣れた AI アシスタントでコードを書き、変更を確認し、情報を整理できます。LatticeTerm は各アシスタントのセッションとリモート接続をプロジェクトごとにまとめ、ツールの切り替えや作業の再開を支えます。

デスクトップのコアは [MPL-2.0](LICENSE) のオープンソースで、Windows、macOS、Linux に対応しています。

## できること

- **Agent Fleet**：ローカルの AI CLI をそれぞれ独立したターミナルで実行し、セッションをプロジェクトやフォルダーで整理できます。
- **チャット**：Codex、Claude Code、Gemini CLI でメッセージ、添付ファイル、ツールの実行結果を扱えます。対応機能はツールによって異なります。
- **リモート接続**：SSH、SFTP、SSH トンネルを管理し、RDP、VNC、Lattice Remote でリモートデスクトップに接続できます。接続機能だけを使う場合、AI CLI は不要です。
- **定期実行**：繰り返す作業を予約し、ワークスペースに戻って結果を確認できます。

表示言語は繁体字中国語、英語、簡体字中国語、日本語、韓国語、スペイン語、フランス語、ドイツ語、ブラジルポルトガル語です。未翻訳の新しい文言は英語で表示されます。

## ダウンロード

[最新リリース](https://github.com/NickYCLin/lattice-term/releases/latest)の Assets から選んでください。Windows x64 は `_x64-setup.exe`、Apple Silicon Mac は `_aarch64.dmg`、Intel Mac は `_x64.dmg` です。Linux には x64 と ARM64 向けの DEB、RPM、AppImage があります。

現在は公開ベータで、デスクトップを中心に開発しています。モバイル版の機能は限られます。main ブランチには未公開の変更が含まれることがあるため、利用できる機能は[リリースノート](https://github.com/NickYCLin/lattice-term/releases)で確認してください。

## はじめに

対応する AI CLI をひとつインストールし、ログインしておいてください。LatticeTerm 専用アカウントは不要です。モデルのサブスクリプションや API 料金は利用するサービス側で発生します。

1. **AI Agent Fleet** を開き、検出されたアシスタントを選びます。見つからない場合は、ツールのカードからインストール手順を確認できます。
2. 空のフォルダーに [project-notes.md](examples/first-session/project-notes.md) を保存し、そのフォルダーを作業ディレクトリに指定して起動します。
3. 入力待ちになったら、次のように依頼します。「project-notes.md を読み、3 つのタスクを優先順に並べ、それぞれの完了を確認する方法を示してください。日本語で回答し、まだファイルは変更しないでください。」

SSH や SFTP のみを使う場合は、接続画面から始められます。

## 制限とデータ

ワークスペース設定と会話のローカルコピーは自分のコンピューターに保存されます。CLI やモデルの提供元には、作業に必要なプロンプトやファイル内容が送られる場合があります。

SSH Fleet は MCP 経由でリモートワークスペースを操作し、個別の権限付与と複数の独立した PTY を使用します。Lattice Remote の単一ターミナル共有だけでは、リモートの複数エージェントを編成できません。[Relay 経由の Fleet](docs/RELAY_FLEET.zh-TW.md) は開発ブランチで MCP に対応していますが、外部ホストとインストール版の検証は未完了です。リモート Fleet の分割ペインは含まれません。ホスティング型のチームサービスは現在提供していません。

## ドキュメントと貢献

このページは概要です。詳しい紹介は[英語版 README](README.en.md)、技術文書は主に繁体字中国語で提供しています。

- [機能と制限](docs/FEATURES.zh-TW.md)
- [開発と検証](docs/DEVELOPMENT.zh-TW.md)
- [ドキュメント一覧](docs/README.md)

不具合は [Issues](https://github.com/NickYCLin/lattice-term/issues) へ。コードや翻訳の改善は[貢献ガイド](CONTRIBUTING.md)をご覧ください。ログや画像から認証情報、非公開ホスト、アカウント情報を取り除いてください。脆弱性は[セキュリティポリシー](SECURITY.md)に従い、非公開で報告してください。

[商標について](TRADEMARKS.md)

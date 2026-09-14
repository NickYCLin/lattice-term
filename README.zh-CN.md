# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

**在一个桌面工作区中管理 AI 助手和远程连接。**

使用你熟悉的 AI 助手编写代码、检查修改或整理资料。LatticeTerm 按项目组织不同助手的会话和远程连接，方便切换工具、继续之前的工作。

桌面核心采用 [MPL-2.0 许可证](LICENSE)，支持 Windows、macOS 和 Linux。

## 功能

- **Agent Fleet**：在独立终端中运行本地 AI CLI，按项目和文件夹整理会话。
- **聊天**：通过消息、附件和工具结果卡片与 Codex、Claude Code 或 Gemini CLI 交互。支持的功能因工具而异。
- **远程连接**：管理 SSH、SFTP 和 SSH 隧道；通过 RDP、VNC 或 Lattice Remote 访问远程桌面。仅使用远程连接时不需要 AI CLI。
- **后台任务**：安排重复任务，并在返回工作区时查看结果。

界面提供繁体中文、英语、简体中文、日语、韩语、西班牙语、法语、德语和巴西葡萄牙语；尚未翻译的新文本会显示为英语。

## 下载

在[最新发行版](https://github.com/NickYCLin/lattice-term/releases/latest)的 Assets 中选择安装包：Windows x64 使用 `_x64-setup.exe`，Apple Silicon Mac 使用 `_aarch64.dmg`，Intel Mac 使用 `_x64.dmg`。Linux 提供 x64 和 ARM64 的 DEB、RPM 与 AppImage。

项目仍处于公开测试阶段，主要面向桌面端，移动端功能较少。主分支可能包含尚未发布的功能，请以[发行说明](https://github.com/NickYCLin/lattice-term/releases)为准。

## 快速开始

先安装并登录一个受支持的 AI CLI，无需另外注册 LatticeTerm 账号。模型订阅和 API 费用由你使用的服务商收取。

1. 打开 **AI Agent Fleet**，选择已检测到的助手；如果没有检测到，可从工具卡片查看安装说明。
2. 创建空文件夹，将 [project-notes.md](examples/first-session/project-notes.md) 保存进去，然后选择该文件夹作为工作目录并启动助手。
3. 等待输入提示出现，再发送：「阅读 project-notes.md，按优先级列出三个任务，并为每项任务说明可观察的验收条件。请用简体中文回答，暂时不要修改文件。」

仅使用 SSH 或 SFTP 时，直接打开连接页面即可。

## 限制与数据

工作区设置和对话的本地副本保存在你的电脑上。CLI 和模型服务商可能接收任务所需的提示及文件内容。

SSH Fleet 通过 MCP 提供远程工作区编排，需要单独授权，并使用多个独立 PTY。Lattice Remote 的单终端分享不等于远程多 Agent Fleet；通过 Relay 进行 Fleet 编排仍未完成。目前不提供托管团队服务。

## 文档与贡献

本页为简要介绍。[英文 README](README.en.md) 提供更多说明，详细技术文档目前主要使用繁体中文：

- [功能与限制](docs/FEATURES.zh-TW.md)
- [开发与验证](docs/DEVELOPMENT.zh-TW.md)
- [文档索引](docs/README.md)

欢迎通过 [Issues](https://github.com/NickYCLin/lattice-term/issues) 反馈问题，或按[贡献指南](CONTRIBUTING.md)改进代码与翻译。提交日志和截图前，请移除凭据、私人主机地址及账号资料。安全漏洞请按[安全政策](SECURITY.md)私下报告。

[商标说明](TRADEMARKS.md)

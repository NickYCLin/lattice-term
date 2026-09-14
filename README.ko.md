# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

**AI 도우미와 원격 연결을 하나의 데스크톱 작업 공간에서 관리하세요.**

익숙한 AI 도우미로 코드를 작성하고, 변경 사항을 검토하고, 자료를 정리할 수 있습니다. LatticeTerm은 여러 도우미의 세션과 원격 연결을 프로젝트별로 모아 도구를 전환하거나 작업을 이어가기 쉽게 해 줍니다.

데스크톱 코어는 [MPL-2.0](LICENSE) 라이선스의 오픈 소스이며 Windows, macOS, Linux를 지원합니다.

## 주요 기능

- **Agent Fleet**: 로컬 AI CLI를 각각 독립된 터미널에서 실행하고, 프로젝트와 폴더별로 세션을 정리합니다.
- **채팅**: Codex, Claude Code, Gemini CLI에서 메시지, 첨부 파일, 도구 실행 결과를 다룹니다. 지원 기능은 도구마다 다릅니다.
- **원격 연결**: SSH, SFTP, SSH 터널을 관리하고 RDP, VNC, Lattice Remote로 원격 데스크톱에 접속합니다. 원격 연결만 사용할 때는 AI CLI가 필요하지 않습니다.
- **예약 작업**: 반복 작업을 예약하고 작업 공간에 돌아와 결과를 확인합니다.

화면 언어는 중국어 번체, 영어, 중국어 간체, 일본어, 한국어, 스페인어, 프랑스어, 독일어, 브라질 포르투갈어를 제공합니다. 아직 번역되지 않은 새 문구는 영어로 표시됩니다.

## 다운로드

[최신 릴리스](https://github.com/NickYCLin/lattice-term/releases/latest)의 Assets에서 설치 파일을 선택하세요. Windows x64는 `_x64-setup.exe`, Apple Silicon Mac은 `_aarch64.dmg`, Intel Mac은 `_x64.dmg`입니다. Linux는 x64와 ARM64용 DEB, RPM, AppImage를 제공합니다.

현재 공개 베타이며 데스크톱을 중심으로 개발하고 있습니다. 모바일 버전은 기능이 더 제한적입니다. main 브랜치에는 미출시 기능이 포함될 수 있으므로 [릴리스 노트](https://github.com/NickYCLin/lattice-term/releases)를 확인하세요.

## 시작하기

지원하는 AI CLI 하나를 설치하고 로그인해 두세요. 별도의 LatticeTerm 계정은 필요하지 않습니다. 모델 구독료와 API 사용료는 이용하는 서비스 제공업체에서 청구합니다.

1. **AI Agent Fleet**을 열고 감지된 도우미를 선택합니다. 도구가 보이지 않으면 해당 카드에서 설치 안내를 확인합니다.
2. 빈 폴더에 [project-notes.md](examples/first-session/project-notes.md)를 저장한 뒤, 그 폴더를 작업 디렉터리로 선택하고 도우미를 시작합니다.
3. 입력 프롬프트가 나타나면 요청합니다. “project-notes.md를 읽고 세 가지 작업을 우선순위대로 나열해 주세요. 각 작업의 완료 여부를 확인할 방법도 설명해 주세요. 한국어로 답하고 아직 파일은 수정하지 마세요.”

SSH나 SFTP만 사용하려면 연결 화면에서 바로 시작하면 됩니다.

## 제한 사항과 데이터

작업 공간 설정과 대화의 로컬 사본은 사용자 컴퓨터에 저장됩니다. CLI와 모델 제공업체는 작업에 필요한 프롬프트와 파일 내용을 받을 수 있습니다.

SSH Fleet은 MCP를 통해 원격 작업 공간을 관리하며 별도의 권한 부여와 여러 독립 PTY를 사용합니다. Lattice Remote의 단일 터미널 공유만으로 원격 다중 에이전트 Fleet이 완성되는 것은 아닙니다. Relay를 통한 Fleet은 아직 완성되지 않았으며, 호스팅형 팀 서비스도 현재 제공하지 않습니다.

## 문서와 기여

이 페이지는 간략한 소개입니다. 더 자세한 소개는 [영문 README](README.en.md)를 참고하세요. 상세 기술 문서는 주로 중국어 번체로 작성되어 있습니다.

- [기능과 제한 사항](docs/FEATURES.zh-TW.md)
- [개발과 검증](docs/DEVELOPMENT.zh-TW.md)
- [문서 목록](docs/README.md)

버그는 [Issues](https://github.com/NickYCLin/lattice-term/issues)에 알려 주세요. 코드와 번역 기여는 [기여 안내](CONTRIBUTING.md)를 참고하세요. 로그와 스크린샷에서 인증 정보, 비공개 호스트 주소, 계정 정보를 제거해 주세요. 보안 취약점은 [보안 정책](SECURITY.md)에 따라 비공개로 신고하세요.

[상표 안내](TRADEMARKS.md)

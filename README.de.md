# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · **Deutsch** · [Português (Brasil)](README.pt-BR.md)

**KI-Assistenten und Remote-Verbindungen in einem gemeinsamen Arbeitsbereich.**

Nutze deine gewohnten KI-Assistenten, um Code zu schreiben, Änderungen zu prüfen oder Informationen zu ordnen. LatticeTerm bündelt ihre Sitzungen und deine Remote-Verbindungen nach Projekt. So kannst du zwischen Werkzeugen wechseln und deine Arbeit fortsetzen.

Der Desktop-Kern ist Open Source unter [MPL-2.0](LICENSE) und läuft auf Windows, macOS und Linux.

## Funktionen

- **Agent Fleet**: Führe lokale KI-Kommandozeilenprogramme (CLIs) in getrennten Terminals aus und ordne die Sitzungen in Projekten und Ordnern.
- **Chat**: Arbeite mit Nachrichten, Anhängen und Werkzeugergebnissen über Codex, Claude Code oder Gemini CLI. Der Funktionsumfang hängt vom jeweiligen Werkzeug ab.
- **Remote-Verbindungen**: Verwalte SSH, SFTP und SSH-Tunnel. Greife über RDP, VNC oder Lattice Remote auf entfernte Desktops zu. Für diese Verbindungen brauchst du keine KI-CLI.
- **Geplante Aufgaben**: Plane wiederkehrende Aufgaben und sieh dir die Ergebnisse bei deiner Rückkehr an.

Die Oberfläche bietet traditionelles Chinesisch, Englisch, vereinfachtes Chinesisch, Japanisch, Koreanisch, Spanisch, Französisch, Deutsch und brasilianisches Portugiesisch. Noch nicht übersetzte neue Texte erscheinen auf Englisch.

## Download

Wähle unter Assets der [neuesten Version](https://github.com/NickYCLin/lattice-term/releases/latest) die passende Datei: `_x64-setup.exe` für Windows x64, `_aarch64.dmg` für Macs mit Apple Silicon oder `_x64.dmg` für Intel-Macs. Für Linux gibt es DEB, RPM und AppImage für x64 und ARM64.

Das Projekt befindet sich in der öffentlichen Beta und konzentriert sich auf den Desktop. Mobile Versionen bieten weniger Funktionen. Der main-Branch kann unveröffentlichte Änderungen enthalten. Maßgeblich sind die [Versionshinweise](https://github.com/NickYCLin/lattice-term/releases).

## Erste Schritte

Installiere eine unterstützte KI-CLI und melde dich dort an. Ein zusätzliches LatticeTerm-Konto ist nicht nötig. Modellabonnements und API-Nutzung werden über deinen jeweiligen Anbieter abgerechnet.

1. Öffne **AI Agent Fleet** und wähle einen erkannten Assistenten. Fehlt ein Werkzeug, findest du die Installationshinweise auf seiner Karte.
2. Erstelle einen leeren Ordner und speichere [project-notes.md](examples/first-session/project-notes.md) darin. Wähle ihn als Arbeitsverzeichnis und starte den Assistenten.
3. Sobald die Eingabeaufforderung erscheint, sende: „Lies project-notes.md und ordne die drei Aufgaben nach Priorität. Beschreibe für jede Aufgabe, wie sich ihre Erledigung überprüfen lässt. Antworte auf Deutsch und ändere noch keine Dateien.“

Wenn du nur SSH oder SFTP benötigst, öffne direkt die Verbindungsübersicht.

## Grenzen und Daten

Die Einstellungen des Arbeitsbereichs und eine lokale Kopie der Gespräche bleiben auf deinem Computer. Die CLI und der Modellanbieter können Anweisungen und Dateiinhalte erhalten, die für die Aufgabe benötigt werden.

SSH Fleet steuert entfernte Arbeitsbereiche über MCP mit eigener Berechtigung und mehreren unabhängigen PTYs. Die Freigabe eines einzelnen Terminals über Lattice Remote ist noch keine Orchestrierung mehrerer entfernter Agenten. [Fleet über Relay](docs/RELAY_FLEET.zh-TW.md) bietet MCP-Anbindung im Entwicklungsbranch; die Abnahme auf externen Hosts und mit der installierten Anwendung steht noch aus. Entfernte Fleet-Panels sind nicht enthalten. Ein gehosteter Teamdienst wird derzeit nicht angeboten.

## Dokumentation und Mitarbeit

Diese Seite ist eine Kurzvorstellung. Weitere Informationen stehen im [englischen README](README.en.md). Die technischen Anleitungen sind überwiegend auf traditionellem Chinesisch:

- [Funktionen und Einschränkungen](docs/FEATURES.zh-TW.md)
- [Entwicklung und Prüfung](docs/DEVELOPMENT.zh-TW.md)
- [Dokumentationsübersicht](docs/README.md)

Melde Fehler unter [Issues](https://github.com/NickYCLin/lattice-term/issues). Für Code und Übersetzungen beachte die [Beitragshinweise](CONTRIBUTING.md). Entferne Zugangsdaten, private Hostadressen und Kontoinformationen aus Protokollen und Screenshots. Melde Sicherheitslücken vertraulich gemäß der [Sicherheitsrichtlinie](SECURITY.md).

[Marken](TRADEMARKS.md)

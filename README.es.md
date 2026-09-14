# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español** · [Français](README.fr.md) · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

**Tus asistentes de IA y conexiones remotas, en un solo espacio de trabajo.**

Usa tus asistentes habituales para escribir código, revisar cambios u organizar información. LatticeTerm reúne sus sesiones y tus conexiones remotas por proyecto para que puedas cambiar de herramienta y retomar el trabajo.

El núcleo de escritorio es de código abierto bajo la licencia [MPL-2.0](LICENSE), para Windows, macOS y Linux.

## Funciones

- **Agent Fleet**: ejecuta herramientas de IA de línea de comandos (CLI) locales en terminales independientes y organiza las sesiones en proyectos y carpetas.
- **Chat**: trabaja con mensajes, archivos adjuntos y resultados de herramientas mediante Codex, Claude Code o Gemini CLI. Las funciones disponibles dependen de cada herramienta.
- **Conexiones remotas**: administra SSH, SFTP y túneles SSH; accede a escritorios mediante RDP, VNC o Lattice Remote. No necesitas una CLI de IA para usar las conexiones.
- **Tareas programadas**: programa trabajo recurrente y consulta los resultados al volver.

La interfaz está disponible en chino tradicional, inglés, chino simplificado, japonés, coreano, español, francés, alemán y portugués de Brasil. Los textos nuevos sin traducir se muestran en inglés.

## Descarga

Elige un instalador en Assets de la [última versión](https://github.com/NickYCLin/lattice-term/releases/latest): `_x64-setup.exe` para Windows x64, `_aarch64.dmg` para Mac con Apple Silicon o `_x64.dmg` para Mac con Intel. Linux dispone de DEB, RPM y AppImage para x64 y ARM64.

El proyecto está en beta pública y se centra en el escritorio. Las versiones móviles tienen menos funciones. La rama main puede incluir cambios aún no publicados; consulta las [notas de versión](https://github.com/NickYCLin/lattice-term/releases).

## Primeros pasos

Instala una CLI de IA compatible e inicia sesión en ella. No necesitas una cuenta adicional de LatticeTerm. Las suscripciones a modelos y el uso de API se cobran a través de tu proveedor.

1. Abre **AI Agent Fleet** y elige un asistente detectado. Si falta una herramienta, su tarjeta incluye instrucciones de instalación.
2. Crea una carpeta vacía, guarda [project-notes.md](examples/first-session/project-notes.md) en ella y selecciónala como directorio de trabajo al iniciar el asistente.
3. Cuando aparezca el indicador de entrada, envía: «Lee project-notes.md y ordena las tres tareas por prioridad. Explica cómo comprobar que cada una se ha completado. Responde en español y no modifiques archivos todavía».

Para usar solo SSH o SFTP, ve directamente a la pantalla de conexiones.

## Límites y datos

La configuración del espacio de trabajo y una copia local de las conversaciones se guardan en tu equipo. La CLI y el proveedor del modelo pueden recibir las instrucciones y los archivos necesarios para la tarea.

SSH Fleet permite coordinar espacios de trabajo remotos mediante MCP, con autorización independiente y varios PTY separados. Compartir un único terminal con Lattice Remote no equivale a coordinar varios agentes remotos. Fleet a través de Relay aún no está completo. Actualmente no se ofrece un servicio alojado para equipos.

## Documentación y contribuciones

Esta página es una introducción breve. El [README en inglés](README.en.md) ofrece más detalles; las guías técnicas están principalmente en chino tradicional:

- [Funciones y limitaciones](docs/FEATURES.zh-TW.md)
- [Desarrollo y verificación](docs/DEVELOPMENT.zh-TW.md)
- [Índice de documentación](docs/README.md)

Comunica errores en [Issues](https://github.com/NickYCLin/lattice-term/issues) y consulta la [guía de contribución](CONTRIBUTING.md) para mejorar el código o las traducciones. Elimina credenciales, direcciones de hosts privados y datos de cuentas de los registros y las capturas. Informa de vulnerabilidades de forma privada según la [política de seguridad](SECURITY.md).

[Marcas](TRADEMARKS.md)

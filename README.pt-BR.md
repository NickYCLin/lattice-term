# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · **Português (Brasil)**

**Seus assistentes de IA e conexões remotas em um só espaço de trabalho.**

Use seus assistentes habituais para escrever código, revisar alterações ou organizar informações. O LatticeTerm reúne as sessões e conexões remotas por projeto, facilitando a troca de ferramentas e a retomada do trabalho.

O núcleo do aplicativo para desktop é de código aberto sob a licença [MPL-2.0](LICENSE), para Windows, macOS e Linux.

## Recursos

- **Agent Fleet**: execute ferramentas locais de IA de linha de comando (CLIs) em terminais independentes e organize as sessões por projeto e pasta.
- **Chat**: use mensagens, anexos e resultados de ferramentas com Codex, Claude Code ou Gemini CLI. Os recursos disponíveis variam conforme a ferramenta.
- **Conexões remotas**: gerencie SSH, SFTP e túneis SSH; acesse desktops remotos com RDP, VNC ou Lattice Remote. Não é preciso ter uma CLI de IA para usar as conexões.
- **Tarefas agendadas**: programe atividades recorrentes e consulte os resultados quando voltar.

A interface oferece chinês tradicional, inglês, chinês simplificado, japonês, coreano, espanhol, francês, alemão e português do Brasil. Novos textos ainda sem tradução aparecem em inglês.

## Download

Escolha um instalador em Assets da [versão mais recente](https://github.com/NickYCLin/lattice-term/releases/latest): `_x64-setup.exe` para Windows x64, `_aarch64.dmg` para Mac com Apple Silicon ou `_x64.dmg` para Mac com Intel. No Linux, há pacotes DEB, RPM e AppImage para x64 e ARM64.

O projeto está em beta público, com foco no desktop. As versões móveis têm menos recursos. A branch main pode incluir alterações ainda não publicadas; consulte as [notas de versão](https://github.com/NickYCLin/lattice-term/releases).

## Primeiros passos

Instale uma CLI de IA compatível e faça login nela. Não é necessário criar uma conta separada no LatticeTerm. Assinaturas de modelos e cobranças de API ficam com o provedor que você usa.

1. Abra **AI Agent Fleet** e escolha um assistente detectado. Se uma ferramenta não aparecer, o cartão dela oferece instruções de instalação.
2. Crie uma pasta vazia e salve [project-notes.md](examples/first-session/project-notes.md) nela. Escolha essa pasta como diretório de trabalho e inicie o assistente.
3. Quando o campo de entrada estiver pronto, envie: “Leia project-notes.md e liste as três tarefas por prioridade. Descreva como verificar a conclusão de cada uma. Responda em português do Brasil e não altere arquivos ainda.”

Para usar apenas SSH ou SFTP, vá direto à tela de conexões.

## Limites e dados

As configurações do espaço de trabalho e uma cópia local das conversas ficam no seu computador. A CLI e o provedor do modelo podem receber as instruções e o conteúdo dos arquivos necessários para a tarefa.

O SSH Fleet coordena espaços de trabalho remotos via MCP, com autorização própria e vários PTYs independentes. Compartilhar um único terminal pelo Lattice Remote não equivale a orquestrar vários agentes remotos. O Fleet via Relay ainda não está completo. No momento, não há serviço hospedado para equipes.

## Documentação e contribuições

Esta página é uma apresentação resumida. O [README em inglês](README.en.md) traz mais detalhes; os guias técnicos estão principalmente em chinês tradicional:

- [Recursos e limitações](docs/FEATURES.zh-TW.md)
- [Desenvolvimento e verificação](docs/DEVELOPMENT.zh-TW.md)
- [Índice da documentação](docs/README.md)

Relate problemas em [Issues](https://github.com/NickYCLin/lattice-term/issues) e consulte o [guia de contribuição](CONTRIBUTING.md) para melhorar o código ou as traduções. Remova credenciais, endereços de hosts privados e dados de contas dos logs e capturas de tela. Informe vulnerabilidades em particular, seguindo a [política de segurança](SECURITY.md).

[Marcas](TRADEMARKS.md)

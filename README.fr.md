# LatticeTerm

[繁體中文](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · **Français** · [Deutsch](README.de.md) · [Português (Brasil)](README.pt-BR.md)

**Vos assistants IA et vos connexions distantes dans un même espace de travail.**

Utilisez vos assistants habituels pour écrire du code, vérifier des modifications ou organiser des informations. LatticeTerm rassemble leurs sessions et vos connexions distantes par projet, pour changer d’outil et reprendre votre travail facilement.

Le cœur de l’application de bureau est open source sous licence [MPL-2.0](LICENSE), pour Windows, macOS et Linux.

## Fonctionnalités

- **Agent Fleet** : lancez vos outils IA locaux en ligne de commande (CLI) dans des terminaux indépendants et classez les sessions par projet et dossier.
- **Chat** : utilisez des messages, des pièces jointes et des résultats d’outils avec Codex, Claude Code ou Gemini CLI. Les fonctions disponibles varient selon l’outil.
- **Connexions distantes** : gérez SSH, SFTP et les tunnels SSH ; accédez aux bureaux distants avec RDP, VNC ou Lattice Remote. Ces connexions ne nécessitent pas de CLI d’IA.
- **Tâches planifiées** : programmez les tâches récurrentes et consultez les résultats à votre retour.

L’interface propose le chinois traditionnel, l’anglais, le chinois simplifié, le japonais, le coréen, l’espagnol, le français, l’allemand et le portugais du Brésil. Les nouveaux textes non traduits s’affichent en anglais.

## Téléchargement

Choisissez un fichier dans Assets de la [dernière version](https://github.com/NickYCLin/lattice-term/releases/latest) : `_x64-setup.exe` pour Windows x64, `_aarch64.dmg` pour Mac avec Apple Silicon ou `_x64.dmg` pour Mac avec Intel. Linux dispose de paquets DEB, RPM et AppImage pour x64 et ARM64.

Le projet est en bêta publique, avec une priorité donnée au bureau. Les versions mobiles proposent moins de fonctions. La branche main peut contenir des nouveautés non publiées ; consultez les [notes de version](https://github.com/NickYCLin/lattice-term/releases).

## Bien démarrer

Installez une CLI d’IA compatible et connectez-vous à votre compte dans cet outil. Aucun compte LatticeTerm supplémentaire n’est nécessaire. Les abonnements aux modèles et les frais d’API restent facturés par votre fournisseur.

1. Ouvrez **AI Agent Fleet** et choisissez un assistant détecté. Si un outil manque, sa fiche propose les instructions d’installation.
2. Créez un dossier vide, enregistrez-y [project-notes.md](examples/first-session/project-notes.md), puis sélectionnez ce dossier comme répertoire de travail et lancez l’assistant.
3. Une fois l’invite de saisie affichée, demandez : « Lis project-notes.md et classe les trois tâches par priorité. Explique comment vérifier que chacune est terminée. Réponds en français et ne modifie aucun fichier pour le moment. »

Pour utiliser uniquement SSH ou SFTP, ouvrez directement l’écran des connexions.

## Limites et données

Les paramètres de l’espace de travail et une copie locale des conversations restent sur votre ordinateur. La CLI et le fournisseur du modèle peuvent recevoir les instructions et le contenu des fichiers nécessaires à la tâche.

SSH Fleet permet de coordonner des espaces de travail distants via MCP, avec une autorisation distincte et plusieurs PTY indépendants. Le partage d’un seul terminal avec Lattice Remote ne constitue pas une orchestration de plusieurs agents distants. Fleet via Relay n’est pas encore terminé. Aucun service hébergé pour les équipes n’est actuellement proposé.

## Documentation et contributions

Cette page est une présentation abrégée. Le [README anglais](README.en.md) fournit plus de détails ; les guides techniques sont principalement en chinois traditionnel :

- [Fonctionnalités et limites](docs/FEATURES.zh-TW.md)
- [Développement et vérification](docs/DEVELOPMENT.zh-TW.md)
- [Index de la documentation](docs/README.md)

Signalez les problèmes dans les [Issues](https://github.com/NickYCLin/lattice-term/issues) et consultez le [guide de contribution](CONTRIBUTING.md) pour le code ou les traductions. Retirez les identifiants, les adresses d’hôtes privés et les données de compte des journaux et captures. Signalez les vulnérabilités en privé selon la [politique de sécurité](SECURITY.md).

[Marques](TRADEMARKS.md)

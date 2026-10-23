# Proposition de dépôt pour l’évaluation

Le sujet demande deux programmes fonctionnels, une démo reproductible sur Ubuntu, une courte architecture et des preuves. L’évaluateur doit pouvoir trouver ces quatre éléments depuis le README, sans lire le journal de développement.

## Parcours proposé

1. **Comprendre en une minute** : résultat obtenu, schéma du flux, état réel de validation.
2. **Voir le produit** : vidéo identifiée comme simulation et aperçu local sans matériel.
3. **Reproduire le vrai provisioning** : prérequis, préparation Ubuntu, installation du configurateur, résultat attendu.
4. **Vérifier les quatre contraintes** : une table avec un lien vers chaque preuve et ses limites.
5. **Approfondir** : choix du canal, sécurité, déploiement de 200 appareils, puis code et tests.

Le [README](../../README.md) présente désormais le projet dans un format hackathon, avec logo et démos mobile et desktop. Le [guide de préparation et d’évaluation](../SETUP.md) contient les instructions détaillées. Les liens utilisent les chemins actuels avant tout déplacement.

## Arborescence cible

```text
iot-provisioning/
├── README.md                     # entrée unique : comprendre, lancer, vérifier
├── Cargo.toml / Cargo.lock        # service et outils Rust
├── rust-toolchain.toml
├── configurator/                  # application provide. : iPhone et desktop
│   ├── README.md                  # installation et commandes propres à l’application
│   ├── App.tsx
│   ├── src/                      # écrans, protocole, adaptateurs, tests TypeScript
│   └── desktop/src-tauri/         # coque desktop et pont Bluetooth Rust
├── device/                        # service Linux, NetworkManager, outils de préparation
│   └── systemd/                   # installation, service et permissions
├── src/                           # bibliothèque Rust : protocole et sécurité
├── tests/                         # tests d’intégration Rust et fixtures
├── examples/                      # simulation et benchmark en ligne de commande
├── lab/                           # banc BLE avec capteurs simulés, Wi-Fi simulé
├── docs/
│   ├── ARCHITECTURE.md             # canal, flux, compromis et scénario de 200 appareils
│   ├── SECURITY.md                 # protocole, stockage, menaces et limites
│   ├── EVALUATION.md               # exigences → preuves → limites, état daté
│   ├── DECISIONS.md                # décisions détaillées, lecture facultative
│   ├── BENCHMARKS.md               # méthode et mesures, nature des simulations
│   ├── assets/                    # images et vidéos référencées par la documentation
│   └── development/               # plans, handoffs, audits et documents historiques
└── evidence/
    ├── README.md                  # preuves sélectionnées, environnement, date, portée
    ├── real/                      # BLE réel, activation NetworkManager, logs expurgés
    ├── simulation/                # exécutions simulées et limites du banc
    ├── checks/                    # résultats de tests, captures de validation UI
    └── tools/                     # scripts qui produisent ou vérifient ces preuves
```

Les fichiers de configuration usuels et les ressources de l’application sont omis du schéma. Aucun nouveau niveau `apps/`, `packages/` ou `services/` : déplacer le code Rust ou Expo n’aide pas l’évaluateur et impose de retoucher les builds. Les tests TypeScript restent près des modules qu’ils vérifient.

## Déplacements et rédaction à appliquer

| Aujourd’hui | Cible | Traitement |
| --- | --- | --- |
| `README.md` | `README.md` | Remplacer par la version proposée après relecture. |
| `docs/EVALUATION.md` | `docs/EVALUATION.md` | Réécrire et dater : l’état actuel décrit encore des validations de l’ancien protocole. |
| `evidence/real/identity-advertisement.txt` | `evidence/real/identity-advertisement.txt` | Preuve du protocole actuel sur Mac et matériel Linux. |
| `evidence/real/real-join.txt`, `real-reconfigure.txt`, `phone-hello.txt`, `service-offline-hello.txt` | `evidence/real/` | Conserver la mention explicite « ancien protocole » quand elle s’applique. |
| Autres fichiers de `evidence/` | `evidence/simulation/`, `checks/` ou `tools/` | Trier selon ce que le fichier démontre ; ne pas classer une fixture comme preuve matérielle. |
| `docs/assets/architecture/`, `docs/assets/configurator/` | `docs/assets/` | Regrouper les médias, conserver les légendes et le contexte des captures. |
| `evidence/checks/desktop/` | `evidence/checks/desktop/` | Garder les résultats de playtest et leurs captures ensemble. |
| `docs/development/`, `docs/development/DESKTOP_SPEC.md`, `docs/development/REVIEW.md` | `docs/development/` | Historique et spécification desktop, hors parcours principal. |
| `docs/development/archive/rapport-solution.pdf`, `docs/development/archive/report/`, `docs/development/archive/architecture-demo.html` | `docs/development/archive/` | Marquer comme historiques ; ils ne décrivent pas tous le produit actuel. |
| `configurator/README.md` | même chemin | Remplacer l’introduction « hello probe only », conserver les commandes iPhone utiles, documenter le desktop et ses limites. |

Avant de déplacer un fichier, rechercher ses références dans les Markdown, scripts, générateurs et tests. Mettre à jour tous les chemins concernés dans le même changement. Les dossiers générés (`target/`, `node_modules/`, builds iOS et bundles desktop) restent ignorés. Le PDF du sujet, les clés, les codes technicien et les états privés restent hors de la soumission Git.

## Corrections de fond nécessaires

- **Mettre la preuve actuelle en premier.** Le fichier `evidence/real/identity-advertisement.txt` rapporte un provisioning réel Mac → appareil Linux le 23 octobre 2026. Le README actuel indique encore que le protocole courant n’a pas été exécuté sur matériel.
- **Décrire précisément Ubuntu.** Le service Linux a été validé sur Ubuntu 22.04 ; l’exécution du configurateur desktop Linux reste à valider. Le parcours matériel documenté utilise donc un iPhone préparé à l’avance ou le configurateur macOS. Un aperçu navigateur sur Ubuntu ne remplace pas cette démo.
- **Documenter les deux clés publiques.** Une nouvelle autorité impose de remplacer `DEVICE_AUTHORITY` et `TECHNICIAN_AUTHORITY` dans le configurateur, puis de le reconstruire. Modifier seulement la première empêche l’import du code technicien.
- **Séparer les types de preuve.** Une vidéo de 200 capteurs simulés démontre l’interface ; elle ne prouve ni 200 équipements physiques, ni 200 connexions Wi-Fi réelles. Le banc BLE simule aussi l’activation Wi-Fi.
- **Décrire le stockage actuel.** L’iPhone utilise le stockage sécurisé natif ; le desktop garde actuellement les secrets en mémoire et les perd à la fermeture. Le pont vers le trousseau système est prévu mais absent.
- **Réduire les promesses.** Android, les exécutions desktop Windows/Linux et les erreurs Wi-Fi sur matériel doivent rester indiqués comme non validés. Les compteurs de tests périmés sont à retirer plutôt qu’à recopier.
- **Raccourcir l’architecture.** Garder en tête le canal et ses compromis, la protection des identifiants, puis le scénario de 200 appareils. Déplacer le récit chronologique vers les documents de développement.

## État de cette proposition

La présentation du README a été appliquée à la demande de l’utilisateur ; ses instructions détaillées sont conservées dans `docs/SETUP.md`. Les déplacements de l’arborescence restent une proposition. Après migration, les liens devront suivre la table ci-dessus. Les commandes ont été comparées aux sources et aux configurations, sans nouvelle installation Ubuntu ni nouvelle exécution matérielle.

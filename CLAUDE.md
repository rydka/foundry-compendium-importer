# Compendium JSON Importer (`compendium-json-importer`)

Module Foundry VTT de l'atelier (voir le `CLAUDE.md` de l'atelier, deux niveaux au-dessus, pour les règles communes). Ce fichier fait foi pour ce module.

## Objectif

Importe des entrées de compendium depuis des fichiers .json ou .db (export Foundry, NeDB ligne par ligne, tableaux de documents), vers un compendium existant ou nouveau. Les scripts de `tools/` (extraction depuis PDF) sont hors du module Foundry et ne sont pas chargés par lui.

## Cibles

Foundry v14, dnd5e 6.x. Toute API utilisée doit exister dans ces versions. Consulter les sources en lecture seule :
- Foundry : `C:/Users/Shadow/AppData/Local/Programs/Foundry Virtual Tabletop/resources/app`
- dnd5e : `C:/Users/Shadow/AppData/Local/FoundryVTT/Data/systems/dnd5e`

## Structure

| Chemin | Contenu |
|---|---|
| `module.json` | Manifeste. `version` est réécrite par le workflow de release. |
| `scripts/main.mjs` | Point d'entrée : hooks `init` et `ready` |
| `styles/compendium-json-importer.css` | Styles, tous sous la classe `.compendium-json-importer` |
| `lang/` | Traductions `en` et `fr`, clés sous `compendium-json-importer.*` |
| `templates/` | Templates Handlebars |
| `tests/unit/` | Tests Vitest avec les faux globaux Foundry de `tests/setup/` |
| `tests/integration/` | Tests dans un vrai Foundry, servent de preuve de fonctionnement |

## Conventions

- Tout ce que le module ajoute est préfixé par l'identifiant `compendium-json-importer` : réglages, flags, sockets, clés de traduction, classes CSS, hooks personnalisés (`compendium-json-importer.<nom>`).
- Pas de modification directe des prototypes de Foundry ou de dnd5e. Préférer les hooks et l'API publique. Si c'est impossible, le documenter ici dans « Points de contact avec d'autres modules ».
- Toute logique testable est exportée depuis un fichier sans effet de bord à l'import (sauf l'enregistrement de hooks dans `main.mjs`).

## Commandes

```
npm install
npm test
npm run lint
```

## Points de contact avec d'autres modules

Liste maintenue par le développeur et lue par le vérificateur : hooks écoutés, méthodes remplacées, sélecteurs CSS globaux, modules tiers détectés ou adaptés.

- Hook `renderCompendiumDirectory` : ajoute le bouton `.cji-open-importer` dans `.directory-header .header-actions` (MJ seulement). dnd5e ajoute aussi ses boutons dans ce conteneur.
- `game.settings.registerMenu` (menu restreint ouvrant `ImporterApp`).
- Sélecteurs CSS globaux : seulement `.compendium-json-importer` et `.cji-open-importer`.

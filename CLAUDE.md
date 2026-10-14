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
| `scripts/main.mjs` | Point d'entrée : hooks `init` et `ready` (réglages, menu, bouton, API `game.modules.get(id).api`) |
| `scripts/constants.mjs` | `MODULE_ID`, clés de réglages, taille de lot, filtres de type |
| `scripts/core/` | Fonctions pures sans global Foundry (lint : `globals` vide) : `parse`, `normalize`, `ids`, `matching`, `naming`, `conformity`, `batch` ; `enrich/` : `enrich.mjs` (`enrichEntry`, le parseur est injecté : `isEmpty`, `isEmptyUtility`, `mergeMissing`, `nameKey` viennent de la bibliothèque), `compendium.mjs` (clés de recherche, ordre des sources, `adjustToFacts`) |
| `scripts/foundry/` | Couche Foundry : `importer-app` (fenêtre `ImporterApp`), `validator` (contrôle et migration en mémoire), `import-runner` (écritures), `directory-button`, `settings`, `enrichment` (chargement de la bibliothèque, lecture des packs), `enrich-summary` (`describeReport`, descripteurs `{ key, data, group, raw, origin, paths }` du parseur), `sources-app` (menu des sources) |
| `styles/compendium-json-importer.css` | Styles, tous sous la classe `.compendium-json-importer` |
| `lang/` | Traductions `en` et `fr`, clés sous `compendium-json-importer.*` |
| `templates/importer/` | Parties Handlebars de la fenêtre (source, target, options, summary) |
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

- Hook `renderCompendiumDirectory` : ajoute le bouton `.cji-open-importer` dans `.directory-header .header-actions` (MJ seulement, partie `header`). dnd5e ajoute aussi ses boutons dans ce conteneur.
- `game.settings.registerMenu` (menu restreint ouvrant `ImporterApp`, ApplicationV2).
- Sélecteurs CSS globaux : seulement `.compendium-json-importer` et `.cji-open-importer`.
- dnd5e, appelés (jamais remplacés) : `dnd5e.migrations.getMigrationData()` une fois par analyse, puis `dnd5e.migrations.migrateActorData` / `migrateItemData` sur des instances de documents créées en mémoire (sans option `pack`, donc sans les hooks `dnd5e.initialize*Source`). Les types connus viennent de `CONFIG.Item.dataModels` / `CONFIG.Actor.dataModels`, ceux des activités de `CONFIG.DND5E.activityTypes` (lecture seule).
- Foundry, appelés : `CompendiumCollection.createCompendium` (création du pack), `pack.documentClass.createDocuments` (lots de 50, `keepId`, `keepEmbeddedIds`) , `pack.getDocuments({ _id__in })` (lecture des documents à écraser avant suppression) et `deleteDocuments` (écrasement). Si la création échoue après les suppressions, les documents supprimés sont recréés (`createDocuments`, mêmes options) à partir de leurs données lues. Ces écritures déclenchent les hooks `preCreate*` / `create*` / `delete*` des autres modules, uniquement après confirmation du MJ.
- Dépendance : module `dnd5e-text-parser` (`relationships.requires`, API 1.x). Importé à la demande par `import(getRoute("modules/dnd5e-text-parser/scripts/index.mjs"))` (`loadParser`) ; absent, inactif ou de majeure différente : l'importeur fonctionne sans enrichissement. Fonctions utilisées : `parseFeature`, `parseActor`, `toActivities`, `toItemPatch`, `toActorPatch`, `toSpellStubs`, `describe`, `mergeMissing`, `isEmpty`, `isEmptyUtility`, `nameKey`, `keysFromConfig`. Tests unitaires : le paquet local `file:../dnd5e-text-parser`.
- Lecture des compendiums (enrichissement des acteurs, seulement si la case est cochée) : `game.packs` (packs d'objets visibles), `pack.getIndex()` puis `pack.getDocuments({ _id__in })`, `game.items.fromCompendium(doc, { clearFolder: true })` (appelé sur un document de pack, aucune écriture). `game.settings.get("dnd5e", "rulesVersion")` choisit l'ordre par défaut des packs dnd5e.
- Réglage `compendiumSources` (client) et menu restreint `sources` (`SourcesApp`, ApplicationV2) : choix et ordre des compendiums consultés.
- API exposée : `game.modules.get("compendium-json-importer").api` = `{ open, analyze, runImport }` ; `analyze` accepte `{ enrich, compendiums }`.

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
| `scripts/core/` | Fonctions pures sans global Foundry (lint : `globals` vide) : `parse`, `normalize`, `ids`, `matching`, `naming`, `conformity`, `batch`, `challenge` (FP lu dans le texte d'un acteur) ; `enrich/` : `enrich.mjs` (`enrichEntry`, le parseur est injecté : `isEmpty`, `isEmptyUtility`, `mergeMissing`, `nameKey` viennent de la bibliothèque), `compendium.mjs` (clés de recherche, ordre des sources, `adjustToFacts`) ; `pdf/` : extraction d'un PDF à partir du modèle de page (voir ci-dessous) ; `ai/ollama.mjs` : client Ollama minimal (`fetch` injecté) |
| `scripts/core/pdf/` | `page-model` (contrat avec les tests : `{ number, width, height, items: [{ str, x0, x1, y, size, font }] }`), `fonts` (famille et style lus dans le nom de police, repli `inferEntryFont`), `layout` (colonnes, lignes, espaces, pieds de page), `lexicon` (libellés EN/FR 2014/2024 → clés dnd5e, d'après `reports/rules/pdf-import-lexicon.md` ; types d'objets magiques → types dnd5e), `stat-block` (détection et lecture d'un bloc par la mise en page), `stat-lines` (lignes de stats → valeurs), `creature` (bloc → source `npc` et objets `feat`/`weapon`), `magic-item` (en-tête d'objet → source d'objet), `extract` (orchestration, problèmes C4, file d'attente de l'IA, PDF scanné C7), `stable-id` (`_id` déterministes), `ai-block` (requête et validation de l'IA, C5) |
| `scripts/foundry/` | Couche Foundry : `importer-app` (fenêtre `ImporterApp`), `validator` (contrôle et migration en mémoire), `import-runner` (écritures), `directory-button`, `settings` (choix mémorisés, sources, réglages de l'IA locale et `aiConfig`), `enrichment` (chargement de la bibliothèque, lecture des packs), `enrich-summary` (`describeReport`, descripteurs `{ key, data, group, raw, origin, paths }` du parseur), `sources-app` (menu des sources), `pdf-reader` (pdf.js de Foundry dans un worker, polices résolues à la demande), `pdf-import` (lecture → extraction → IA → entrées du type de la cible, rapport), `pdf-ai` (file d'attente Ollama) |
| `styles/compendium-json-importer.css` | Styles, tous sous la classe `.compendium-json-importer` |
| `lang/` | Traductions `en` et `fr`, clés sous `compendium-json-importer.*` |
| `templates/importer/` | Parties Handlebars de la fenêtre (source, target, options repliables, summary avec la section « Lecture du PDF » en tête de la revue, footer : boutons, bouton « Annuler la lecture » d'un PDF et ligne de progression `.cji-status`, collé en bas du contenu qui défile) |
| `tools/` | Outil Python d'extraction depuis PDF, conservé mais plus nécessaire (l'import PDF est dans le module). `tools/*.pdf` et `tools/out/` sont ignorés par git |
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
- Foundry, appelés : `foundry.applications.handlebars.loadTemplates` au `init` (gabarits des deux fenêtres compilés d'avance), `CompendiumCollection.createCompendium` (création du pack), `pack.documentClass.createDocuments` (lots de 50, `keepId`, `keepEmbeddedIds`) , `pack.getDocuments({ _id__in })` (lecture des documents à écraser avant suppression) et `deleteDocuments` (écrasement). Si la création échoue après les suppressions, les documents supprimés sont recréés (`createDocuments`, mêmes options) à partir de leurs données lues. Ces écritures déclenchent les hooks `preCreate*` / `create*` / `delete*` des autres modules, uniquement après confirmation du MJ.
- Dépendance : module `dnd5e-text-parser` (`relationships.requires`, API 1.x). Importé à la demande par `import(getRoute("modules/dnd5e-text-parser/scripts/index.mjs"))` (`loadParser`) ; absent, inactif ou de majeure différente : l'importeur fonctionne sans enrichissement. Fonctions utilisées : `parseFeature`, `parseActor`, `toActivities`, `toItemPatch`, `toActorPatch`, `toEffects` (effet actif `transfer: true` d'une capacité passive, posé dans `item.effects` seulement si l'objet n'en a aucun, C26/C27), `toSpellStubs`, `describe`, `mergeMissing`, `isEmpty`, `isEmptyUtility`, `nameKey`, `keysFromConfig`. Tests unitaires : le paquet local `file:../dnd5e-text-parser`.
- Lecture des compendiums (enrichissement des acteurs, seulement si la case est cochée) : `game.packs` (packs d'objets visibles), `pack.getIndex()` puis `pack.getDocuments({ _id__in })`, `game.items.fromCompendium(doc, { clearFolder: true })` (appelé sur un document de pack, aucune écriture). `game.settings.get("dnd5e", "rulesVersion")` choisit l'ordre par défaut des packs dnd5e. Les index des sources sont lus en parallèle dès l'ouverture de la fenêtre (`preloadIndexes`) et gardés en mémoire tant que l'ordre des sources ne change pas ; le hook `updateCompendium` (contenu d'un pack modifié) vide ce cache. Aucune lecture si l'enrichissement ou la reprise depuis les compendiums est décochée.
- Réglage `compendiumSources` (portée `world`) et menu restreint `sources` (`SourcesApp`, ApplicationV2) : choix et ordre des compendiums consultés.
- API exposée : `game.modules.get("compendium-json-importer").api` = `{ open, analyze, runImport, readPdf, pdfWorkerCount }` ; `analyze` accepte `{ enrich, compendiums }` ; `readPdf(fichier | octets, { fileName, documentName, signal, onProgress, ai })` rend `{ entries, meta, report }`.
- **pdf.js de Foundry** (import PDF) : `import(getRoute("scripts/pdfjs/build/pdf.mjs"))`, servi par Foundry depuis `node_modules/@foundryvtt/pdfjs` (4.0.379 en 14.369). Ce n'est pas une API documentée : `loadPdfJs` contrôle `version` ≥ 4, `getDocument` et `PDFWorker`, sinon message « lecteur PDF indisponible ». Le document est ouvert dans un `Worker` créé par le module (`scripts/pdfjs/build/pdf.worker.mjs`, type `module`) et passé par `new PDFWorker({ port })` : `GlobalWorkerOptions` n'est jamais modifié. Options : `disableFontFace`, `useSystemFonts: false`, `maxImageSize: 0`, `isEvalSupported: false`, `verbosity: ERRORS`. Le worker est terminé à la fin ou à l'annulation (`api.pdfWorkerCount()` doit revenir à 0). Les noms réels des polices sont lus dans `page.commonObjs` après `getOperatorList()`, seulement sur les pages candidates.
- **`fetch` vers Ollama** (`localhost:11434` par défaut, réglages `ollamaUrl`, `ollamaModel`, `aiTimeout`, portée `world`) : seulement si le réglage `pdfAi` est vrai et qu'un bloc de statistiques n'a pas pu être lu par les règles. Lecture facultative des réglages `item-configurator.ollamaUrl` / `ollamaModel` quand ce module est actif (jamais d'import de son code). Aucun socket, aucun hook nouveau.
- Flags écrits sur les documents issus d'un PDF : `flags.compendium-json-importer.pdf = { source, page, readBy: "rules"|"ai", xp?, proficiencyBonus? }`. Les `_id` sont déterministes (`stable-id.mjs`) : empreinte de `page|nom|rang` (rang parmi les blocs ou objets de même nom sur la page), **sans le nom du fichier** : renommer le PDF garde les identifiants et un second import remplace au lieu de dupliquer ; deux livres différents qui ont la même créature à la même page donnent un conflit « remplacer » visible dans la revue.
- Écart signalé à la bibliothèque `dnd5e-text-parser` : son lexique d'objets ne connaît pas « courant(e) », « peu courant(e) », « rareté variable » ni « harmonisation requise » (SRD FR 2023 et 2024), et `toItemPatch` ne pose `system.type` que pour les consommables. `lexicon.mjs` (`itemHeaderAliases`, `itemTypes`) fait la correspondance côté importeur en attendant.

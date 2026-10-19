# Changelog

## 0.3.0

- Complétion des activités depuis le texte, avec la bibliothèque `dnd5e-text-parser` (nouvelle dépendance, API 1.x) : activités utilitaires vides converties en attaque, sauvegarde ou dégâts, usages et recharge, actions et résistances légendaires, résistances, immunités et vulnérabilités, incantation et emplacements de sorts. Les valeurs déjà présentes dans le fichier ne sont jamais remplacées.
- Éléments d'acteurs et sorts repris des compendiums (ordre et choix dans le menu « Sources de compendiums »), ajustés aux valeurs du fichier ; noms et description du fichier conservés (texte du PDF ajouté).
- Résumé détaillé de l'enrichissement dans la fenêtre : ce qui est repris, construit, ambigu, non reconnu.
- Fusion « champs vides » (`mergeMissing`) et comparaison de noms (`nameKey`) fournies par la bibliothèque ; les doubles locaux sont retirés.
- Un document non reconnu reste strictement identique à l'entrée ; l'ajustement d'un objet repris d'un compendium n'ajoute plus de cible de consommation quand rien ne change.
- Le lint ignore `.atelier/`.

## 0.2.0

- Compatible Foundry v14 et dnd5e 6.0.0 ou plus (vérifié avec 6.0.6). Plus compatible avec v13.
- Une seule fenêtre remplace les trois anciens importeurs ; elle s'ouvre depuis un bouton « Importer » de l'onglet Compendiums ou depuis les réglages du module.
- Import en deux temps : « Analyser » lit le fichier sans rien écrire, puis un résumé indique les documents conformes, mis à jour, rejetés (avec les raisons) et ceux qui seront remplacés. Rien n'est créé ni supprimé avant confirmation.
- Contrôle de conformité au modèle de données dnd5e 6 pour les acteurs et les objets : les données anciennes sont migrées par dnd5e, les documents invalides ou contenant des champs abandonnés sont rejetés avec une raison lisible.
- Les `_id` sont réellement conservés quand « Supprimer les _id » est décoché. Les conflits d'`_id` avec le compendium sont listés ; le MJ choisit de remplacer ou de donner de nouveaux `_id`.
- « Supprimer les _id » renumérote aussi les références internes (activités, effets), qui restent valides.
- Création d'un compendium avec nom suggéré depuis le fichier, filtre de type (acteurs, objets, tous), derniers choix mémorisés.
- API pour macros : `game.modules.get("compendium-json-importer").api`.
- Traductions en et fr.

## 0.1.0

- Version initiale.

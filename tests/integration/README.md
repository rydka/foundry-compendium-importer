# Tests d'intégration

Ils tournent dans un vrai Foundry v14 avec dnd5e, lancé par l'environnement de test de l'atelier (`test-env/`). Ce sont eux qui servent de preuve de fonctionnement.

Lancer depuis la racine de l'atelier :

```
node test-env/run.mjs compendium-json-importer
node test-env/run.mjs compendium-json-importer --with=<module-tiers>,<autre>   # avec des modules installés
node test-env/run.mjs compendium-json-importer --headed                        # navigateur visible
```

Fichiers : `*.spec.mjs` dans ce dossier, avec les fixtures de l'atelier :

```js
import { expect, test } from "../../../../test-env/fixtures.mjs";

test("...", async ({ foundry, gamePage }) => {
  const value = await foundry((arg) => game.settings.get("compendium-json-importer", arg), "enabled");
  expect(value).toBe(true);
});
```

- `gamePage` : page connectée en MJ, monde chargé.
- `foundry(fn, arg)` : exécute `fn` dans le client Foundry et renvoie son résultat (sérialisable).

Le monde de test est recréé à chaque lancement. Résultats, captures et traces : `test-env/results/` dans l'atelier.

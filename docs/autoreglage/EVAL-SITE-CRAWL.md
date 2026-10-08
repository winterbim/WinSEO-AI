# Évaluation du crawl et des groupes de structure

**Date :** 2026-10-07

**Corpus :** fixture synthétique déterministe, aucune requête réseau

**Test qui produit les mesures :** `apps/api/src/audit/site-audit.test.ts` — « measures deterministic rule precision and groups 200 fixture pages across five structures »

## Résultats observés

- Pages HTML observées : **200/200**.
- Structures fixture attendues : **5**, avec **40 pages** dans chacun des cinq groupes observés.
- Chaque groupe est maintenant rattaché à la catégorie et à l’empreinte HTML5 fixture attendues; le test vérifie cinq empreintes distinctes, 40 URL de la même catégorie par groupe et la méthode `URL_PATTERN_AND_SEMANTIC_DOM_V2`.
- Règle évaluée : `ONPAGE.MISSING_TITLE`.
- Défauts injectés avant le crawl : **20 pages positives**, réparties dans les cinq structures; 180 pages négatives.
- Vrais positifs : **20**; faux positifs : **0**; faux négatifs : **0**.
- Précision observée sur ce corpus : **20 / (20 + 0) = 1,00**.
- Rappel observé sur ce corpus : **20 / (20 + 0) = 1,00**.

Le test s’arrête si les compteurs attendus, les structures par catégorie, les signatures, le nombre de groupes, le support par groupe ou les deux métriques changent. Le crawl suit le sitemap fixture, applique les limites normales de l’audit et emploie uniquement un transport déterministe local.

## Portée et limites

Correction de sécurité du 2026-10-08 : les nouveaux groupes sans empreinte utilisent `URL_PATTERN_ONLY_PRIVACY_SINGLETON_V2`, avec un identifiant dérivé uniquement du motif expurgé et de l’index local du crawl. L’API rejette l’ancien format V1, dont l’identifiant permettait de vérifier hors ligne une URL complète pouvant contenir une valeur query. Le résolveur accepte maintenant les routes singleton expurgées comme `/orders/:id`, tout en exigeant le seuil de trois frères reconnus pour toute fusion de routes paramétrées.

Ces chiffres mesurent une règle déterministe sur un corpus contrôlé dont la vérité terrain est connue. Ils ne prédisent pas la précision sur les sites de clients. Ils ne valident pas la qualité du regroupement face à des gabarits arbitraires, les pages rendues uniquement par JavaScript, l’inventaire réel d’un domaine, le budget de ressources sur un site client ni la reprise du worker après arrêt.

Les « groupes de structure observés » sont calculés à partir d’un motif de chemin prudent et d’une empreinte de tags sémantiques produite par `parse5` 8.0.1 (parser HTML5). Les routes ne sont généralisées qu’avec des frères suffisants sous un parent de collection reconnu; cela ne prouve toujours pas une identité de template CMS. L’empreinte exclut le texte et les attributs, garde la cardinalité des frères sémantiques par classes, et ignore les éléments qui ne sont pas HTML dans un arbre SVG.

Le calcul est limité à **128 KiB d’entrée** et **30 000 nœuds traversés** par page. Au-delà, ou pour une réponse XHTML servie en XML, la page reçoit un groupe URL seul, singleton, avec hash nul et méthode `URL_PATTERN_ONLY_FINGERPRINT_UNAVAILABLE_V1`; elle n’est pas fusionnée sur une empreinte partielle ni avec une structure obtenue par le mauvais parseur. Un motif de route ne garde que des segments génériques d’une allowlist; les autres valeurs sont remplacées par `:private` dans le motif et dans les URL échantillons. L’API refuse d’exposer les anciens groupes persistés qui ne respectent pas cette forme. Les URL échantillons peuvent remplacer une forme connue d’identifiant par un marqueur masqué (`story-001` → `story-:id`), mais ce seul marqueur ne prouve pas un gabarit commun. Un groupe est fusionné sur une forme d’ID numérique, UUID/date ou suffixe numérique uniquement si au moins trois valeurs distinctes apparaissent comme frères sous une collection reconnue; le préfixe du suffixe doit lui-même être dans une courte allowlist. Deux routes comme `/guide/step-1` et `/guide/step-2` restent donc distinctes. Les pages conservant une empreinte mais isolées utilisent `SEMANTIC_DOM_PRIVACY_SINGLETON_V1`. Ce filtrage protège les résumés de groupes, mais ne constitue pas une anonymisation générale des observations de page.

Les contenus de `<template>` sont intégrés à l’empreinte comme structure source distincte, sans prétendre qu’ils sont visibles dans la page. Les cardinalités des frères identiques sont quantifiées (`0`, `1`, `2–4`, `5+`); deux et trois répétitions ont donc délibérément la même classe. L’empreinte est un regroupement grossier et explicable, pas un hash exact du DOM. `SEMANTIC_DOM_PRIVACY_SINGLETON_V1` signifie que le hash HTML5 est conservé, mais que le chemin ne peut pas servir de clé de regroupement en sécurité.

Sources parser consultées le 2026-10-07 : [dépôt officiel parse5](https://github.com/inikulin/parse5), [API `parse`](https://parse5.js.org/functions/parse5.parse.html), [métadonnées de la version 8.0.1](https://raw.githubusercontent.com/inikulin/parse5/refs/heads/master/packages/parse5/package.json).

## État WinCreator

`SITE-CRAWL-001`, `SITE-TEMPLATE-001` et `ONBOARDING-CRAWL-TRACK-001` restent `IN_PROGRESS` jusqu’au gate uncached et à la revue indépendante du diff courant. Le parcours n’a pas de preuve E2E navigateur. Le jalon M3 reste ouvert : le crawl utilisateur demeure borné à 50 pages, le rendu JavaScript échantillonné par structure et le budget de performance ne sont pas encore validés.

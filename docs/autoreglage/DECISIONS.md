# Décisions — auto-réglage prouvé WinSEO

**Mis à jour :** 2026-10-06 20:25 UTC. Décisions de mission séparées des ADR d’architecture générales.

## D-001 — Ordre imposé par la mission

**Décision :** suivre M0 → M1 → M2, sans publication de comportement pendant M0. Le benchmark antérieur mettait « exécuter le dernier kilomètre WordPress, titles/metas » en P0. Cette priorité produit est retenue, mais sa séquence directe est remplacée par la tranche complète et sûre R0 multimodale (`alt`) + R1 (`title`) de M2, avec preuves et rollback avant toute extension.  
**Raison :** les critères §9 et les garde-fous §4 ont priorité. Aucun statut `IMPLEMENTED` n’est traité comme une publication prouvée.

## D-002 — Premier adaptateur : WordPress natif, plus manuel

**Décision :** WordPress est le premier connecteur natif, puis Shopify, puis Git/PR; l’adaptateur manuel est fourni dans M2 comme voie explicite. Un adaptateur REST WordPress existe maintenant pour le champ média `alt_text` et un champ meta texte exposé comme éditable.  
**Raison :** le dépôt n’a ni connecteur CMS, ni données montrant un CMS majoritaire; le contrat prévoit WordPress comme premier choix par défaut. L’API REST standard n’est pas supposée exposer chaque champ SEO : détection du plugin et du champ REST enregistrés obligatoire; conflit ou capacité non vérifiée = blocage.  
**Limites :** le simulateur local prouve le contrat logiciel, pas la compatibilité d’un WordPress/plugin réel; le nom du plugin et la source canonique du champ ne sont pas détectés automatiquement. Le code n’est ni branché au workflow/API ni protégé contre toutes les cibles réseau privées. Tant que bac à sable, allowlist réseau et contrats réels n’ont pas été validés, libellé « non validé contre l’API réelle » et aucune route d’écriture exposée.

## D-003 — Source de vérité et publication

**Décision :** refuser la publication quand la source de vérité du champ n’est pas identifiée ou qu’un plugin SEO concurrent réécrit la valeur. Préférer une écriture native. Ne pas utiliser d’overlay edge/JS comme premier adaptateur.  
**Raison :** l’état courant n’a aucun adaptateur, aucun verrou de champ et pas de système de détection de conflit. Un simulateur pourra reproduire Yoast/Rank Math et un conflit sans toucher une production.

## D-004 — Statuts séparés de la déclaration

**Décision :** migrer l’ancien `IMPLEMENTED` en `REPORTED_MANUALLY` dans le modèle Action Center existant. Ajouter l’événement de migration sans réécrire les événements immuables antérieurs. Les états d’écriture/résultat prouvés (`deployed`, `live_verified`, `rolled_back`) appartiennent au nouveau flux de patch.  
**Raison :** le code actuel stocke seulement un compte rendu textuel et une stratégie de rollback descriptive. La migration retire l’affirmation trompeuse tout en conservant la trace historique et en refusant les nouvelles requêtes `IMPLEMENTED`.

## D-005 — Pas d’autopilote dans M2

**Décision :** chaque patch M2 exige une approbation humaine et un step-up TOTP pour le déploiement simulé. Publication sur un site client, autopilot R0 et tout flux R2 restent désactivés.  
**Raison :** l’API applique maintenant un step-up TOTP lié à la session pour son parcours fixture; l’adaptateur WordPress n’est pas branché au workflow et n’a pas passé de validation de sécurité/API réelle. R2/R3 doivent rester bloqués côté domaine, même via API/tâche/batch.

## D-006 — Multimodal dès la tranche verticale

**Décision :** le premier patch média est un alt, mais la proposition doit distinguer image informative et décorative et afficher le contexte. Aucune génération d’alt avant un adaptateur vision isolé et un validateur déterministe. Le type de page/gabarit `alt` et le titre doivent rester fondés sur une évidence visible.  
**Raison :** le crawler courant ignore les médias et le renderer ne télécharge pas images/vidéos; il est impossible de prétendre à une compréhension multimodale avant M4.

## D-007 — Google multimodal et mesure

**Décision :** le pilier média prend en charge les types de recherche officiels que Search Console expose et garde la recherche multimodale distincte tant que l’API ne l’expose pas. Éviter de déclarer que l’interface et API Search Console ont les mêmes dimensions.  
**Raison :** l’annonce Google du 2026-09-24 introduit dans l’interface un filtre multimodal; la documentation API Search Analytics consultée le 2026-10-06 répertorie les valeurs `web`, `image`, `video`, `news`, `discover`, `googleNews` mais pas de valeur multimodale. Données API correspondantes **non vérifiées**.

## D-008 — Traitement du benchmark existant

Le document antérieur, `BENCHMARK-SEO-AUTO-REGLAGE-2026-10-06.md`, est dans `/home/wina/WinSEO`, hors dépôt source. Il conclut que Semrush/Ahrefs Audit diagnostiquent, Alli/OTTO appliquent largement, Ahrefs Patches est documenté sur titles/metas, Sorank annonce une réécriture/image, Oscar est centré sur contenu, et que WinSEO n’exécute pas encore les patches. M1 reprend ces conclusions après vérification datée; les déclarations marketing ne sont pas traitées comme preuves indépendantes.

## D-009 — Budget crawl prudent

Adopter pour M3 comme plafond initial à tester : 200 pages et 500 actifs/job, une requête active par origine avec ≥1 seconde d’intervalle, 15 s/5 MiB par document, rendu d’un échantillon par gabarit (20 s + 1 s; concurrence 2), 3 s par contrôle d’actif, 20 actifs/page et budget total de 5 min. `robots.txt`, réponses 429/503 et capacité serveur peuvent encore réduire le débit. Cette proposition n’est pas le comportement existant.

## D-011 — Noyau de workflow fixture isolé

**Décision :** le moteur de patch reste fixture-only et refuse `NODE_ENV=production`. Les routes API/UI peuvent l’exercer hors production; l’état des propositions et événements est persisté en base tenant-scoped avec journal append-only. L’adaptateur WordPress reste un module distinct testé avec un transport simulé. Le test de route fixture ne prouve ni la compatibilité CMS ni le parcours complet sur PostgreSQL.

**Raison :** le simulateur ne doit jamais faire passer une simulation pour une publication sûre. L’adaptateur WordPress n’est pas lié aux routes, les destinations privées/egress ne sont pas intégralement protégées et aucun contrat n’a été exécuté contre une instance WordPress réelle.

**Conséquence :** M2 demeure « en cours ». Le cycle API fixture et les stores Postgres sont vérifiés séparément; l’E2E API + Postgres + simulateur REST reste à faire, sans cible de production.

## D-012 — Sortie de vérification de la session

**Décision :** `pnpm verify` exit 0 confirme lint, types, tests et builds inclus dans la suite; il ne fait pas passer M2 à « terminé ».

**Raison :** `pnpm verify` prouve lint, types, tests et builds inclus, mais ne prouve pas à lui seul l’E2E API + Postgres + WordPress REST. Le premier `pnpm verify` ne sélectionnait pas tous les tests API; la dernière vérification complète, 2026-10-06 20:25 UTC, passe lint 14/14, typecheck 14/14 et tests 12/12 (API 94/94, PostgreSQL/RLS inclus; build web réussi).

**Alternative écartée :** annoncer la tranche verticale « livrée » après les tests unitaires du moteur. Cette formulation serait contraire aux critères M2 et au garde-fou « aucun statut sans preuve ».

## D-010 — Statut des sources

Sources utilisées pour le benchmark : documentation officielle de Google et de chaque fournisseur lorsque disponible, consultée 2026-10-06. Les capacités de produit indiquées par une page produit sont étiquetées « annoncée (marketing) »; celles des guides d’utilisation sont « documentée (éditeur) ». L’absence de documentation consultée n’est pas une preuve d’absence de capacité : étiquette « non vérifiée ».

## D-013 — Pas de trafic externe dans les tests d’audit

**Décision :** les tests API qui couvrent les scans/crawls injectent uniquement du HTML local déterministe, traité par le vrai parseur et le vrai moteur de règles. Les routes, le stockage PostgreSQL/RLS et les contrôles d’entrée restent réels dans les tests d’intégration. Les points d’injection de fetch/audit sont refusés en production. Le résolveur crawler examine tous les A/AAAA retournés et bloque si l’un est privé.

**Raison :** plusieurs tests existants appelaient `example.com`, des domaines `.invalid` ou des domaines de quota. Cela rendait la CI dépendante du DNS/réseau et enfreignait le contrat « aucun appel réseau réel ». Le check qui ne validait que le premier A autorisait aussi un ensemble `[public, privé]`.

**Limites :** au moment de cette décision, l’adresse validée n’était pas encore épinglée sur le socket. Cette limite est traitée par D-014 pour le transport HTTP du crawler; Playwright garde une résolution indépendante. L’isolation egress des workers reste un prérequis de déploiement et n’est pas prouvée par les tests.

**Retour arrière et preuve :** ces changements ne remplacent aucun chemin d’exécution SaaS par une fixture; retirer les options d’injection et les fixtures restaure les appels externes de test. Succès à vérifier avec `pnpm verify`, les tests SSRF ciblés, puis une recherche statique de fetch/crawl non injectés dans les tests.

## D-014 — Épingler l’adresse DNS au socket du crawler HTTP

**Décision :** après validation de toutes les adresses A/AAAA d’une réponse DNS, le transport HTTP natif utilise une fonction `lookup` qui ne renvoie qu’une adresse validée. La requête conserve le nom d’hôte pour `Host` et la vérification TLS; chaque redirection repart par validation, résolution et pinning. Les overrides de transport et de DNS sont interdits en production.

**Preuve :** le test `rebinding-ssrf.test.ts` exerce les callbacks Node `lookup` standard et `all`, refuse un autre hostname, vérifie gzip/deflate/Brotli, et le test DNS mixte démontre le refus avant transport. `pnpm verify` — exit 0; tests crawler 119/119. Documentation officielle consultée le 2026-10-06 : [Node.js HTTPS v26.10.0](https://nodejs.org/api/https.html) et [Node.js HTTP](https://nodejs.org/api/http.html), options `lookup` et `servername`.

**Risque :** les encodages gzip, deflate et Brotli sont décodés avec une limite de taille; un encodage inconnu échoue explicitement. Les redirections ne sont pas encore testées sur une fixture HTTP end-to-end. Le renderer Chromium conserve sa propre résolution.

**Retour arrière :** restaurer le transport précédent uniquement en gardant les crawlers derrière une egress policy qui refuse les plages privées; aucune route d’écriture de site n’est concernée.

**Résultat attendu :** une réponse DNS différente lors de l’ouverture du socket ne peut pas modifier l’adresse ciblée; les tests `lookup` et le pipeline complet restent verts.

## D-015 — Step-up MFA indépendant de l’horloge du simulateur

**Décision :** la durée de validité d’une preuve step-up se calcule avec l’horloge serveur (`Date.now()`), tandis que l’horloge injectée du workflow ne date que les événements fixture. Le parcours autofix API est disponible uniquement hors production; ses propositions et transitions sont persistées dans le store tenant-scoped.

**Raison :** le simulateur avance volontairement ses dates pour ordonner reçu, observations et rollback. Cette horloge logique pouvait placer un événement quelques millisecondes dans le futur par rapport à l’heure de validation TOTP, faisant rejeter une preuve MFA fraîche. L’authentification doit suivre l’horloge réelle du serveur, pas celle du simulateur.

**Preuve :** `apps/api/src/autofix-routes.test.ts` passe le parcours `alt` et `title`, étape MFA comprise; `pnpm verify` exit 0 le 2026-10-06 20:25 UTC, avec API 94/94 et tests PostgreSQL/RLS. La route reste fixture-only; l’adaptateur WordPress REST et une écriture réelle ne sont pas concernés.

**Limite restante à la date de cette décision :** le test de route utilise le store mémoire; la persistance Postgres et le journal append-only sont vérifiés séparément. Le raccordement E2E est suivi dans D-016.

## D-016 — M2 relié via un simulateur REST, pas validé contre WordPress réel

**Décision :** garder le workflow d’écriture hors production et fournir un adaptateur de page fixture adossé au client WordPress REST. L’API M2 lit le title/alt courant dans le HTML observé, écrit le patch alt R0 via les champs REST simulés, et propose le title R1 par le flux manuel. La route manuelle ne produit pas de reçu d’écriture; elle reste en attente jusqu’à la vérification postérieure. Le test API/PostgreSQL utilise l’adaptateur et le simulateur REST ensemble. L’injection de l’adaptateur fixture est refusée en mode production.

**Preuve :** apps/api/src/autofix-postgres-routes.integration.test.ts traverse proposition, aperçu, hash d’approbation, MFA, écriture REST simulée, vérification des observations navigateur/Googlebot brutes/rendues, flux manuel, rollback et isolation inter-tenant. Le hash HTML avant/après rollback est identique. La démo E2E et pnpm verify passent le 2026-10-06. docs/autoreglage/DEMO-M2.md décrit les prérequis et les commandes.

**Limites et raisons :** le simulateur ne vérifie pas le schéma d’un plugin SEO réel, le cache, les permissions d’une installation WordPress, ni les effets d’un hébergeur. Le test exige PostgreSQL local déjà démarré. Aucun secret CMS de production et aucune URL configurable d’un client ne sont branchés.

**Retour arrière :** les rollbacks des deux patches sont vérifiés en relisant les quatre vues et en retrouvant le hash HTML initial; si le hash source change, l’adaptateur refuse d’écraser cette édition. Les routes d’écriture restent indisponibles en production.

**Résultat attendu :** M2 terminé en fixture contrôlée; statut « non validé contre l’API réelle » jusqu’à l’exécution contractuelle dans un bac à sable WordPress dédié. M3 est la prochaine étape; ne pas annoncer que toute la mission ou la comparaison concurrentielle est achevée.

## D-017 — Audit URL réel sur preview sans service API durable

**Décision :** rendre le champ URL visible sans `API_URL`. Sur les déploiements preview seulement, une route limitée exécute le moteur d’audit partagé sur une seule page et renvoie les preuves observées sans stockage. Si le contrôle plane est configuré, il reste le chemin normal; en production sans API, l’analyse demeure indisponible.

**Raison :** le site déployé présentait le formulaire marketing mais cachait l’unique moyen de saisir une URL quand aucune variable backend n’était configurée. Il ne permettait donc pas d’essayer le produit.

**Preuve :** tests de normalisation URL, protection SSRF, rendu dégradé explicite, limiteur preview et route inline; `pnpm verify` — exit 0 (DB 45/45, authz 23/23, crawler 124/124, API 101/101, web 4/4). Build Vercel preview `dpl_DwyDpRR6mbgiunkCEQdmhGLLDwgZ` — `Ready`, URL `https://winseo-h7xnav4sy-wintfernandes-7029s-projects.vercel.app`. Sur le domaine réservé `example.com`, la route retourne HTTP 200 avec 5 constats et 1 preuve HTML observée; `127.0.0.1` est rejeté. La feuille CSS déployée inclut les règles `.winseo-home`, `.hero-section` et `.audit-form`; celle de la preview antérieure affichée par l’utilisateur n’incluait pas les styles WinSEO.

**Risques et limites :** quota limité à une mémoire de processus serverless, donc non global/durable; aucune persistance, exploration multi-page, capture navigateur, intégration GSC ni publication de patch dans ce parcours. Ces limites sont exposées dans l’interface. Le mode inline n’est jamais activé en production. La preview elle-même est protégée par Vercel SSO; l’accès anonyme reçoit une redirection et l’équipe autorisée doit être connectée. Aucune protection n’a été désactivée.

**Retour arrière :** retirer la route inline preview et désactiver le bouton en preview. Aucune donnée persistante ni site audité n’est modifié.

**Validation réelle :** le moteur analyse la page fournie avec les preuves HTML; le mode preview n’est pas une plateforme complète d’audit de site. Le profil produit public de Semrush est maintenant documenté en D-018; toute mesure indépendante et toute revendication de supériorité restent non vérifiées.

## D-018 — Semrush comme référence de largeur, WinSEO comme boucle de correction prouvée

**Décision :** inclure Semrush dans le benchmark de largeur produit : crawl/configuration/rapports Site Audit, SEO Writing Assistant et mesures AI Visibility restent des capacités de référence à égaler ou à traiter explicitement. La différenciation WinSEO visée demeure la correction typée approuvée par hash, la vérification live et le rollback relu, avec un pilier médias complet; aucune supériorité globale n’est revendiquée.

**Raison :** les docs officielles Semrush consultées le 2026-10-06 documentent plusieurs sources de crawl et rapports URL, un assistant de contenu et des outils de visibilité IA. Le benchmark antérieur couvrait seulement Semrush Site Audit et sous-estimait donc la surface concurrentielle.

**Preuve :** docs/benchmark/BENCHMARK-MULTIMODAL-AUTOREGLAGE-2026-10.md et docs/benchmark/MATRICE-DEPASSEMENT.md mis à jour; REQ-SCOPE-001 et REQ-AI-VIS-001 relient les écarts à des tests d’acceptation qui restent à créer. Sources : configuration/crawl Site Audit, pages explorées, SEO Writing Assistant et AI Visibility, consultées le 2026-10-06.

**Risque :** les pages d’aide de l’éditeur ne sont ni des tests indépendants ni des preuves de résultats, et les détails d’autres produits Semrush peuvent ne pas apparaître dans les sources Site Audit ouvertes.

**Retour arrière :** retirer les lignes et REQ ajoutées si elles ne sont pas confirmées; la portée produit existante n’est pas modifiée par le benchmark.

**Résultat attendu :** les écarts à Semrush deviennent traçables et testables, sans gonfler les capacités WinSEO ni attribuer à Semrush une absence de fonctionnalité non démontrée.

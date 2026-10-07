# Décisions — auto-réglage prouvé WinSEO

**Mis à jour :** 2026-10-06 20:25 UTC. Décisions de mission séparées des ADR d’architecture générales.

## D-026 — Historique des captures AI Visibility

**Décision :** conserver chaque lot importé sous une identité d'import append-only, liée au projet/organisation, avec SHA-256 du fichier CSV source, horodatage d'import, provenance `USER_SUPPLIED` et indicateur explicite « non vérifié auprès du fournisseur ». Stocker les lignes normalisées nécessaires aux statistiques; ne pas stocker le texte complet des réponses de fournisseurs dans cette première tranche. Autoriser la suppression tenant-scopée selon la rétention définie.

**Raison :** le calcul actuel est seulement dans le navigateur et disparaît au rechargement. La chaîne de preuve doit pouvoir relire le même échantillon depuis la base sans prétendre que WinSEO a capturé ou authentifié une réponse stochastique externe.

**Garde-fous :** plafond strict par import, vérification serveur des champs/types/domaines, FK composites organisation/projet, RLS avec `USING` et `WITH CHECK`, `FORCE ROW LEVEL SECURITY`, audit d'intégrité sur le lot et tests d'attaque inter-tenant. Les appels API de modèles restent désactivés.

**Retour arrière :** retirer la route et les vues UI; la migration additive reste intacte, les nouvelles lignes pouvant être supprimées via le flux tenant-scopé. Pas de réécriture ni de suppression des anciennes migrations.

## D-027 — Scanner les commits PR atteignables et activer les règles Gitleaks par défaut

**Décision :** étendre la configuration Gitleaks intégrée avec `useDefault = true`, retirer les allowlists globales de chemins, et exécuter en CI `gitleaks git` sur les commits atteignables depuis le head mais pas depuis le base (`HEAD ^BASE`). Garder le scan GitHub Action, ajouter ce scan de graphe complet, et bloquer la CI si l'un échoue. Toute exception future doit être une empreinte de faux positif étroite, examinée en revue; aucun dossier ne peut être exclu globalement.

**Raison :** le code de l'action v3 utilise `--no-merges --first-parent` sur les PR et ne couvre donc pas tous les commits d'une branche latérale fusionnée; la configuration précédente n'étendait pas les règles par défaut et excluait tout `docs/*.md`.

**Preuve attendue :** CI verte sur la configuration par défaut, puis test synthétique local temporaire sur une branche latérale dont le secret est supprimé par le commit merge. Le secret synthétique reste hors du dépôt partagé après l'essai; une preuve retenue démontre l'échec du scan avant nettoyage.

**Revue du premier passage :** le scan des règles intégrées a révélé six faux positifs dans des tests (UUID d'idempotence et mot de passe de fixture). Après examen, six empreintes complètes sont ignorées dans `.gitleaksignore`, chacune rattachée à un commit, un chemin, une règle et une ligne. La documentation Gitleaks décrit cette forme d'exception unitaire; aucune allowlist de chemin n'est rétablie. Revue sceptique indépendante encore requise.

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

## D-019 — L’ordre d’autorité des mesures GSC vient de PostgreSQL

**Décision :** chaque revendication de synchronisation reçoit un `claim_order` monotone par propriété, alloué sous le verrou transactionnel de la propriété. Pour les dates couvertes par plusieurs jobs terminés, le job revendiqué en dernier est l'unique source autoritaire, même si son worker termine avant ou après l'ancien.

**Raison :** `started_at` fourni par le processus applicatif peut avoir la même précision à la milliseconde sur deux workers ou diverger à cause d'horloges décalées. Trier les mesures par cet horodatage ne prouve donc pas l'ordre réel des fetchs. L’ordre PostgreSQL ne dépend ni de l'horloge d'un client ni de l'ordre d'achèvement.

**Preuve :** migration additive `0020_gsc_sync_claim_order.sql` rétroclasse les jobs historiques, crée une unicité partielle tenant/projet/propriété et nettoie les recouvrements historiques. Les tests PostgreSQL couvrent les deux ordres d'achèvement et des horodatages applicatifs inversés/identiques; les tests de schéma vérifient la colonne, l'index et le ledger.

**Risque :** le `claim_order` reflète l'ordre de revendication et non l'horodatage de réponse côté Google; deux fetchs démarrés dans cet ordre peuvent encore recevoir des réponses de fraîcheur différente. Les jobs affichent leur fenêtre et statut; les mesures n'affirment pas une causalité.

**Retour arrière :** migration en avant seulement; désactiver le remplacement des fenêtres nécessiterait une migration explicite après analyse des données. Ne pas supprimer la colonne ni réduire le statut d'une sync à `COMPLETED` sans preuve.

**Résultat attendu :** aucune fenêtre partielle ou terminée plus ancienne ne peut effacer une mesure d'un fetch revendiqué plus récemment, indépendamment des horloges applicatives et du scheduling des workers.

## D-020 — Conserver la configuration PostgreSQL dans les commandes Turbo

**Décision :** les scripts racine `test`, `db:migrate` et `db:seed` utilisent explicitement le mode d'environnement `loose` de Turbo afin de transmettre `PG_SOCKET_DIR`, `PGDATABASE`, `PGPORT` et les variables de connexion nécessaires aux tâches ciblées.

**Raison :** Turbo en mode strict a supprimé les variables fournies au shell pour la commande de migration, qui a alors utilisé `/var/run/postgresql` au lieu du cluster jetable. Le contrôle des comptes de la base par défaut a trouvé zéro ligne GSC avant 0020; la migration additive y est néanmoins enregistrée. Le mode explicite empêche les commandes futures de viser silencieusement la mauvaise base.

**Preuve :** migration 0020 appliquée avec `node packages/db/src/migrate.ts` et `PG_SOCKET_DIR=/tmp/winseo-pgsocket`; les tests PostgreSQL sont exécutés directement avec les mêmes variables et les tâches Turbo de `pnpm verify` seront relancées en mode loose.

**Risque :** mode loose transmet l'environnement complet aux tâches lancées par ces scripts; les secrets ne doivent pas être imprimés par les scripts. Cette configuration est limitée aux commandes de test, migration et seed.

**Retour arrière :** retirer l'option des commandes racine après définition d'une allowlist Turbo explicite et testée pour toutes les variables PostgreSQL nécessaires.

**Résultat attendu :** une migration ou une suite de tests lancée avec des variables PostgreSQL explicites se connecte à la base demandée, pas à une valeur par défaut.

## D-021 — Préflight des horloges historiques avant nettoyage GSC

**Décision :** conserver 0020 comme migration appliquée et ajouter `0019z_gsc_claim_order_preflight.sql`, exécutée avant elle. Si deux jobs terminés ont des données sur des jours chevauchants et que l'ordre obtenu avec `started_at` client contredit l'ordre `requested_at` stocké par PostgreSQL, l'upgrade s'arrête avant le nettoyage. Les lignes historiques restent intactes pour revue manuelle.

**Raison :** le rattrapage de 0020 ne dispose pas d'un ordre de claim monotone préexistant. Un horodatage client peut être décalé; deviner l'ordre et supprimer les lignes serait irréversible. Le préflight bloque uniquement les cas contradictoires observables; il ne prétend pas reconstruire une chronologie qui n'a pas été enregistrée.

**Preuve :** test d'intégration PostgreSQL `packages/db/src/gsc-claim-order-migration.test.ts` (3 cas): fichier trié avant 0020, horloges contradictoires -> échec et ligne conservée sans entrée de migration, horloges cohérentes -> migration inscrite. Résultats finaux capturés et revus séparément avant tout statut `EVIDENCED`.

**Risque ouvert :** un historique comportant un décalage de client qui conserve par hasard le même ordre que les dates `requested_at` n'est pas détectable après coup; l'ordre DB reste le meilleur proxy stable disponible. Les installations avec conflit détecté doivent résoudre manuellement les lignes avant migration.

**Retour arrière :** migration additive uniquement; aucun effacement ni correction automatique des fenêtres ambiguës. L'opérateur peut résoudre les données et relancer les migrations après analyse des jobs concernés.

## D-022 — Bloquer les mutations GSC pendant le nettoyage des anciennes fenêtres

**Décision :** placer un garde temporaire de maintenance dans une migration forward-only ordonnée après le préflight et avant 0020, puis le retirer dans 0021 après le nettoyage. Les déclencheurs bloquent les écritures GSC des connexions applicatives pendant la fenêtre; le runner signale explicitement sa propre connexion et la conserve jusqu'à la fin de chaîne.

**Raison :** le préflight seul laisse une fenêtre entre le commit de son contrôle et le commit de 0020. Sans barrière, un nouveau job aux horodatages inversés peut apparaître après le contrôle et avant la suppression irréversible. Un garde durable entre migrations rend l'interruption fail-closed; 0021 réouvre les écritures seulement après l'opération.

**Preuve :** test PostgreSQL adversarial requis : mutations applicatives refusées pendant le garde, mutations du runner autorisées, reprise après suppression du garde, et migration à risque refusée avant le nettoyage si une ambiguïté est détectée. Aucune revendication de réussite avant les résultats capturés et l'avis du Skeptic.

**Risque :** si la chaîne de migration est interrompue après l'activation du garde, les nouvelles synchronisations GSC renvoient une erreur jusqu'au redémarrage réussi du runner. Aucune donnée n'est supprimée par le garde.

**Retour arrière :** 0021 désactive et supprime le garde atomiquement. Une migration ultérieure dédiée peut restaurer le service si la migration est partiellement déployée; ne jamais contourner le déclencheur manuellement.

## D-023 — Le bypass de migration GSC ne repose pas sur un GUC modifiable

**Décision :** ajouter la migration forward-only `0019y_gsc_sync_write_fence.sql` avant le préflight. Elle retire temporairement à `serpvera_app` les privilèges `INSERT`, `UPDATE`, `DELETE` et `TRUNCATE` sur les deux tables GSC. Elle échoue si le rôle est propriétaire, membre d'un autre rôle, ou conserve un privilège d'écriture effectif. Après suppression du déclencheur par 0021, `0022_restore_gsc_runtime_writes.sql` vérifie l'absence du garde puis restaure les droits de lecture/écriture.

**Raison :** le reviewer a démontré qu'un rôle pouvait définir lui-même `app.winseo_gsc_migration='on'`; un GUC personnalisé n'est donc pas un secret et ne peut pas constituer une frontière de sécurité. Le runner peut encore définir ce signal pour l'ancien déclencheur, mais les écritures runtime restent impossibles pendant toute la chaîne, même si l'application tente le même réglage.

**Preuve attendue :** PostgreSQL réel vérifie qu'un `SET ROLE serpvera_app` avec GUC forgé ne peut pas modifier les jobs pendant la barrière, que le rôle de migration peut effectuer le nettoyage, et que les écritures runtime reprennent après 0021/0022. Le schéma final doit montrer les droits restaurés et aucun garde temporaire.

**Risque :** toute interruption après 0019y laisse les écritures GSC désactivées jusqu'à la reprise réussie de la chaîne. La migration échoue fermée si le modèle de rôles observé n'est pas celui attendu; aucune mesure n'est supprimée par le fence lui-même.

**Retour arrière :** 0022 rétablit les droits uniquement après confirmation que le garde a été retiré. Si la chaîne est interrompue, ne pas accorder manuellement ces privilèges avant l'inspection du ledger et des triggers; corriger la cause puis relancer le runner.

## D-024 — Couvrir les suppressions parentes qui cascade vers les mesures GSC

**Décision :** `0019x_gsc_parent_delete_fence.sql`, exécutée avant les autres fences GSC, révoque temporairement `DELETE` et `TRUNCATE` sur `gsc_connections`, `projects` et `organizations`. Ces tables parentes peuvent supprimer en cascade des jobs et leurs métriques. `0023_restore_gsc_parent_deletes.sql` restitue `DELETE` après la chaîne et laisse `TRUNCATE` non accordé.

**Raison :** la revue adversariale a montré qu'un `DELETE` permis sur `gsc_connections` contournait la révocation DML posée uniquement sur les tables enfants; `projects` et `organizations` sont aussi des ancêtres de la même chaîne FK. La protection doit couvrir tout chemin SQL autorisé au rôle runtime, pas seulement les mutations directes.

**Preuve attendue :** PostgreSQL réel crée les FK `ON DELETE CASCADE`, forge le GUC sous `SET ROLE serpvera_app`, puis tente de supprimer chacun des trois parents. Chaque suppression doit échouer par privilège avant de toucher aux enfants; après 0021–0023, les droits `DELETE` historiques sont restaurés et aucun droit `TRUNCATE` n'est accordé.

**Risque :** les suppressions de connexion, projet et organisation sont indisponibles pendant la fenêtre de migration; une interruption maintient ce blocage jusqu'à reprise. La migration échoue fermée si le rôle applicatif possède les parents ou a des privilèges résiduels.

**Retour arrière :** 0023 restaure `DELETE` après vérification que le trigger guard et sa table ont disparu. Aucun `TRUNCATE` n'est restauré; les données sont conservées par le fence.

## D-025 — Fermer les privilèges effectifs de colonne accordés à PUBLIC

**Décision :** placer `0019w_gsc_effective_acl_fence.sql` avant les autres fences GSC. La migration retire les privilèges de mutation au niveau table et colonne de `PUBLIC` et de `serpvera_app` sur cinq tables : `organizations`, `projects`, `gsc_connections`, `gsc_sync_jobs` et `gsc_metrics`. Elle vérifie les privilèges effectifs après révocation. `0024_restore_gsc_acl_baseline.sql` restaure le DML applicatif sur ces cinq tables uniquement après retrait de tous les gardes. Les écritures directes sur les tables de credentials et d'états OAuth restent hors de cette barrière et ne sont pas couvertes par cette preuve.

**Raison :** PostgreSQL conserve des ACL de colonnes distinctes des ACL de tables. `REVOKE UPDATE ON table` ne neutralise pas forcément `GRANT UPDATE(status) TO PUBLIC`; un contrôle limité à `has_table_privilege` peut donc accepter une migration alors que le rôle runtime peut encore écrire.

**Preuve attendue :** fixture PostgreSQL accorde à `PUBLIC` `UPDATE(status)` et `INSERT(...)` avant le fence, puis exécute les deux opérations sous `SET ROLE serpvera_app` avec le GUC falsifié. Les opérations doivent être refusées et `has_any_column_privilege` doit confirmer l'absence d'accès effectif durant la barrière. Après retrait du garde, le DML applicatif revient; aucun grant d'écriture à `PUBLIC` ne subsiste dans les catalogues.

**Risque :** les tests et contrôles de migration doivent inclure les cinq tables et les chemins de privilèges hérités. La migration échoue si le runtime possède une table protégée ou est membre d'un autre rôle.

**Retour arrière :** migrations forward-only `0019w`/`0024`; les ACL métier restent inchangées et seul le DML de `serpvera_app` est rétabli. Ne pas réaccorder de droits pendant une chaîne interrompue avant l'inspection du ledger et des triggers.

## D-027 — Désactiver le cache pour les gates de preuve finale

**Décision :** `scripts/verify-disposable-db-gates.sh` lance lint, typecheck, tests et build avec Turbo `--force`. La sortie doit montrer `Cached: 0` pour chaque étape; le script affiche des marqueurs de début et de réussite pour toutes les gates, y compris le contrôle PostgreSQL et `git diff --check`.

**Raison :** une revue indépendante a relevé que les totaux de tests provenaient d'un cache Turbo. Un cache valide pour la productivité ne prouve pas qu'une suite PostgreSQL a été exécutée sur la base jetable nommée dans le rapport.

**Preuve :** capture WinCreator `VERIFY-001` du 2026-10-07, sortie complète non tronquée, tests et build avec zéro tâche cachée, base `serpvera_dev` au port 55432, DB 75/75, crawler 124/124, API 119/119, authz 23/23, web 25/25, audit sans vulnérabilité connue; revue indépendante `EVIDENCED`.

**Risque :** cette porte dure environ 105 secondes et consomme plus de ressources que les commandes locales mises en cache.

**Retour arrière :** la porte de preuve demeure indépendante des commandes développeur; retirer `--force` uniquement si la CI conserve les résultats bruts et démontre l'exécution fraîche sur la bonne base.

## D-028 — Garder la base PostgreSQL historique demandée par la migration CI

**Décision :** le job PostgreSQL CI garde `serpvera_test` comme base cible pour migrations et tests, et crée aussi `serpvera_dev` dans le service PostgreSQL temporaire avant la migration.

**Raison :** la migration historique `0001_init_schema.sql` accorde `CONNECT` sur `serpvera_dev` en dur. Elle ne doit pas être réécrite après application; le job isolé doit donc fournir cette dépendance historique sans déplacer les tests vers une base locale ou externe.

**Preuve attendue :** GitHub Actions exécute le runner sur `serpvera_test`, passe les migrations et les tests sur son PostgreSQL éphémère; le log indique la base cible exacte.

**Risque :** ajouter une seconde base au conteneur CI masque une hypothèse codée dans la migration historique; toute nouvelle base fixe doit être identifiée par recherche et revue.

**Retour arrière :** supprimer la création de la base auxiliaire et rétablir le workflow précédent. Aucune base réelle n'est touchée.

## D-029 — Scanner l'historique du PR avec un checkout complet

**Décision :** le job Security Scan récupère l'historique Git complet; Gitleaks compare ainsi le commit de base du PR à la tête de branche. Le job garde les permissions en lecture seule, transmet `GITHUB_TOKEN`, utilise `GITLEAKS_CONFIG` et désactive uniquement les commentaires.

**Raison :** Gitleaks a échoué avec `unknown revision` parce que `actions/checkout` ne ramenait pas le commit de base. Le log « aucun leak dans le scan partiel » ne prouve rien et ne doit pas produire un statut vert.

**Preuve attendue :** le run GitHub Actions montre une exécution complète du range de commits du PR et le job de scan réussit; les sources Gitleaks consultées le 2026-10-07 documentent le token, la config par variable d'environnement et la migration de l'action vers v3.

**Risque :** plus de données Git téléchargées; le token n'a pas de permission d'écriture et les commentaires sont désactivés.

**Retour arrière :** restaurer l'action/version précédente seulement avec une preuve d'analyse complète et une config valide; ne jamais transformer le scan en étape advisory.

## D-026 — Ne pas modifier une migration après son application, même sur la base jetable

**Décision :** après application d'une migration sur le PostgreSQL jetable, son fichier source est immuable. Toute correction future exige une nouvelle migration forward-only; le test de comportement peut évoluer séparément.

**Raison :** modifier le fichier après application rend l'état du dépôt différent de l'état effectivement vérifié par le runner, même si aucune base de production n'est concernée. L'essai de simplification de `0019w` a été annulé et son hash restauré au contenu déjà appliqué.

**Preuve :** le SHA-256 actuel de `0019w_gsc_effective_acl_fence.sql` est `5e3b31693f0cc52f3d5fb32b8d02101014448956a48c0ed5d9352649d9c62fab`, identique à celui capturé avant l'essai de simplification. Le test PostgreSQL ajoute des cas de refus pour la propriété et l'héritage de rôle sans changer la migration.

**Risque :** une migration historique répétitive peut rester plus longue qu'une réécriture souhaitée; la lisibilité ne justifie pas de changer le contenu déjà appliqué.

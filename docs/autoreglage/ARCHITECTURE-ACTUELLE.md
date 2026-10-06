# Architecture actuelle — audit WinSEO

**Audit effectué :** 2026-10-06 (UTC)  
**Dépôt lu :** `/home/wina/Modèles/Vidéos/win seo`  
**Branche / HEAD :** `main` / `e67720c` (`docs(vercel-prod-01): production architecture decision record + VP gate ledger`)  
**Portée :** lecture seule du code et des documents. Aucun changement de comportement réalisé pour M0.

## Résultat exécutif

WinSEO possède déjà un socle utile : constats déterministes, preuves de crawl, rendu JavaScript déclenché par signaux, Action Center avec approbation et journal de transitions, recrawl et ingestion Search Console. Il ne publie cependant aucun patch de site. Le libellé `IMPLEMENTED` est obtenu par une saisie humaine et ne prouve pas qu’une écriture a eu lieu. Le crawl utilisé par les scans publics et les projets porte sur la page d’accueil. L’analyse des images et vidéos est absente : le parseur n’extrait pas les médias et le navigateur de rendu bloque leur téléchargement.

| Écart de départ                                     | Verdict dans le code                                                                                                                                                                                                                                   | Preuve                                                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| « Implémentée » affirme plus que ce qui est observé | **Confirmé.** `IMPLEMENTED` exige une description (`whatChanged`, `how`) et une stratégie textuelle de retour arrière. La route n’appelle aucun adaptateur de publication.                                                                             | `apps/api/src/routes/actions.ts`; `packages/db/src/actions.ts` (transition `IMPLEMENTED`); `apps/web/src/app/dashboard/[projectId]/actions/[actionId]/action-controls.tsx` (formulaire « Record implementation »). |
| L’audit s’arrête à l’accueil                        | **Confirmé pour les deux flux utilisés en production.** `auditDomain()` construit `https://{domain}/`; le crawl de projet le réutilise. Le `runCrawl()` générique sème aussi uniquement l’accueil. Le parseur de sitemap n’est pas raccordé à ce flux. | `apps/api/src/audit/domain-audit.ts`; `apps/api/src/routes/scans.ts`; `apps/api/src/routes/projects.ts`; `services/crawler/src/crawl-orchestrator.ts`; `services/crawler/src/sitemap-parser.ts`.                   |
| Le multimodal est insuffisant                       | **Confirmé.** Aucun inventaire `img`, `picture/srcset`, SVG, CSS background ou vidéo; pas de règles alt/LCP/licence/URL d’actif; JSON-LD évalué seulement pour sa syntaxe. Le renderer interrompt les requêtes `image` et `media`.                     | `services/crawler/src/html-parser.ts`; `services/crawler/src/seo-rules.ts`; `services/crawler/src/renderer.ts`.                                                                                                    |

## Chemin des constats et des preuves

1. `apps/api/src/routes/scans.ts` valide le domaine, exécute le contrôle SSRF et le rate-limit, crée un scan puis lance un traitement asynchrone non durable (`void runScan`).
2. `apps/api/src/audit/domain-audit.ts` effectue un GET HTML, avec limite de 15 s et 5 MiB, extrait title/meta/H1/canonical/robots/JSON-LD, puis appelle le moteur déterministe.
3. `services/crawler/src/html-parser.ts` est un parseur par expressions régulières. `services/crawler/src/seo-rules.ts` produit des constats `OBSERVED` et des enregistrements d’évidence avec URL, date, HTTP, hash de contenu et chaîne de redirection.
4. Le rendu Playwright est une escalade motivée par des signaux déterministes. Il retourne le DOM et son hash, mais n’enregistre ni capture d’écran ni DOM complet persistant. Il bloque images, médias et polices pour maîtriser son coût.
5. `apps/api/src/routes/projects.ts` appelle le même audit de domaine pour les crawls de projet et persiste constats/preuves.

Le crawl générique `services/crawler/src/crawl-orchestrator.ts` extrait les liens internes via le parseur, mais ne les met pas en file. Le `sitemap-parser.ts` existe avec tests, sans orchestration d’exploration ni respect observable de `robots.txt`/budget par origine dans ce parcours. Il n’y a donc pas encore de regroupement par gabarit ni de métrique précision/rappel.

## Action Center, approbation et vérification

- États actuels déclarés dans `apps/api/src/routes/actions.ts` : `DETECTED`, `EVIDENCED`, `PROPOSED`, `APPROVED`, `IMPLEMENTED`, `MEASURING`, `VERIFIED`, `REJECTED`, `INCONCLUSIVE`, `CLOSED`.
- `packages/db/src/actions.ts` exige une preuve liée avant `EVIDENCED`, une recommandation et une gate avant `PROPOSED`, une décision explicite avant `APPROVED`, puis du texte de compte rendu avant `IMPLEMENTED`.
- Le numéro de version protège les transitions concurrentes; `action_transitions` enregistre l’historique. L’approbation ne contient pas de hash de diff et ne lie donc pas l’approbation à un contenu exact.
- Le retour arrière est une description JSON, pas une commande. Aucun instantané « avant », dry-run, verrou par champ, adaptateur ou rollback vérifié n’est exécuté.
- Le passage à `VERIFIED` est une évaluation des gates déclarées et, pour GSC, des données mesurées. Cette preuve ne démontre pas à elle seule la publication du patch.
- L’interface de détail expose les données d’implémentation/rollback et des contrôles de formulaire; elle ne fournit ni diff fidèle, ni aperçu exécuté, ni preuve live cliquable par transition.
- Le statut de base de données est `IMPLEMENTED`, pas le futur `reported_manually`. Aucune migration ne convertit les anciennes actions.

Chemins : `apps/api/src/routes/actions.ts`, `packages/db/src/actions.ts`, `packages/db/migrations/0005_action_center.sql`, `apps/web/src/app/dashboard/[projectId]/actions/[actionId]/action-controls.tsx`, `apps/web/src/app/dashboard/[projectId]/actions/[actionId]/page.tsx`.

## Google Search Console et IA

`apps/api/src/integrations/gsc/` contient OAuth en lecture seule, chiffrement du jeton, ingestion Search Analytics, stockage et analyse d’opportunités. L’ingestion groupe date/requête/page/pays/appareil; la requête ne fixe pas de type de recherche et s’appuie donc sur le type par défaut `web`. Le code ne fait pas d’appel à l’API d’inspection d’URL, ne prouve pas que le dernier crawl Google est postérieur à un patch et ne fournit pas encore d’expérience de mesure avec témoin.

La recherche dans `apps/`, `packages/` et `services/` n’a trouvé aucun fournisseur d’IA générative ou de vision raccordé à l’exécution produit. Le cœur de `auditDomain()` indique expressément « Deterministic only — no LLM ». Le schéma NEXUS `packages/contracts/src/schemas/experiment-v1.schema.json` contient `proposed_patch` et `rollback_spec`, mais `rg` n’a trouvé aucun consommateur de déploiement dans le code produit.

À vérifier contre l’API Google avant d’implémenter une intégration : la page officielle Search Analytics API consultée le 2026-10-06 liste `web`, `image`, `video`, `news`, `discover` et `googleNews` pour `type`, sans type multimodal distinct; l’annonce officielle du 2026-09-24 indique une nouvelle ventilation multimodale dans l’interface Search Console. L’exposition correspondante dans l’API reste **non vérifiée**. Sources : <https://developers.google.com/webmaster-tools/v1/searchanalytics/query> et <https://developers.google.com/search/blog/2026/09/web-multimodal-in-sc>.

## Adaptateurs et sécurité observée

À la reconnaissance M0, aucune intégration de publication CMS/Git/edge n’était présente. Depuis, `apps/api/src/autofix/wordpress-adapter.ts` fournit un adaptateur WordPress REST séparé, couvert par un simulateur; il n’est pas branché aux routes, aux stores ni au flux de patch, et n’a pas été validé sur une API WordPress réelle. L’authentification produit comporte sessions et rôles, mais aucune étape 2FA/step-up de publication n’a été trouvée. Le fetch HTTP du crawler valide toutes les réponses A/AAAA et fixe le callback `lookup` du socket à une adresse contrôlée. Les redirections passent chacune par une nouvelle vérification; leur parcours HTTP n’a pas encore de test end-to-end. L’egress demeure nécessaire pour Playwright, qui utilise sa propre résolution DNS.

Décision M0 : démarrer par WordPress natif pour le premier adaptateur CMS faute de connecteur existant, selon l’ordre par défaut du contrat. La publication de métadonnées SEO via WordPress dépend toutefois du plugin présent et de champs REST explicitement exposés; l’intégration doit détecter ces capacités et bloquer en cas de source de vérité ambiguë. L’adaptateur sera testé uniquement contre un simulateur local tant qu’un bac à sable WordPress réel n’aura pas été utilisé : son statut restera « non validé contre l’API réelle ». L’adaptateur manuel restera disponible et son état restera en attente de vérification live.

## État ajouté dans M2 — tranche verticale contrôlée

Le sous-système de correctifs est maintenant relié à l’API et aux stores PostgreSQL dans le mode fixture. Le workflow du dossier apps/api/src/autofix lie l’approbation au hash du diff, calcule le niveau R0/R1, vérifie l’écriture observée et valide le rollback. L’adaptateur apps/api/src/autofix/wordpress-adapter.ts lit les champs REST, contrôle les capacités via OPTIONS, écrit idempotemment après comparaison du hash source, relit et refuse d’écraser une dérive. Le module apps/api/src/autofix/fixture-wordpress.ts adapte ce client à un simulateur REST en processus; ce n’est pas une installation WordPress réelle.

La route de démonstration apps/api/src/routes/autofix.ts construit les preuves à partir du HTML courant. Les valeurs « avant » ne sont plus supposées. Le patch alt est écrit dans le simulateur; le title reste dans le flux manuel, qui n’émet aucun reçu d’écriture. Une vérification avant changement conserve l’état deployed_manually; seule une observation ultérieure du contenu le promeut. Le test apps/api/src/autofix-postgres-routes.integration.test.ts traverse l’API avec PostgreSQL/RLS, le simulateur REST, MFA, les quatre vues UA/mode, les deux rollbacks et la restauration du hash initial. La démonstration est décrite dans docs/autoreglage/DEMO-M2.md.

La migration additive packages/db/migrations/0014_proven_patch_lifecycle.sql permet la taxonomie des statuts de bout en bout. L’interface apps/web/src/app/dashboard/[projectId]/autofix/ affiche les statuts en français, permet d’ouvrir les détails de preuve et de déclarer une publication manuelle. Les anciens événements IMPLEMENTED restent migrés à REPORTED_MANUALLY; ils ne deviennent pas vérifiés sans recrawl.

**Frontière de sécurité M2 :** workflow et adaptateur fixture refusés en production; l’injection d’une page fixture dans le serveur est également refusée en production. L’adaptateur REST n’a pas été validé contre une API WordPress réelle. Il ne faut ni connecter un site de production ni promettre une écriture CMS sûre avant l’audit SSRF/egress d’un connecteur configurable, la détection des plugins SEO, et un essai de contrat sur bac à sable. M2 valide la boucle sur simulateur, pas une installation SaaS de publication.

## Budget de performance du crawler

**Budgets déjà présents, distincts selon le parcours :** `auditDomain()` 15 s et 5 MiB; `createHttpFetcher()` 30 s et 10 MiB par défaut; renderer 20 s de navigation, 750 ms de stabilisation et 2 rendus concurrents. Le parcours de production est aujourd’hui une seule page, sans budget de site entier.

**Budget cible proposé pour l’exploration M3/M4 (pas encore appliqué) :** au plus 200 pages et 500 actifs contrôlés par job; une requête active par origine et délai d’au moins 1 s entre deux requêtes vers la même origine; 15 s et 5 MiB décodés maximum par document; rendu JavaScript limité à un échantillon représentatif par gabarit, 20 s + 1 s de stabilisation, deux rendus simultanés; vérification HTTP d’un actif bornée à 3 s, maximum 20 actifs/page et 500/job; arrêt du job après 5 min cumulées et reprise à la page suivante. Respect de `robots.txt`, des directives de crawl et des réponses 429/503 obligatoire avant augmentation de débit. Mesurer p50/p95, octets, temps CPU et temps de navigateur; arrêter/mettre en pause le job au dépassement. Ce budget est un point de départ pour les fixtures, à ajuster par mesure, jamais une garantie de capacité de production.

## Tests, conventions, état Git

- Racine : `package.json` décrit pnpm workspace, Node `>=22`; `pnpm verify` enchaîne lint, typecheck et tests. CI `.github/workflows/ci.yml` exécute aussi `pnpm format:check`, lint, typecheck et tests avec PostgreSQL 16/Valkey 8. 33 fichiers `.test.ts` ont été recensés.
- `AGENTS.md` ne contient qu’une consigne Turborepo : lire les docs du paquet installé avant de modifier la configuration Turbo. La configuration Turbo n’est pas touchée ici.
- Aucun `README.md` racine n’a été trouvé. `docs/TEST_MATRIX.md`, `docs/BUILD_STATE.md` et `docs/KNOWN_LIMITATIONS.md` existent; la matrice de tests contient des entrées anciennes qui ne reflètent pas toujours le code actuel.
- Le dépôt est sur `main`, HEAD `e67720c`, sans remote Git configuré. Des changements préexistants/non liés sont présents dans le worktree, notamment `.gitignore`, `PROOF_LEDGER.md`, `apps/api/src/integrations/gsc/intelligence.ts`, fichiers de rate-limit, docs de production, migration DB 0008, `.vscode/` et `.wincreator/`. Ils ne doivent pas être écrasés ni attribués aux livrables de cette mission.
- Le benchmark précédent se trouve hors du dépôt source au chemin `/home/wina/WinSEO/BENCHMARK-SEO-AUTO-REGLAGE-2026-10-06.md`; il a été relu et réconcilié dans `DECISIONS.md` et le benchmark augmenté.

## Conclusion M0

Les trois écarts du point de départ sont confirmés. Les acquis à préserver sont les findings déterministes, preuves HTTP, approbation explicite, journal de transition, recrawl, gates GSC et isolation tenant/RLS. Les prochains développements doivent ajouter une chaîne de publication séparée avec états prouvés plutôt que requalifier le `IMPLEMENTED` historique.

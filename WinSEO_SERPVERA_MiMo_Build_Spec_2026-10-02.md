---
title: "WINSEO / SERPVERA"
subtitle: "Product, Search Intelligence & Engineering Blueprint — SaaS SEO + AEO + GEO, evidence-first"
author: "Architecture specification for implementation with MiMo‑V2.6"
date: "02 October 2026"
lang: fr-FR
---

> **Statut du document.** Spécification de conception et d'exécution. Les prix, fonctionnalités concurrentes et documentations externes sont un instantané vérifié au 02/10/2026. Les noms commerciaux et domaines proposés sont des hypothèses de travail : une recherche d'antériorité marque/domaine/raison sociale reste obligatoire avant lancement public.

# Table des matières

**I — Fondations produit et marché** : sections 0 à 5 · mandat, NEXUS, benchmark, recherche GEO, positionnement et naming.

**II — Expérience et acquisition** : sections 6 à 9 · UX, design system, landing/onboarding et SEO du SaaS.

**III — Architecture et moteurs** : sections 10 à 17 · stack, données, crawler, moteur SEO, GSC, GEO Lab, recommandations et verification loop.

**IV — Sécurité et exploitation** : sections 18 à 24 · corrections assistées, sécurité, billing, observabilité, API, monorepo et tests.

**V — Exécution MiMo** : sections 25 à 31 · roadmap, anti-loop, Definition of Done, directive maître, décisions différées, KPI et conclusion.

\newpage

# 0. Mandat produit

L'objectif n'est pas de créer un énième audit SEO qui affiche un score global, une liste d'erreurs et un bouton « générer avec l'IA ». Le produit doit devenir un **système opératoire de Search Intelligence** pour TPE/PME, consultants et agences : il observe les données réellement disponibles, produit des constats traçables, explique la cause probable, propose une action minimale, capture le changement puis vérifie si le résultat attendu est effectivement observé.

La proposition centrale doit tenir en une phrase :

> **Know what to fix. See the evidence. Prove what worked.**

Le moteur de décision est déjà amorcé dans le dépôt privé `winterbim/Next.-SEO-geo-`, branche `bim`, sous le nom **NEXUS Search Intelligence v0.1.0**. Ce dépôt apporte la doctrine de preuve, les workflows SEO/GEO, les schémas de findings et le modèle WinCreator. Le SaaS doit préserver cette discipline, et non la diluer derrière une interface marketing.

## 0.1 Principes non négociables

1. **Evidence before advice.** Toute recommandation importante doit pointer vers des preuves : URL, snapshot HTML/DOM, réponse HTTP, donnée GSC, capture d'un moteur IA, documentation officielle ou source externe datée.
2. **No magical score.** Aucun score global ne doit être présenté comme « probabilité de ranking ». Les scores de synthèse internes sont des heuristiques transparentes, jamais des métriques de moteur.
3. **First-party first.** Search Console, analytics, logs, crawl propre et historique du site ont priorité sur les estimations tierces.
4. **SEO + AEO + GEO = une seule chaîne de diagnostic.** Le produit sépare les étapes — découverte, crawl, indexation, retrieval, citation, absorption, mention — au lieu de coller l'étiquette GEO sur des conseils SEO classiques.
5. **Measure stochastic systems repeatedly.** Une réponse IA isolée ne prouve pas une visibilité stable.
6. **Human approval for mutations.** Toute correction automatique touchant le site doit être proposée en diff/PR/draft et vérifiable avant production, sauf opt-in explicite et réversible.
7. **Security by architecture.** Un crawler SaaS qui accepte une URL utilisateur est une surface SSRF critique ; le multi-tenant est une frontière de sécurité, pas un simple champ `tenant_id`.
8. **Loop engineering.** Toute intervention matérialisée devient une expérience : baseline → changement → fenêtre de mesure → vérification → verdict → apprentissage.
9. **WinCreator proof kernel.** Builder et Skeptic sont séparés pour les affirmations matérielles. Les statuts `PENDING`, `BLOCKED`, `DISPROVEN` et `INSUFFICIENT` restent visibles.
10. **Cost-aware by design.** Les opérations coûteuses (browser rendering, SERP/AI checks, gros crawls) sont mesurées, mises en cache et quota-limitées.

\newpage

# 1. Actif existant : NEXUS n'est pas un prototype marketing

Le dépôt NEXUS possède déjà la partie la plus difficile à inventer correctement : une méthode. Il doit devenir le **domain kernel** du SaaS plutôt qu'être réécrit comme une suite de prompts.

## 1.1 Capacités déjà identifiées dans NEXUS

- **Doctrine de preuve** — **Ce qui existe:** `Claim → Gate → Capture → Review → Verdict`; **Transformation SaaS requise:** Entités `Finding`, `Evidence`, `Gate`, `Verdict`, UI Evidence Ledger
- **Classification épistémique** — **Ce qui existe:** OBSERVED / MEASURED / DOCUMENTED / INFERRED / HYPOTHESIS / UNKNOWN; **Transformation SaaS requise:** Badge + filtre + règle de propagation dans les rapports
- **SEO technique** — **Ce qui existe:** HTTP probe, robots, canonical, sitemap, source/render distinction; **Transformation SaaS requise:** crawler distribué + Playwright + historique + diff
- **Business intent** — **Ce qui existe:** objectifs, marchés, conversions, langues; **Transformation SaaS requise:** onboarding guidé + configuration projet
- **Content/topic authority** — **Ce qui existe:** graphe sujets/entités, cannibalisation, intent; **Transformation SaaS requise:** analyse sémantique + GSC + graphe interne
- **Local search** — **Ce qui existe:** cohérence NAP, pages locales, signaux locaux; **Transformation SaaS requise:** module optionnel, connecteurs et preuves publiques
- **AI discovery** — **Ce qui existe:** robots et bot access; **Transformation SaaS requise:** crawler-policy matrix par moteur
- **GEO Lab** — **Ce qui existe:** prompts répétés, locale/langue, citations, stabilité; **Transformation SaaS requise:** scheduler, capture browser/API autorisée, distributions
- **Citation graph** — **Ce qui existe:** sélection vs absorption; **Transformation SaaS requise:** tables citations/source pages + evidence viewer
- **Opportunity portfolio** — **Ce qui existe:** valeur, preuve, impact, confiance, effort, risque; **Transformation SaaS requise:** Action Center et priorisation transparente
- **Experiment plan** — **Ce qui existe:** baseline, change, control, confounders, rollback; **Transformation SaaS requise:** Experiment Ledger et verification jobs
- **Skeptic** — **Ce qui existe:** revue adverse séparée; **Transformation SaaS requise:** second-pass validator + règles déterministes + tests


**Décision d'architecture :** le code NEXUS reste un package métier versionné. L'application l'appelle via une interface stable. L'UI ne doit pas implémenter les règles SEO elle-même.

## 1.2 Modèle de preuve à préserver

Chaque finding doit au minimum exposer :

- `finding_id`, `project_id`, `rule_id`, `scope`, `severity` et `epistemic_class` ;
- une phrase de constat qui ne dépasse pas ce que les données démontrent ;
- `evidence_ids[]` ;
- pages/entités affectées ;
- une explication du mécanisme ;
- une recommandation ;
- un `verification_gate` ;
- `confidence` explicite ;
- `first_seen_at`, `last_seen_at`, `resolved_at` ;
- un hash de la règle et de la version moteur pour reproduire le résultat.

Le produit peut dire « canonical contradictoire observé sur 7 pages » ; il ne doit pas dire « Google vous pénalise à cause du canonical » sans preuve suffisante.

# 2. Analyse du marché : ce qu'il faut apprendre, pas copier

Le marché 2026 s'est scindé en quatre familles : suites SEO historiques, crawlers techniques, outils content intelligence et plateformes AI-search/AEO. Le futur produit doit combiner les forces de chaque famille sans absorber leur complexité.

## 2.1 Matrice concurrentielle vérifiée

- **Semrush** — **Force méthodologique à récupérer:** profondeur de suite, Site Audit structuré, prompts IA quotidiens, benchmark concurrence; **Limite/opportunité pour notre produit:** coût élevé et surface fonctionnelle très large ; transformer la donnée en plan court reste un enjeu; **Indication tarifaire observée:** AI Visibility Base **$99/mo/domain** annuel; **Source:** [S01]
- **Ahrefs** — **Force méthodologique à récupérer:** index propriétaire, Site Audit, Brand Radar, modèle de coût par check explicite; **Limite/opportunité pour notre produit:** impossible/inutile de répliquer l'index backlinks au MVP ; acheter les données si besoin; **Indication tarifaire observée:** Brand Radar dès **$199/mo**, custom checks **$50/2,500**; **Source:** [S02][S03]
- **Screaming Frog** — **Force méthodologique à récupérer:** rendu Chromium, source-vs-render, intégration GSC/PageSpeed, crawl technique très précis; **Limite/opportunité pour notre produit:** UX expert et desktop ; notre avantage = cloud + explication + verification loop; **Indication tarifaire observée:** licence séparée, pas cible pricing directe; **Source:** [S04]
- **Sitebulb** — **Force méthodologique à récupérer:** **Hints** explicatifs et priorisés, Chrome crawler, visualisations pédagogiques; **Limite/opportunité pour notre produit:** forte inspiration pour les cartes « pourquoi / preuve / correction »; **Indication tarifaire observée:** selon plan; **Source:** [S05]
- **SE Ranking** — **Force méthodologique à récupérer:** audit + monitoring de changements + AI Overviews + API; **Limite/opportunité pour notre produit:** bonne couverture générale ; différencier par preuve et expérimentation; **Indication tarifaire observée:** plan/add-ons selon usage; **Source:** [S06]
- **Sitechecker** — **Force méthodologique à récupérer:** to-do list priorisée, alertes nouveaux/fixed, GSC/GA4, monitoring; **Limite/opportunité pour notre produit:** excellente simplicité SMB à dépasser avec causalité et evidence ledger; **Indication tarifaire observée:** selon plan; **Source:** [S07]
- **Ubersuggest** — **Force méthodologique à récupérer:** prix accessible, onboarding simple, all-in-one; **Limite/opportunité pour notre produit:** profondeur moindre = fenêtre de marché sur 10–60 €/mois; **Indication tarifaire observée:** individuel autour de **$29/mo**; **Source:** [S08]
- **Surfer** — **Force méthodologique à récupérer:** workflow page-level, GSC + SERP, éditeur orienté action; **Limite/opportunité pour notre produit:** centré contenu ; notre produit doit diagnostiquer avant de réécrire; **Indication tarifaire observée:** selon plan; **Source:** [S09]
- **MarketMuse** — **Force méthodologique à récupérer:** Topic Authority + Personalized Difficulty, priorisation par autorité propre au site; **Limite/opportunité pour notre produit:** très bon concept de contextualisation, à réinterpréter avec données explicables; **Indication tarifaire observée:** selon plan; **Source:** [S10]
- **OtterlyAI** — **Force méthodologique à récupérer:** tracking AI simple, quotas de prompts très lisibles, quotidien; **Limite/opportunité pour notre produit:** bon modèle d'entrée mais peu de profondeur technique SEO; **Indication tarifaire observée:** Lite **$29/mo / 15 prompts**; **Source:** [S11][S12]
- **Peec AI** — **Force méthodologique à récupérer:** capture multi-engines, sources/citations, gap concurrents, actions; **Limite/opportunité pour notre produit:** très bon AEO spécialisé ; notre avantage = SEO technique + post-change verification; **Indication tarifaire observée:** vendor methodology; **Source:** [S13]
- **Profound** — **Force méthodologique à récupérer:** Answer Engine Insights, FactCheck, citations, browser capture, Agent Analytics; **Limite/opportunité pour notre produit:** référence enterprise AI visibility ; trop lourd/coûteux pour SMB; **Indication tarifaire observée:** enterprise-led; **Source:** [S14][S15][S16]
- **Search Intelligence AI** — **Force méthodologique à récupérer:** **boucle très proche** : domaine → facts → prompts → fanouts → citations → briefs → contenu → GSC; **Limite/opportunité pour notre produit:** concurrent stratégique direct ; il faut aller plus loin sur la preuve technique et les gates; **Indication tarifaire observée:** plan brand indiqué autour de **£199/mo** lors de l'analyse; **Source:** [S17]
- **CiteRank** — **Force méthodologique à récupérer:** score fondé sur de vrais checks, texte de réponse conservé, mention ≠ citation, historique quotidien; **Limite/opportunité pour notre produit:** modèle de mesure clair ; ne pas réduire le produit à un pourcentage de visibilité; **Indication tarifaire observée:** private/beta selon offre; **Source:** [S18]
- **SearchProof AI** — **Force méthodologique à récupérer:** audit SEO/AEO/GEO public fondé sur preuves et validation hebdomadaire; **Limite/opportunité pour notre produit:** preuve que « evidence-first » devient un axe concurrentiel : il faut rendre la boucle d'action plus forte; **Indication tarifaire observée:** pricing local; **Source:** [S19]
- **Oscar AI** — **Force méthodologique à récupérer:** audit → production d'articles → publication CMS ; simplicité pour TPE; **Limite/opportunité pour notre produit:** ne pas concurrencer sur volume d'articles ; diagnostiquer avant de produire; **Indication tarifaire observée:** **95 € HT/mo** pour 7 articles, annuel; **Source:** [S20]


## 2.2 Les meilleurs patterns observés

### Pattern A — Technical truth layer

Screaming Frog et Sitebulb montrent que le crawl sérieux ne se limite pas au HTML initial : source, rendu, status chain, canonical, robots, liens internes, données structurées et signaux de performance doivent être inspectés. Le rendu JS doit être **sélectif** afin de contrôler le coût, mais disponible dès qu'un écart source/render est plausible.

**Décision :** deux modes crawler : `HTTP_FAST` puis `RENDERED_ESCALATION`. Une règle peut demander l'escalade au navigateur uniquement lorsqu'elle en a besoin.

### Pattern B — Prioritized hints, not raw errors

Sitebulb et Sitechecker rendent le diagnostic compréhensible en expliquant pourquoi un problème compte. WinSEO doit aller plus loin : un finding doit avoir **preuve + mécanisme + impact hypothétique + effort + gate**.

### Pattern C — First-party data as truth

Surfer et les suites classiques gagnent beaucoup de valeur lorsqu'elles combinent crawl et Search Console. Google précise que l'API Search Analytics ne garantit pas toutes les lignes et privilégie les principales ; le SaaS doit donc afficher cette limitation plutôt que présenter le dataset comme exhaustif. [S25]

### Pattern D — AI visibility = dataset de réponses, pas opinion d'un LLM

Profound, CiteRank, Peec et Otterly construisent une série temporelle de réponses. CiteRank sépare explicitement mention, position relative et citation et conserve l'évidence derrière la cellule. [S18] C'est exactement la bonne direction, mais NEXUS doit ajouter les répétitions, paraphrases et intervalles de stabilité.

### Pattern E — Citations as a source graph

Profound catégorise les sources (owned, competitor, earned media, social, institution, etc.) et transforme les citations en stratégie de contenu/outreach. [S15] Peec suit une logique comparable. La plateforme doit produire un **Source Opportunity Graph**, pas simplement un compteur.

### Pattern F — From insight to action

Profound a rapproché l'agent d'analyse de chaque graphique ; Search Intelligence AI va jusqu'au contenu et à la publication. [S16][S17] Notre différenciation : **l'action n'est jamais considérée comme finie tant que son gate n'est pas repassé**.

# 3. Ce que la recherche 2023–2026 change dans le produit

La littérature GEO récente renforce la doctrine NEXUS : les systèmes génératifs sont variables, les effets sont fortement dépendants du moteur et du contexte, et une optimisation générique peut être inefficace ou contre-productive. [S31][S32][S33][S34]

## 3.1 Règles scientifiques de conception

- **Répéter, ne pas snapshotter.** Le travail « Don't Measure Once » traite la visibilité AI-search comme une mesure stochastique et justifie l'usage de répétitions et de distributions plutôt qu'une seule réponse. [S32]
- **Sélection ≠ absorption.** Une page peut être citée sans contribuer matériellement à la réponse. NEXUS doit donc conserver deux métriques séparées. [S33]
- **Diagnostiquer le stage de panne.** Une absence de citation peut venir de la découverte, du retrieval, de la sélection, de la citation ou de l'absorption ; les réparations doivent être ciblées. [S34]
- **Ne pas vendre de hack universel.** Une synthèse 2026 souligne la faiblesse des règles transversales garanties entre moteurs. [S35]
- **SEO fondamental reste valable pour Google.** Google indique explicitement qu'il n'existe pas de fichier `llms.txt` ou de schéma spécial nécessaire à ses fonctions génératives et que les bonnes pratiques SEO restent fondamentales. [S21][S22]
- **OAI-SearchBot et GPTBot sont distincts.** OpenAI documente OAI-SearchBot pour Search et GPTBot pour le contrôle du crawl de formation ; le diagnostic doit les séparer. [S23]
- **IndexNow est un signal, pas une garantie d'indexation.** [S24]

## 3.2 Conséquence produit

La plateforme ne doit jamais afficher « GEO optimized = YES ». Elle doit afficher :

- ce qui est techniquement accessible ;
- ce qui a été observé dans les réponses ;
- la fréquence et la variabilité ;
- les sources utilisées ;
- l'étape probable où la marque/page disparaît ;
- l'action proposée ;
- la méthode de re-mesure.

![Boucle de preuve et d'amélioration](product_loop.png){ width=95% }

# 4. Positionnement : la catégorie à créer

Le produit doit se présenter comme **Search Intelligence + Verification**, pas comme « AI SEO Writer ».

## 4.1 ICP initial

Le meilleur segment d'entrée est :

- propriétaire/dirigeant de site 10–5 000 pages qui ne veut pas apprendre Semrush ;
- consultant SEO/web qui gère 3–20 clients et veut une preuve propre de ses interventions ;
- petite agence qui veut fournir un dashboard white-label sans empiler cinq outils ;
- équipe marketing PME qui possède GSC mais ne sait pas traduire les données en actions.

Le produit ne doit pas viser au départ les équipes enterprise qui exigent un index backlinks global, des centaines de millions de keywords ou une infrastructure de crawling de niveau Ahrefs.

## 4.2 Proposition de valeur par couche

- **Observe** — **Promesse:** Crawl, GSC, analytics, changements, AI answers et citations au même endroit
- **Explain** — **Promesse:** « ce qui a changé, pourquoi c'est important, ce que les preuves permettent réellement de conclure »
- **Decide** — **Promesse:** top actions ordonnées par valeur / preuve / impact / confiance / effort / risque
- **Execute** — **Promesse:** diff, PR GitHub ou brouillon CMS ; jamais une mutation opaque
- **Verify** — **Promesse:** re-crawl + re-query + GSC window + verdict du gate
- **Learn** — **Promesse:** historique des actions efficaces/inefficaces par projet, sans réécrire le passé


## 4.3 Signature fonctionnelle

Le dashboard doit répondre en moins d'une minute à quatre questions :

1. **What changed?**
2. **Why does it matter?**
3. **What should I do next?**
4. **Did the last changes work?**

Tout écran qui n'aide pas une de ces questions doit justifier sa présence.

# 5. Naming : WinSEO comme codename, marque publique à sécuriser

Une recherche préliminaire montre que `WinSEO` est déjà utilisé par plusieurs acteurs du référencement, notamment `winseo.fr`, et qu'une publication INPI historique contient le signe verbal `winseo`. [S28][S29] Cela ne constitue pas un avis juridique sur la portée des droits, mais c'est suffisant pour **ne pas engager un lancement public ou un dépôt de domaine coûteux sans clearance**.

## 5.1 Recommandation de marque

**Codename interne : `WinSEO`.**

**Candidat externe prioritaire de travail : `SERPVERA`.** Le nom associe SERP + *vera* (vrai/vérifiable) et colle à l'ADN evidence-first. Au moment de cette étude, une recherche web exacte n'a pas fait ressortir de marque SEO évidente portant ce nom ; ce constat n'est **pas** une recherche d'antériorité juridique et ne garantit ni domaine ni marque.

Alternatives à tester juridiquement : `VeriSERP`, `ProofCrawl`, `SearchVera` et une marque totalement inventée sans « SEO ». Certains noms intuitifs sont déjà occupés (`RankLedger`, `SearchLedger`, `RankVera`, `SearchProof AI`) et doivent être évités. [S36][S37][S38][S19]

## 5.2 Règles de domaine

- priorité à un domaine court, prononçable en FR/EN et sans tiret ;
- `.com` si disponible et juridiquement sûr ; `.io` ou `.app` possibles pour l'application, mais le TLD ne remplace pas la confiance de marque ;
- marketing sur `brand.tld`, produit sur `app.brand.tld` ;
- documentation sur `docs.brand.tld` ou `/docs` ;
- ne pas choisir un exact-match domain artificiel du type `best-seo-aeo-geo-tool...` ;
- vérifier EUIPO, WIPO, INPI et registres des marchés ciblés ;
- rechercher homophones, sociétés et produits SaaS voisins avant identité visuelle.

# 6. Information architecture UX

La navigation doit rester stable et courte :

- **Overview** — **Question utilisateur:** Que se passe-t-il ?
- **Actions** — **Question utilisateur:** Qu'est-ce que je fais maintenant ?
- **SEO** — **Question utilisateur:** Quels obstacles techniques/search classiques ?
- **AI Search** — **Question utilisateur:** Où ma marque apparaît-elle dans les réponses IA ?
- **Content & Entities** — **Question utilisateur:** Quels sujets, entités et pages manquent ou se cannibalisent ?
- **Competitors** — **Question utilisateur:** Où sont les écarts observables ?
- **Changes** — **Question utilisateur:** Qu'est-ce qui a changé sur le site ou dans les métriques ?
- **Experiments** — **Question utilisateur:** Qu'avons-nous modifié et quel est le verdict ?
- **Evidence** — **Question utilisateur:** Puis-je vérifier le constat ?
- **Integrations** — **Question utilisateur:** Quelles données sont connectées ?
- **Settings** — **Question utilisateur:** Marchés, limites, membres, sécurité, billing


## 6.1 Page Overview

Le haut de page ne doit pas afficher dix KPI. Il comporte quatre cartes maximum :

- `Verified issues` — nombre de problèmes ouverts dont la preuve est valide ;
- `Actions ready` — actions approuvables maintenant ;
- `Changes verified` — interventions dont le gate a récemment donné un verdict ;
- `AI coverage` — mention/citation observée sur un dataset clairement défini, avec intervalle/window.

Sous ces cartes :

- **What changed** : événements corrélés dans le temps (déploiement, title modifié, crawl issue, GSC movement, AI citation) ;
- **Next best action** : une carte P1 avec preuve et gate ;
- **Performance vs interventions** : courbe métrique + marqueurs de changements, sans prétendre à la causalité ;
- **Evidence freshness** : état des connecteurs/crawls.

![Wireframe directionnel du dashboard](dashboard_wireframe.png){ width=96% }

## 6.2 Anatomy d'une Action Card

Une Action Card est l'unité de valeur du produit. Elle contient :

**Finding.** « 7 pages stratégiques émettent un canonical qui ne correspond pas à la destination sitemap. »

**Evidence.** liens vers les snapshots, la règle, les URLs et la date.

**Why it matters.** explication du mécanisme, formulée conditionnellement si l'impact moteur n'est pas directement prouvé.

**Affected business scope.** pages commerciales, impressions/clicks/conversions associés si disponibles.

**Recommendation.** changement le plus petit possible.

**Confidence.** calcul documenté à partir de la qualité de preuve, jamais d'une intuition de LLM.

**Implementation.** Copy fix / Create GitHub PR / Create CMS draft / Ignore with reason.

**Verification gate.** ce qui devra devenir vrai après intervention.

**Rollback.** méthode automatique ou instruction concise.

# 7. Design system : B2B search intelligence, pas « AI builder »

L'identité doit inspirer contrôle, clarté et mesure. Éviter le gradient violet/rose omniprésent, les orbes 3D, les étoiles « sparkle », les chat bubbles géantes et les dashboards saturés de gauges.

## 7.1 Palette recommandée

- **`ink-950`** — **Valeur:** `#0B1220`; **Usage:** navigation, texte principal, confiance
- **`slate-700`** — **Valeur:** `#334155`; **Usage:** texte secondaire
- **`surface`** — **Valeur:** `#F7F9FC`; **Usage:** fond général
- **`panel`** — **Valeur:** `#FFFFFF`; **Usage:** cartes
- **`line`** — **Valeur:** `#E2E8F0`; **Usage:** frontières
- **`primary`** — **Valeur:** `#5B5CE2`; **Usage:** actions, séries principales
- **`verified`** — **Valeur:** `#0F9F7A`; **Usage:** preuve/gate validé
- **`geo`** — **Valeur:** `#7C3AED`; **Usage:** AI Search uniquement, en accent
- **`warning`** — **Valeur:** `#D97706`; **Usage:** hypothèse/attention
- **`critical`** — **Valeur:** `#DC2626`; **Usage:** erreur bloquante, jamais décoration


Le statut ne doit jamais dépendre de la couleur seule : icône + texte + couleur.

## 7.2 Typographie

- **UI : Inter / Geist Sans**, 14–16 px base, chiffres tabulaires pour métriques ;
- **Display : Inter Display / Geist**, peu de variations ;
- **Evidence / code : IBM Plex Mono ou JetBrains Mono**, uniquement pour URL, hash, rule IDs et captures techniques ;
- largeur de ligne marketing 60–75 caractères ; dashboard dense mais respirant.

## 7.3 Graphiques autorisés

- séries temporelles avec marqueurs d'intervention ;
- small multiples par moteur/locale ;
- barres de couverture/mention/citation avec dénominateur visible ;
- matrice `Impact × Confidence` pour actions ;
- stacked bar par classe de source ;
- graphe léger URL ↔ sujet ↔ entité ↔ citation ;
- heatmap de stabilité par prompt/engine ;
- waterfall de pertes/gains seulement si définitions stables.

À éviter : speedometers, donut charts pour cinq métriques différentes, score unique 0–100 sans décomposition, « +37% opportunity » sans méthode.

# 8. Landing page et conversion

Le marketing doit démontrer le produit avant de demander une carte bancaire.

## 8.1 Hero recommandé

**H1 EN :** `Know what to fix. Prove what worked.`

**Sous-titre :** `Technical SEO, Search Console and AI-search visibility in one evidence-first workflow.`

**CTA primaire :** champ domaine + `Run free audit`.

**CTA secondaire :** `See the methodology`.

Sous le CTA : `No credit card · public pages only · evidence URLs included`.

La version française peut traduire le message, mais garder une architecture d'URL internationale propre (`/fr/`, `/en/`) si les deux langues sont visées.

## 8.2 Public scan sans compte

Le free scan est un canal d'acquisition, pas une démo factice. Pipeline :

`URL → SSRF validation → robots/policy → limited crawl (20–50 URLs) → deterministic checks → evidence sample → result page`.

La page de résultat montre :

- 3 problèmes vérifiés ;
- 2 opportunités ;
- 1 exemple d'evidence card ;
- ce qui **n'a pas pu être prouvé** sans GSC ;
- CTA `Connect Search Console to unlock performance diagnosis`.

Le compte est demandé **après** que l'utilisateur a vu de la valeur.

## 8.3 Onboarding authentifié

1. Créer un compte par passkey/OAuth ou email sécurisé.
2. Ajouter/vérifier le domaine.
3. Connecter GSC (scope readonly par défaut).
4. Détecter organisation, services, pays, langues et entités depuis le site.
5. Faire confirmer ces données au client — l'IA ne décide pas seule du business model.
6. Choisir les objectifs : leads, ecommerce, trafic informationnel, local, brand/AI visibility.
7. Construire la baseline.
8. Générer les premières actions.
9. Proposer le module AI Search seulement une fois les prompts/jobs-to-be-done confirmés.

# 9. SEO du SaaS lui-même

Le site doit être son propre cas de démonstration. La stratégie ne repose pas sur le mot-clé de marque « WinSEO », mais sur un **cluster de pages qui répond aux jobs-to-be-done**.

## 9.1 Architecture publique cible

- **`/`** — **Intention:** marque + proposition
- **`/seo-audit`** — **Intention:** audit SEO actionnable
- **`/technical-seo-audit`** — **Intention:** crawl/indexabilité/JS
- **`/google-search-console-analyzer`** — **Intention:** diagnostic GSC
- **`/seo-monitoring`** — **Intention:** changement/régression
- **`/ai-search-visibility`** — **Intention:** catégorie AI visibility
- **`/geo-audit`** — **Intention:** Generative Engine Optimization
- **`/aeo-audit`** — **Intention:** Answer Engine Optimization
- **`/chatgpt-visibility`** — **Intention:** moteur spécifique
- **`/google-ai-mode-tracker`** — **Intention:** moteur spécifique
- **`/perplexity-visibility`** — **Intention:** moteur spécifique
- **`/methodology`** — **Intention:** preuve + mesure + définitions
- **`/security`** — **Intention:** sécurité et traitement des données
- **`/pricing`** — **Intention:** plans, quotas et checks
- **`/integrations/google-search-console`** — **Intention:** intégration
- **`/integrations/github`** — **Intention:** corrections via PR
- **`/integrations/wordpress`** — **Intention:** drafts CMS
- **`/for/small-business`** — **Intention:** ICP
- **`/for/agencies`** — **Intention:** ICP
- **`/compare/semrush-alternative`** — **Intention:** comparaison factuelle et maintenue
- **`/compare/ahrefs-alternative`** — **Intention:** comparaison factuelle et maintenue


Les pages de comparaison doivent être factuelles, datées et mises à jour automatiquement via un contenu éditorial validé ; ne jamais inventer des fonctionnalités concurrentes.

## 9.2 Structured data et contenu

Utiliser les types Schema.org pris en charge lorsqu'ils correspondent réellement au contenu (`Organization`, `SoftwareApplication`, `FAQPage` uniquement si éligible/pertinent, etc.). Aucun « GEO schema » fictif. Google indique qu'aucun markup spécial n'est nécessaire pour ses fonctions génératives. [S22]

Le `/methodology` doit devenir une page de confiance publique : définitions du score éventuel, formule, données exclues, limites GSC, cadence AI, moteurs/locale, conservation des réponses, politique de changements de méthodologie.

# 10. Architecture logicielle cible

L'architecture doit être **modulaire, event-driven et séparée entre control plane et workers non fiables**.

![Architecture SaaS recommandée](architecture.png){ width=98% }

## 10.1 Stack de référence

- **Marketing + App** — **Choix recommandé:** Next.js App Router, TypeScript, React; **Raison:** SSR/SEO, product web mature, partage types
- **UI** — **Choix recommandé:** Tailwind + Radix/shadcn primitives, TanStack Table; **Raison:** accessibilité + vitesse sans look template par défaut
- **Charts** — **Choix recommandé:** ECharts ou Recharts selon besoin; **Raison:** séries, heatmaps, interactions
- **API/BFF** — **Choix recommandé:** TypeScript (Fastify/Nest léger ou routes dédiées); **Raison:** auth, tenancy, orchestration API
- **Domain engine** — **Choix recommandé:** Python 3.12 package NEXUS; **Raison:** réutiliser les règles/scripts existants
- **Async workflow** — **Choix recommandé:** queue durable au MVP, Temporal à l'échelle; **Raison:** retries/idempotence/long jobs
- **DB** — **Choix recommandé:** PostgreSQL 16+; **Raison:** modèle relationnel + RLS + JSONB
- **Cache/queue** — **Choix recommandé:** Redis/Valkey; **Raison:** jobs courts, rate limit, dedup
- **Evidence store** — **Choix recommandé:** S3-compatible object storage; **Raison:** HTML/DOM/captures compressées
- **Browser workers** — **Choix recommandé:** Playwright/Chromium en conteneurs isolés; **Raison:** rendu JS et AI UI lorsque autorisé
- **Search vector** — **Choix recommandé:** pgvector optionnel; **Raison:** similarité sujets/pages, pas source de vérité
- **Observability** — **Choix recommandé:** OpenTelemetry + logs structurés + error tracking; **Raison:** preuve d'exploitation
- **Billing** — **Choix recommandé:** Stripe Checkout/Customer Portal; **Raison:** ne pas stocker de carte
- **Email** — **Choix recommandé:** provider transactionnel; **Raison:** verification, alerts, billing


**Règle :** ne pas introduire Kubernetes au MVP. Conteneurs managés + autoscaling suffisent tant que les SLOs et coûts le permettent.

# 11. Modèle de données canonique

Chaque table tenant-scoped contient `organization_id`, et la politique RLS doit être forcée sur les tables classées tenant-owned.

## 11.1 Core identity

- `users(id, email, auth_subject, created_at, last_login_at)`
- `organizations(id, name, slug, plan_id, region, created_at)`
- `memberships(user_id, organization_id, role, status)`
- `projects(id, organization_id, primary_domain, timezone, default_locale, status)`
- `project_markets(project_id, country, language, priority)`
- `competitors(id, project_id, canonical_domain, aliases[])`

## 11.2 Crawl / page intelligence

- `crawl_runs(id, project_id, mode, seed_strategy, started_at, completed_at, engine_version, status)`
- `urls(id, project_id, normalized_url, url_hash, first_seen_at, last_seen_at)`
- `page_snapshots(id, crawl_run_id, url_id, http_status, final_url, content_hash, headers_json, object_key_source, object_key_rendered, fetched_at)`
- `link_edges(crawl_run_id, from_url_id, to_url_id, rel, anchor_hash, discovered_in)`
- `structured_data_items(snapshot_id, type, canonical_json_hash, validity)`
- `robots_observations(crawl_run_id, host, user_agent, allowed, rule_source, evidence_id)`

## 11.3 Evidence / findings

- `findings(id, project_id, rule_id, rule_version, title, epistemic_class, severity, status, confidence, first_seen, last_seen)`
- `finding_scopes(finding_id, url_id?, entity_id?, query_cluster_id?)`
- `evidence_items(id, project_id, kind, source_ref, captured_at, content_hash, object_key, metadata_json)`
- `finding_evidence(finding_id, evidence_id, relation)`
- `verification_gates(id, finding_id, gate_type, spec_json, last_verdict)`

## 11.4 Search Console / analytics

- `gsc_properties(id, project_id, external_property, encrypted_token_ref, scope)`
- `gsc_daily(project_id, date, query_hash?, page_url_id?, country?, device?, search_type, clicks, impressions, ctr, position)`
- `analytics_daily(project_id, date, page_url_id, sessions, conversions, revenue?)`

Conserver les données agrégées nécessaires au produit ; éviter d'aspirer des PII analytics inutiles.

## 11.5 AI Search / GEO

- `prompt_sets(id, project_id, name, version, frozen_at)`
- `prompts(id, prompt_set_id, canonical_text, intent, funnel_stage, locale, persona, active)`
- `prompt_variants(id, prompt_id, text, variant_type)`
- `ai_runs(id, prompt_variant_id, engine, surface, locale, started_at, completed_at, capture_method, engine_label, status)`
- `ai_answers(id, ai_run_id, text_object_key, answer_hash, brand_mentioned, mention_positions_json)`
- `citations(id, ai_answer_id, cited_url, domain, order_index, source_class, client_owned)`
- `citation_absorption(ai_answer_id, citation_id, method, support_score, evidence_id)`

## 11.6 Action / experiment loop

- `actions(id, project_id, finding_id, recommendation_version, priority_index, state, owner_user_id)`
- `action_changes(id, action_id, target_type, target_ref, before_hash, proposed_patch, rollback_spec)`
- `experiments(id, project_id, action_id, hypothesis, baseline_window, measurement_window, confounders_json, status)`
- `experiment_events(experiment_id, event_type, timestamp, payload_json)`
- `verification_runs(id, experiment_id, gate_id, verdict, evidence_ids[], run_at)`

# 12. Crawler : moteur technique et frontière de sécurité

Un audit public donne au serveur l'ordre d'aller chercher une URL. Sans isolation, c'est une fonction SSRF. OWASP recommande notamment de traiter avec prudence les redirections, la résolution DNS et les IP internes/link-local. [S27]

## 12.1 URL normalization

Avant toute requête :

- parser avec une bibliothèque URL standard ;
- accepter uniquement `http`/`https` ;
- IDNA/punycode normalisé ;
- supprimer fragment ;
- canonicaliser host/port ;
- refuser credentials embedded (`user:pass@host`) ;
- limiter longueur de l'URL ;
- normaliser query selon politique de crawl, sans supprimer arbitrairement des paramètres business.

## 12.2 SSRF guard obligatoire

Pour chaque connexion et **chaque redirect** :

- résoudre A et AAAA ;
- refuser loopback, RFC1918, link-local, multicast, unspecified, CGNAT, metadata endpoints et plages internes cloud ;
- empêcher DNS rebinding en revalidant l'IP résolue au moment de la connexion ;
- aucun accès au réseau de contrôle/database/secrets depuis les workers ;
- egress firewall : Internet public seulement ;
- désactiver les protocoles non HTTP(S) ;
- caper redirects (ex. 5) et revalider chaque hop ;
- caper taille réponse, temps, compression ratio et content-types ;
- ne jamais transmettre cookies/auth headers d'un domaine à un autre.

Le crawler public ne possède **aucun secret de tenant**. Les tokens GSC/CMS ne sont accessibles qu'aux services d'intégration, pas au worker qui visite du contenu arbitraire.

## 12.3 Politeness et robots

- user-agent stable et documenté ;
- robots.txt respecté pour les audits anonymes ;
- budgets host-level et tenant-level ;
- rate limiting adaptatif ;
- retry avec backoff ;
- sitemap discovery ;
- option de crawl authentifié uniquement dans un environnement séparé et après preuve de propriété.

## 12.4 Two-pass rendering

**Pass 1 — HTTP_FAST :** source HTML, headers, status/redirect, links, canonicals, robots/meta, JSON-LD, content fingerprint.

**Pass 2 — RENDERED_ESCALATION :** déclenché si app JS, contenu principal absent, liens injectés, meta/canonical divergent, ou échantillon de contrôle. Playwright tourne dans un conteneur éphémère sans credential et avec mêmes règles SSRF/egress.

# 13. Moteur SEO déterministe

Les checks déterministes doivent être préférés aux LLM pour tout ce qui est observable mécaniquement.

## 13.1 Familles de règles V1

**Crawl/indexability** : status chains, robots, meta robots, X-Robots-Tag, canonical, sitemap membership, orphan candidates, nofollow graph.

**On-page** : title/description, H1, duplication, language/hreflang, thin extraction signal (pas verdict de qualité), content main extraction.

**Architecture** : depth, internal links, broken links, redirect hops, orphan candidates, PageRank-like internal flow transparent, click depth.

**Structured data** : JSON parse, Schema type, required/recommended properties selon documentation intégrée et versionnée ; aucun « rich result guaranteed ».

**JS** : source vs rendered diff pour title, canonical, robots, main text, links.

**Media** : alt coverage, dimensions, lazy loading, heavy assets, image discoverability.

**Performance** : intégrer CrUX/PageSpeed si disponible ; distinguer lab vs field.

**Security/search hygiene** : HTTPS, mixed content, accidental staging exposure, sensitive obvious files — sans scanner offensivement les sites.

## 13.2 Rule contract

```yaml
rule_id: TECH.CANONICAL.CONFLICT
version: 1.2.0
input:
  - page_snapshot
  - sitemap_membership
output:
  epistemic_class: OBSERVED
  severity: high
  finding_template: "Canonical conflicts with selected sitemap URL"
evidence:
  required:
    - source_html_fragment
    - canonical_target
    - sitemap_record
verification_gate:
  type: recrawl_rule_absent
false_positive_notes:
  - cross-domain syndication may be intentional
```

Le LLM peut expliquer le résultat au client ; il ne décide pas si le canonical existe.

# 14. Search Console Intelligence

Search Console doit être la colonne vertébrale économique du produit. Elle donne au client ses propres données plutôt que de tenter de reproduire un index global coûteux.

## 14.1 Ingestion

- OAuth `webmasters.readonly` par défaut ;
- chiffrement du refresh token via KMS/envelope encryption ;
- ingestion journalière par dimensions utiles et fenêtres glissantes ;
- pagination 25k et connaissance de la limite d'exposition ; Google indique que l'API ne garantit pas toutes les lignes et expose une limite de données. [S25][S26]
- `dataState` final par défaut ; fresh data marqué `PRELIMINARY`.

## 14.2 Analyses actionnables

- impressions ↑, CTR ↓, position stable → snippet/intent candidate, pas « ranking problem » ;
- position ↓ avec page modifiée récemment → corréler, ne pas conclure causalement ;
- cannibalisation candidate : requête répartie entre plusieurs pages + instabilité ;
- high impressions / low CTR avec SERP feature context si disponible ;
- page business sans queries pertinentes ;
- nouvelles requêtes et nouveaux pays ;
- query clusters liés à services/entités.

Chaque anomalie doit conserver le dénominateur, la fenêtre, les filtres et les limites de données.

# 15. AI Search / GEO Laboratory

Le coût et la variabilité de cette couche imposent un modèle de données rigoureux.

## 15.1 Atomic unit

Définir un **AI check** comme :

`one prompt variant × one engine/surface × one locale × one execution timestamp`.

C'est également un bon objet de facturation/usage, comme le montrent les modèles de quotas Ahrefs et Otterly. [S02][S11]

## 15.2 Prompt set construction

Le système propose des prompts à partir :

- jobs-to-be-done ;
- catégories/services ;
- requêtes GSC ;
- questions SERP/PAA si données disponibles légalement ;
- pages d'offre ;
- comparaisons et validation/trust ;
- intents local/provider selection ;
- post-purchase si utile.

Le client **confirme** le set. Une marque n'est jamais injectée silencieusement dans un prompt censé mesurer la découverte de marque.

## 15.3 Répétition et stabilité

Pour chaque prompt important : plusieurs runs ou runs répartis dans le temps selon budget. Afficher :

- `mention_rate = mentions / valid_runs` ;
- `citation_rate = client_owned_citation_runs / valid_runs` ;
- intervalle de confiance ou intervalle bootstrap lorsque l'échantillon le permet ;
- `paraphrase_sensitivity` ;
- `engine_divergence` ;
- `locale_divergence` ;
- `run_stability`.

**No data ≠ zero.** Un moteur qui n'a pas été interrogé doit afficher `NOT_MEASURED`.

## 15.4 Sources et absorption

Conserver : URL, domaine, ordre, type de source, texte de réponse, timestamp, surface, locale et méthode de capture. Puis calculer/évaluer séparément si la citation supporte réellement la réponse.

Le produit affiche :

- sources owned ;
- concurrents ;
- earned media ;
- forums/UGC ;
- institutions/reference ;
- pages sources « gap » souvent citées pour les concurrents mais pas pour le client.

# 16. Recommendation Engine : intelligence sans hallucination

Le moteur de recommandation est hybride.

## 16.1 Pipeline

`deterministic observations → evidence graph → business context → candidate actions → LLM explanation/planning → Skeptic validation → ranked action portfolio`.

Le LLM **n'a pas le droit** d'inventer : volume, ranking, trafic, backlinks, citations, page vue, conversion ou feature non capturée.

## 16.2 Priority index

Réutiliser l'idée NEXUS :

`priority = (business_value × evidence_strength × impact_hypothesis × confidence) / (effort × risk_factor)`

Tous les composants sont affichables et éditables. Le résultat est nommé **Priority Index**, jamais « SEO score ».

L'impact reste `HYPOTHESIS` jusqu'à verification.

## 16.3 Skeptic gate

Le second pass reçoit :

- finding ;
- preuves brutes ;
- règle/gate ;
- proposition d'action ;
- sources documentaires autorisées.

Il doit chercher : contradiction, manque de preuve, alternative explanation, mauvaise portée, action trop large, métrique inventée. Une action matérielle échoue en `INSUFFICIENT` si sa preuve est trop faible.

# 17. Loop Engineering + WinCreator + convention VEOR

Le terme **VEOR** est utilisé ici comme convention opérationnelle proposée pour ce cahier : **Verify → Explain → Optimize → Re-measure**. Si votre définition interne VEOR est différente, conserver l'interface mais renommer les phases.

## 17.1 State machine d'une action

`DETECTED → EVIDENCED → PROPOSED → APPROVED → IMPLEMENTED → MEASURING → VERIFIED | REJECTED | INCONCLUSIVE → CLOSED`

Aucune action ne saute `EVIDENCED` pour aller directement à `IMPLEMENTED` en mode standard.

## 17.2 Change event

À l'application d'une correction :

- timestamp ;
- auteur/agent ;
- commit/PR/CMS revision ;
- URLs affectées ;
- before/after hashes ;
- rollback pointer ;
- expected gate ;
- baseline metrics ;
- confounders connus.

## 17.3 Verification

Le scheduler exécute le gate approprié, pas un délai fixe universel :

- technique : re-crawl immédiat + nouvelle vérification ;
- GSC : fenêtre définie et comparaison descriptive ;
- AI Search : même prompt set / engine / locale / cadence ;
- indexation : preuve moteur/GSC quand disponible, pas HTTP 200.

Le verdict peut être `PASS`, `FAIL`, `INCONCLUSIVE`, `BLOCKED`.

# 18. Corrections assistées : PR-first

Les intégrations de mutation doivent être graduelles.

## 18.1 Niveau 0 — Copy

Proposer code/config/texte, utilisateur copie manuellement.

## 18.2 Niveau 1 — Draft

Créer brouillon WordPress/Webflow/Shopify sans publier.

## 18.3 Niveau 2 — GitHub PR

C'est le mode recommandé pour les sites versionnés : branch dédiée, patch minimal, tests, aperçu, PR, lien au finding et rollback naturel par revert.

## 18.4 Niveau 3 — Managed auto-fix

Uniquement pour règles déterministes explicitement autorisées, avec allowlist, dry-run, preview et auto-rollback. Jamais activé par défaut.

# 19. Sécurité SaaS : exigences de niveau production

## 19.1 Multi-tenancy

OWASP rappelle que la séparation tenant doit être vérifiée côté serveur et recommande des frontières solides, dont RLS PostgreSQL en défense en profondeur. [S30]

Exigences :

- `organization_id` dérivé de l'identité + membership côté serveur ;
- jamais faire confiance à `X-Tenant-ID` seul ;
- RLS `FORCE` sur tables tenant-owned ;
- rôle DB de requête sans `SUPERUSER` ni `BYPASSRLS` ;
- contexte tenant transaction-local ;
- cache keys préfixées par tenant ;
- queues/messages tenant-scoped et signés/intègres ;
- object storage path + policy tenant-scoped ;
- rate limits par tenant **et** globaux ;
- tests cross-tenant négatifs sur chaque table/endpoint.

## 19.2 Authentification

WebAuthn Level 3 est une recommandation W3C depuis le 25 août 2026. [S28a]

Ordre recommandé :

1. passkeys/WebAuthn ;
2. OAuth OIDC (Google/Microsoft) ;
3. email magic link ou mot de passe comme fallback selon marché ;
4. MFA obligatoire pour owners/admins d'agence si password fallback.

Sessions : cookies `Secure`, `HttpOnly`, `SameSite=Lax/Strict` selon flow, rotation, CSRF protection, re-auth pour changements sensibles.

## 19.3 Authorization

Rôles : `OWNER`, `ADMIN`, `ANALYST`, `EDITOR`, `VIEWER`, `BILLING`.

Privilèges fins : `project.read`, `evidence.read`, `integration.manage`, `action.approve`, `production.write`, `billing.manage`, `member.manage`.

Une permission `production.write` doit être explicitement séparée de `action.approve`.

## 19.4 Secrets et tokens

- secrets manager/KMS ;
- refresh tokens chiffrés séparément ;
- secret jamais dans logs, evidence snapshots ou prompts ;
- rotation ;
- GitHub App avec scopes minimaux plutôt qu'un PAT large ;
- CMS tokens par projet ;
- suppression immédiate à disconnect.

## 19.5 Web security baseline

- CSP stricte ;
- HSTS ;
- X-Content-Type-Options ;
- frame-ancestors ;
- output encoding ;
- validation Zod/Pydantic côté frontière ;
- CSRF ;
- upload scanning et type/size limits ;
- webhook signature verification + idempotency ;
- dependency/SBOM scanning ;
- SAST/secret scanning en CI ;
- aucune donnée sensible dans client-side telemetry.

## 19.6 Privacy / retention

Le produit doit permettre : export, suppression projet, déconnexion des intégrations, politique de rétention des snapshots et AI answers, et journal d'accès. Pour un lancement européen, concevoir dès l'origine les flows nécessaires au RGPD (base légale, DPA fournisseurs, droit de suppression/export) et faire valider les textes juridiques par un professionnel.

# 20. Billing, quotas et économie unitaire

Le pricing doit vendre la simplicité et protéger la marge. Les coûts variables les plus sensibles sont : navigateur, AI checks, SERP/data providers et crawl volumineux.

## 20.1 Plans de lancement proposés

- **Free** — **Prix cible:** 0 €; **Sites:** 1 snapshot; **Crawl/mois:** 50 URLs ponctuel; **GSC:** non; **AI checks:** 0–échantillon; **Usage principal:** acquisition
- **Solo** — **Prix cible:** **12 €/mois**; **Sites:** 1; **Crawl/mois:** 3k URLs; **GSC:** oui; **AI checks:** 100/mois; **Usage principal:** indépendant/TPE
- **Growth** — **Prix cible:** **29 €/mois**; **Sites:** 3; **Crawl/mois:** 20k URLs; **GSC:** oui; **AI checks:** 500/mois; **Usage principal:** PME/consultant
- **Studio** — **Prix cible:** **59 €/mois**; **Sites:** 10; **Crawl/mois:** 75k URLs; **GSC:** oui; **AI checks:** 2,000/mois; **Usage principal:** consultant/agence légère
- **Agency** — **Prix cible:** **119 €/mois**; **Sites:** 25; **Crawl/mois:** 250k URLs; **GSC:** oui; **AI checks:** 5,000/mois; **Usage principal:** agence + white label


Ces prix sont **hypothèses de test**, pas engagement final. Le modèle doit conserver l'unité `AI check` visible, avec top-up si nécessaire. La proposition reste nettement sous les offres AI visibility autour de $99–$199/mois observées chez Semrush/Ahrefs, tout en protégeant les coûts par quotas. [S01][S02]

## 20.2 Entitlements

Toutes les limites vivent dans une table/version de plan, jamais en `if(plan === ...)` dispersés. Les workers réservent des unités d'usage de manière atomique avant exécution, puis finalisent/rollback selon résultat facturable.

# 21. Observability, SLOs et qualité

## 21.1 Telemetry technique

Chaque job possède `trace_id`, `organization_id`, `project_id`, `job_type`, `rule_version`, `cost_units`, `retry_count`, `duration`, `result`.

Ne jamais loguer le texte complet d'un token OAuth ou des pages privées.

## 21.2 SLOs initiaux à tester

- API interactive p95 < 500 ms hors jobs lourds ;
- job queue age surveillé par classe ;
- public scan time-boxé ;
- taux d'échec crawl par cause ;
- evidence retrieval disponible ;
- 100 % des actions matérielles avec gate défini ;
- 100 % des mutations avec before/after + rollback ;
- cross-tenant denial test = 100 % pass en CI.

Les chiffres de performance sont des objectifs d'ingénierie à calibrer, pas une promesse marketing initiale.

# 22. API contract V1

```text
POST   /v1/public-scans
GET    /v1/public-scans/{scanId}

POST   /v1/organizations
GET    /v1/organizations/{orgId}
POST   /v1/projects
GET    /v1/projects/{projectId}
PATCH  /v1/projects/{projectId}

POST   /v1/projects/{projectId}/crawl-runs
GET    /v1/projects/{projectId}/crawl-runs/{runId}
GET    /v1/projects/{projectId}/findings
GET    /v1/findings/{findingId}
GET    /v1/evidence/{evidenceId}

GET    /v1/integrations/gsc/authorize
GET    /v1/integrations/gsc/callback
DELETE /v1/integrations/{integrationId}

GET    /v1/projects/{projectId}/overview
GET    /v1/projects/{projectId}/search-performance
GET    /v1/projects/{projectId}/changes

POST   /v1/projects/{projectId}/prompt-sets
POST   /v1/prompt-sets/{id}/freeze
POST   /v1/prompt-sets/{id}/runs
GET    /v1/projects/{projectId}/ai-visibility
GET    /v1/ai-runs/{id}/evidence

POST   /v1/actions/{actionId}/approve
POST   /v1/actions/{actionId}/create-pr
POST   /v1/actions/{actionId}/create-cms-draft
POST   /v1/experiments
GET    /v1/experiments/{id}
POST   /v1/experiments/{id}/verify

POST   /v1/webhooks/stripe
POST   /v1/webhooks/github
```

Toutes les réponses métier exposent `data_freshness`, `method_version` et, si applicable, `limitations[]`.

# 23. Monorepo recommandé

```text
/apps
  /web                 # Next.js marketing + app
  /api                 # control plane / BFF
/services
  /crawler             # HTTP fetch + normalization + SSRF guard
  /renderer            # Playwright isolation
  /nexus-engine        # Python package + rules
  /geo-runner          # AI-search captures
  /integration-worker  # GSC/GA/GitHub/CMS
/packages
  /contracts           # OpenAPI/JSON schema/types
  /ui                  # design system
  /authz               # policy primitives
  /telemetry           # tracing/logging
  /config               # typed config
  /test-fixtures
/infra
  /terraform-or-equivalent
/docs
  /adr
  /threat-model
  /methodology
/evidence
  # generated test evidence only, never real secrets
```

Le package NEXUS existant est importé ou déplacé avec historique Git préservé ; ne pas le réécrire silencieusement.

# 24. Testing strategy

## 24.1 Pyramid

**Unit :** URL normalization, robots precedence, canonical rules, parser, priority formula, authz decisions.

**Contract :** OpenAPI/JSON schema, job message schemas, provider adapters.

**Integration :** PostgreSQL RLS, Redis idempotency, GSC mock/fixtures, object store, Stripe webhooks.

**E2E :** public scan → signup → GSC fake sandbox → finding → action → verification.

**Security :** SSRF corpus, redirect rebinding cases, cross-tenant object IDs, privilege escalation, webhook replay, CSRF.

**Visual :** responsive dashboard snapshots, contrast/accessibility, empty/loading/error states.

## 24.2 Golden fixtures

Maintenir des mini-sites fixtures contrôlés :

- canonical conflicts ;
- robots precedence ;
- JS-injected canonical ;
- JS-only internal links ;
- hreflang errors ;
- duplicate titles ;
- redirect loop ;
- structured data invalid ;
- slow/huge response ;
- malicious URL/SSRF targets simulés.

Un nouveau bug corrigé devient un fixture/régression.

# 25. Roadmap d'exécution pour MiMo‑V2.6

MiMo‑V2.6 Pro/Flash fournit un contexte jusqu'à 1M tokens, tool calling et structured output. Xiaomi documente cependant un risque de répétition d'appels d'outils en agentic settings et recommande une gestion correcte du contexte de raisonnement lors des tool calls. [S39][S40][S41] Le build doit donc être piloté par **état externe vérifiable**, pas par mémoire conversationnelle seule.

## Phase 0 — Repository and gates

**Build** : monorepo, CI, conventions, ADR, env validation, contracts, test harness, security baseline.

**Gate** : clean install + lint + typecheck + unit tests + secret scan + dependency audit + branch protection config documented.

## Phase 1 — Landing + public audit

**Build** : marketing site, domain input, SSRF-safe 20–50 URL crawl, deterministic rules, result page, conversion CTA.

**Gate** : fixture sites donnent résultats attendus ; SSRF corpus bloque toutes les destinations privées ; aucun signup requis avant résultat.

## Phase 2 — Account + multi-tenancy

**Build** : auth/passkey/OIDC, organizations, memberships, projects, RLS, quotas.

**Gate** : test automatique cross-tenant sur endpoints + DB ; aucune requête tenant-scoped sans contexte vérifié.

## Phase 3 — Full crawler + Evidence Ledger

**Build** : sitemap discovery, crawl graph, snapshots object store, two-pass rendering, findings/evidence UI.

**Gate** : source/render fixture détecte les divergences ; preuve reproductible par hash/version.

## Phase 4 — GSC Intelligence

**Build** : OAuth readonly, ingestion, trend/anomaly views, page/query clusters, action candidates.

**Gate** : fixture dataset avec pagination/limits ; UI expose fraîcheur et limitations.

## Phase 5 — Action Center + verification loop

**Build** : priority portfolio, Action Card, experiment state machine, re-crawl gates, change timeline.

**Gate** : une action ne peut être marquée `VERIFIED` sans verification run + evidence IDs.

## Phase 6 — AI Search Lab

**Build** : prompt set, quota, engine adapters, evidence captures, mention/citation metrics, source graph, uncertainty.

**Gate** : `NOT_MEASURED` distinct de zéro ; plusieurs runs agrégés ; answer/source evidence consultable.

## Phase 7 — GitHub/CMS assisted fixes

**Build** : PR generator, CMS draft adapters, before/after, rollback.

**Gate** : aucune mutation de production par défaut ; patch minimal ; audit event immuable.

## Phase 8 — Agency + scale

**Build** : client workspaces, white-label reports, team roles, usage/billing, scheduled monitoring, API.

**Gate** : isolation, quota/noisy-neighbor, backup/restore tenant-scoped, billing idempotency.

# 26. MiMo anti-loop execution protocol

MiMo doit maintenir dans le repo :

`STATE.json` — phase courante, gate, blockers, last verified commit.

`PROOF_LEDGER.md` — claim, test, raw evidence path, reviewer/verdict.

`DECISIONS.md` — ADR index et décisions irréversibles.

`SKEPTIC_CATCHES.md` — erreurs découvertes + regression test créé.

`COST_LEDGER.md` — crawl/render/AI checks exécutés en test.

## 26.1 Hard rules pour l'agent

```text
1. Read STATE + relevant ADR/contracts before code.
2. Never declare done from code inspection alone when an executable gate exists.
3. Before every tool call, state internally the new information expected.
4. If a tool call returns materially identical evidence twice, STOP repeating it.
5. After two failures at the same gate, invoke the Two-Failure Rule:
   inspect the parent assumption/architecture instead of retrying the child.
6. Never weaken a test to make a gate green unless the specification itself is proven wrong.
7. Do not create placeholder/fake production data.
8. Preserve raw evidence for material claims.
9. A Builder cannot self-approve a material gate; run an independent Skeptic pass.
10. Commit only coherent, gate-passing increments.
```

# 27. Definition of Done — produit réel, pas démo

La plateforme V1 n'est considérée publiable que lorsque :

- un visiteur peut auditer un vrai domaine public sans compte ;
- le scanner est SSRF-isolé ;
- un utilisateur peut créer compte/org/projet ;
- l'isolation tenant est testée négativement ;
- GSC peut être connecté en readonly ;
- un crawl réel génère findings + evidence navigables ;
- une action propose une correction et un gate ;
- l'utilisateur peut marquer/appliquer une correction ;
- le produit remesure et fournit un verdict ;
- AI Search affiche des mesures fondées sur des runs réels et conserve les preuves ;
- billing/quota empêchent les coûts non bornés ;
- backup, restore, deletion et audit logs ont été testés ;
- aucun score n'est présenté comme un facteur/ranking Google ;
- `/methodology` et `/security` décrivent honnêtement ce qui est et n'est pas mesuré ;
- landing, pricing, signup, empty/error/loading states sont terminés ;
- aucun placeholder, compteur fictif ou témoignage inventé n'est visible en production.

# 28. Master Build Directive — à donner à MiMo‑V2.6

Le bloc suivant peut être utilisé comme directive initiale dans le repo. Le document complet reste la spécification source.

```text
You are the implementation lead for the product currently codenamed WinSEO.
The preferred public-brand candidate is SERPVERA, but DO NOT rename public assets or buy/register anything until a separate trademark/domain clearance is approved.

SOURCE OF TRUTH
- This blueprint is the product/engineering source of truth.
- The existing private NEXUS Search Intelligence repository is the search-methodology kernel. Preserve its evidence doctrine, workflows, schemas and WinCreator integration.
- Official contracts, ADRs and acceptance gates outrank convenience or generated code.

MISSION
Build a production-grade, multi-tenant SaaS that combines:
1) technical SEO crawling,
2) Search Console intelligence,
3) AI Search / AEO / GEO measurement,
4) evidence-gated recommendations,
5) controlled assisted fixes,
6) post-change verification.

PRODUCT LAW
The core loop is:
DETECT -> EVIDENCE -> EXPLAIN -> PROPOSE -> APPROVE -> IMPLEMENT -> RE-MEASURE -> VERIFY/REJECT -> LEARN.
Never collapse this into a generic SEO score or content generator.

ARCHITECTURE
- Next.js + TypeScript for marketing/app.
- Separate control-plane API.
- Python NEXUS domain engine.
- PostgreSQL with FORCE RLS on tenant-owned tables and a request role that cannot bypass RLS.
- S3-compatible evidence store.
- Redis/Valkey for bounded queues/cache.
- Playwright workers isolated from secrets/internal networks.
- Stripe hosted billing.
- OAuth integrations with least privilege.
- Do not introduce Kubernetes in the MVP without a proven requirement.

SECURITY NON-NEGOTIABLES
- Treat all user-submitted URLs as SSRF input.
- HTTP/HTTPS only; validate DNS/IP and every redirect; block private/loopback/link-local/metadata ranges; isolate crawler egress.
- Server-verify tenant context for every tenant-scoped request.
- RLS + application authorization + negative cross-tenant tests.
- Passkeys/OIDC preferred. Sensitive tokens envelope-encrypted and never logged.
- No crawler/renderer worker receives tenant integration secrets.
- Mutations are draft/PR-first and always keep before/after + rollback.

SEARCH METHODOLOGY
- Deterministic rules decide deterministic observations.
- LLMs explain, synthesize and plan; they do not invent metrics.
- Preserve OBSERVED / MEASURED / DOCUMENTED / INFERRED / HYPOTHESIS / UNKNOWN.
- GSC is first-party truth but expose API limitations and data freshness.
- AI-search metrics come from real captured runs. No data != zero.
- Mention, citation and citation absorption are separate measurements.
- Repeated AI runs are required for material visibility conclusions.
- Google GEO guidance: no mythical llms.txt or special GEO schema claims.
- OpenAI: OAI-SearchBot and GPTBot are distinct controls.

EXECUTION PROTOCOL
Create/maintain STATE.json, PROOF_LEDGER.md, DECISIONS.md, SKEPTIC_CATCHES.md and COST_LEDGER.md.
For each phase:
CLAIM -> TEST/GATE -> RAW EVIDENCE -> SKEPTIC REVIEW -> VERDICT -> STATE CHANGE.
After two failures at the same gate, audit the parent assumption instead of repeating the action.
Never weaken tests merely to get green.
Do not create fake production data or placeholders presented as real.
Do not perform destructive production changes without explicit approval and rollback.

UI
The dashboard must answer:
- What changed?
- Why does it matter?
- What should I do next?
- Did the last changes work?
Use the design tokens and information architecture in this blueprint.
No generic AI-builder visual language, no decorative gauges, no misleading global SEO score.

FIRST IMPLEMENTATION ORDER
Phase 0 repository/gates
Phase 1 landing + SSRF-safe free audit
Phase 2 auth + organizations + RLS
Phase 3 crawler + Evidence Ledger
Phase 4 GSC Intelligence
Phase 5 Action Center + verification loop
Phase 6 AI Search Lab
Phase 7 GitHub/CMS assisted fixes
Phase 8 Agency + scale

STOP CONDITION
Do not call the product production-ready until every Definition of Done item and security gate in this blueprint has executable evidence.
If a requested capability cannot be demonstrated, mark it BLOCKED/PENDING rather than simulating success.
```

# 29. Decisions à ne pas prendre trop tôt

- Ne pas acheter un data index backlinks mondial : intégrer un provider à la demande si les clients paient pour cette fonction.
- Ne pas supporter 12 CMS dès V1 : GitHub + WordPress puis usage réel.
- Ne pas déployer un agent autonome qui publie 30 pages/mois : d'abord démontrer diagnostic et conversion.
- Ne pas construire un rank tracker mondial maison : commencer GSC + données SERP ciblées.
- Ne pas promettre « classement #1 », « garanti GEO », « 95 % de visibilité IA ».
- Ne pas laisser un modèle IA modifier les règles déterministes sans review/version bump/tests.
- Ne pas exposer une fonctionnalité enterprise si l'isolation, le quota et l'audit ne suivent pas.

# 30. KPI produit qui comptent réellement

**Activation** : public scan terminé → compte créé → GSC connecté → première Action Card ouverte/approuvée.

**Value** : proportion de projets recevant au moins une action evidence-backed pertinente ; délai jusqu'à première action vérifiable.

**Trust** : faux positifs signalés ; findings avec evidence ; actions `INCONCLUSIVE` correctement reconnues ; taux de Skeptic catches.

**Execution** : actions approuvées, PR/drafts créés, actions vérifiées.

**Outcome** : métriques first-party associées aux expériences, sans confondre corrélation et causalité.

**Retention** : projets qui reviennent pour consulter changements et verification, pas seulement un audit one-shot.

**Unit economics** : coût par crawl URL, rendered page, AI check, projet actif et client payant.

# 31. Conclusion d'architecture

La meilleure opportunité n'est pas de réduire Semrush à 29 €/mois. Ce serait perdre contre des acteurs qui possèdent déjà les bases de données, la marque et quinze ans d'infrastructure. L'opportunité est de construire **le meilleur circuit de décision et de preuve pour les sites qui disposent déjà de leurs propres données**.

La plateforme doit être plus simple qu'une suite SEO, plus technique qu'un générateur de contenu, plus honnête qu'un « GEO score », et plus utile qu'un dashboard de monitoring : **elle ferme la boucle entre observation et résultat vérifié**.

La combinaison NEXUS + WinCreator + Loop Engineering est la partie la plus défendable du produit. Elle devient encore plus forte si elle est visible dans l'UX : un utilisateur doit pouvoir ouvrir chaque recommandation et répondre lui-même à « d'où vient ce constat ? », « qu'a-t-on changé ? » et « qu'est-ce qui prouve que cela a marché ? ».

\newpage

# Sources et références

**[S01] Semrush — AI Visibility pricing.** https://www.semrush.com/pricing/ai/

**[S02] Ahrefs — Plans & pricing / Brand Radar.** https://ahrefs.com/pricing/

**[S03] Ahrefs Help — Brand Radar.** https://help.ahrefs.com/en/articles/11064852-what-is-brand-radar-and-how-to-use-it

**[S04] Screaming Frog SEO Spider.** https://www.screamingfrog.co.uk/seo-spider/

**[S05] Sitebulb — Hints / crawler documentation.** https://sitebulb.com/hints/ ; https://support.sitebulb.com/en/articles/9853652-crawler-settings

**[S06] SE Ranking — Website Audit.** https://seranking.com/website-audit.html

**[S07] Sitechecker — Website Crawler / Audit.** https://sitechecker.pro/website-crawler/ ; https://sitechecker.pro/seo-site-audit/

**[S08] Ubersuggest — Pricing.** https://app.neilpatel.com/en/pricing/

**[S09] Surfer — Content Audit docs.** https://docs.surferseo.com/en/articles/9182497-content-audit

**[S10] MarketMuse — Personalized Difficulty & Topic Authority.** https://docs.marketmuse.com/reference/personalized-difficulty-and-topic-authority/

**[S11] OtterlyAI — Pricing.** https://otterly.ai/pricing

**[S12] OtterlyAI Help — plans/prompts.** https://help.otterly.ai/pricing-of-otterlyai

**[S13] Peec AI — AI visibility methodology/product.** https://peec.ai/ai-instructions ; https://peec.ai/product/ai-visibility

**[S14] Profound — Answer Engine Insights.** https://www.tryprofound.com/features/answer-engine-insights

**[S15] Profound — Citation analysis.** https://www.tryprofound.com/features/answer-engine-insights/citations

**[S16] Profound — refreshed AEI / help.** https://help.tryprofound.com/articles/5194011335 ; https://www.tryprofound.com/blog/go-from-insights-to-action-faster-with-the-refreshed-answer-engine-insights

**[S17] Search Intelligence AI — Features / registration.** https://search-intelligence.ai/features ; https://search-intelligence.ai/register

**[S18] CiteRank — scoring methodology.** https://citerank.com/how-scoring-works

**[S19] SearchProof AI.** https://searchproofai.com/

**[S20] Oscar AI — Tarification.** https://oscar-seo.ai/tarification

**[S21] Google Search Central — new resource for generative AI optimization (15 May 2026).** https://developers.google.com/search/blog/2026/05/a-new-resource-for-optimizing

**[S22] Google — Guide to optimizing for generative AI features.** https://developers.google.com/search/docs/fundamentals/ai-optimization-guide

**[S23] OpenAI — Overview of OpenAI Crawlers.** https://developers.openai.com/api/docs/bots

**[S24] Bing — IndexNow get started / FAQ.** https://www.bing.com/indexnow/getstarted

**[S25] Google Search Console API — Search Analytics.** https://developers.google.com/webmaster-tools/v1/searchanalytics/query

**[S26] Google Search Console API — getting performance data.** https://developers.google.com/webmaster-tools/v1/how-tos/all-your-data

**[S27] OWASP — Server Side Request Forgery Prevention Cheat Sheet.** https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html

**[S28] WinSEO France.** https://winseo.fr/

**[S29] INPI BOPI 2021-49 — publication contenant `winseo`, demande nationale n°21 4 818 535.** https://www.inpi.fr/uk/sites/default/files/import/bopis/2021-49v1.pdf

**[S30] OWASP — Multi-Tenant Security Cheat Sheet.** https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html

**[S28a] W3C — WebAuthn Level 3 Recommendation, 25 Aug 2026.** https://www.w3.org/news/2026/web-authentication-an-api-for-accessing-public-key-credentials-level-3-is-now-a-w3c-recommendation/

**[S31] Aggarwal et al. — Generative Engine Optimization.** https://arxiv.org/abs/2311.09735

**[S32] Schulte, Bleeker, Kaufmann — Don't Measure Once: Measuring Visibility in AI Search (2026).** https://arxiv.org/abs/2604.07585

**[S33] From Citation Selection to Citation Absorption (2026).** https://arxiv.org/abs/2604.25707

**[S34] Diagnosing and Repairing Citation Failures in GEO (2026).** https://arxiv.org/abs/2603.09296

**[S35] Optimizing Visibility in Generative Engines: Critical Survey 2023–2026.** https://arxiv.org/abs/2607.14035

**[S36] RankLedger (existing product).** https://rankledger.app/

**[S37] SearchLedger (existing product in development).** https://www.kernvale.com/products/searchledger/

**[S38] RankVera (existing SEO business).** https://rankvera.com/

**[S39] Xiaomi MiMo — MiMo-V2.6 release.** https://mimo.mi.com/docs/en-US/news/latest/v2-6

**[S40] Xiaomi MiMo — MiMo-V2.6 Pro specs.** https://mimo.mi.com/models/en-US/mimo-v2.6-pro

**[S41] Xiaomi MiMo — Diagnosing and Mitigating Tool-Call Repetition.** https://mimo.xiaomi.com/blog/mimo-v2-6-tool-call-repetition

## Source interne

**NEXUS Search Intelligence v0.1.0** — dépôt privé utilisateur `winterbim/Next.-SEO-geo-`, branche `bim`, inspecté le 02/10/2026 : README, SKILL, workflows, schemas, scripts, capability matrix et Proof Ledger.

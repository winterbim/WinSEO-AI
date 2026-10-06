# Démonstration locale M2

## Parcours API + PostgreSQL + simulateur WordPress

Prérequis : PostgreSQL local démarré, base et rôle applicatif configurés comme pour `pnpm verify`. La commande applique les migrations, démarre l’API Fastify en mémoire de test et le simulateur REST WordPress en processus, exécute le parcours, puis supprime ses tenants temporaires.

Depuis `staging-autoreglage/vercel-deploy` :

```sh
pnpm --filter @serpvera/api demo:autofix:e2e
```

Le test crée deux tenants et un projet, capture la preuve HTML, propose et prévisualise un alt R0, lie l’approbation au hash exact, puis publie via l’adaptateur REST sur le simulateur. Il vérifie les observations navigateur/Googlebot en HTML brut et rendu. Il suit ensuite le flux manuel du titre R1 (déclaration MFA, vérification encore en attente, modification de la source, vérification en ligne), annule les deux patches et compare le hash HTML final au hash initial. Le tenant étranger ne peut pas lire le patch.

Le simulateur est local et n’ouvre aucune connexion vers un site WordPress. Cette démonstration **n’est pas validée contre l’API réelle de WordPress**. Elle vérifie l’adaptateur REST, les routes et les stores dans une seule boucle d’intégration; elle ne remplace pas un bac à sable WordPress avant une intégration externe.

## Démonstration courte du domaine

```sh
pnpm --filter @serpvera/api demo:autofix
```

Cette commande montre les états `deployed` / `deployed_manually`, `live_verified` et `rolled_back`, et confirme `initialHash === finalHash`. Elle n’exerce pas l’API ni PostgreSQL.

import type { PlanId, Plan } from "@serpvera/contracts";

// ─── Plans ───
// Central source of truth for all plan entitlements (Blueprint §20)
// Never scatter plan logic in if(plan === '...') blocks
export const PLANS: Record<PlanId, Omit<Plan, "id">> = {
  free: {
    name: "free",
    priceMonthlyCents: 0,
    sitesLimit: 1,
    crawlUrlsLimit: 50,
    gscEnabled: false,
    aiChecksLimit: 0,
    historyDays: 7,
    exportsEnabled: false,
    teamMembersLimit: 1,
    competitorLimit: 0,
    apiAccess: false,
    whiteLabel: false,
  },
  solo: {
    name: "solo",
    priceMonthlyCents: 1200,
    sitesLimit: 1,
    crawlUrlsLimit: 3000,
    gscEnabled: true,
    aiChecksLimit: 100,
    historyDays: 90,
    exportsEnabled: true,
    teamMembersLimit: 1,
    competitorLimit: 3,
    apiAccess: false,
    whiteLabel: false,
  },
  growth: {
    name: "growth",
    priceMonthlyCents: 2900,
    sitesLimit: 3,
    crawlUrlsLimit: 20000,
    gscEnabled: true,
    aiChecksLimit: 500,
    historyDays: 180,
    exportsEnabled: true,
    teamMembersLimit: 3,
    competitorLimit: 5,
    apiAccess: false,
    whiteLabel: false,
  },
  studio: {
    name: "studio",
    priceMonthlyCents: 5900,
    sitesLimit: 10,
    crawlUrlsLimit: 75000,
    gscEnabled: true,
    aiChecksLimit: 2000,
    historyDays: 365,
    exportsEnabled: true,
    teamMembersLimit: 10,
    competitorLimit: 10,
    apiAccess: true,
    whiteLabel: false,
  },
  agency: {
    name: "agency",
    priceMonthlyCents: 11900,
    sitesLimit: 25,
    crawlUrlsLimit: 250000,
    gscEnabled: true,
    aiChecksLimit: 5000,
    historyDays: 730,
    exportsEnabled: true,
    teamMembersLimit: 25,
    competitorLimit: 25,
    apiAccess: true,
    whiteLabel: true,
  },
};

export function getPlan(planId: PlanId): Omit<Plan, "id"> {
  return PLANS[planId];
}

export function checkQuota(
  plan: PlanId,
  metric: "crawl_urls" | "ai_checks" | "sites",
  currentUsage: number,
): boolean {
  const p = PLANS[plan];
  switch (metric) {
    case "crawl_urls":
      return currentUsage < p.crawlUrlsLimit;
    case "ai_checks":
      return currentUsage < p.aiChecksLimit;
    case "sites":
      return currentUsage < p.sitesLimit;
  }
}

// ─── App configuration ───
export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  /**
   * Optional: when absent, the DB client uses unix-socket peer auth
   * (pgSocketDir + pgDatabase) so local dev/CI needs NO password and NO secret
   * is ever committed. Production sets DATABASE_URL (or grants LOGIN to the
   * runtime role) — the store refuses to start without one of the two.
   */
  databaseUrl?: string;
  /** Peer-auth socket dir for local dev (no password). */
  pgSocketDir: string;
  pgDatabase: string;
  /** Runtime application role: NOSUPERUSER, NOBYPASSRLS (see bootstrap.sql). */
  dbRuntimeRole: string;
  /**
   * Optional outside production: Redis is not yet wired into any request path
   * (no queue/rate-limit consumer exists). Requiring it in dev would force a
   * fake value, which is worse than an honest `undefined`. It becomes REQUIRED
   * in production, where queues/rate limiting will depend on it.
   */
  redisUrl?: string;
  authSecret: string;
  /**
   * Master secret for envelope-encrypting Google OAuth tokens at rest
   * (AES-256-GCM). Defaults to AUTH_SECRET — the key itself is domain-separated
   * with HKDF inside the crypto module, so no extra secret is required to store
   * credentials securely. Set GSC_TOKEN_KEY to rotate token encryption
   * independently of session signing.
   */
  gscTokenKey: string;
  /** Master secret for envelope-encrypted TOTP seeds; defaults to AUTH_SECRET. */
  mfaSecretKey: string;
  s3: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucket: string;
    region: string;
  };
  gsc?: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  stripe?: {
    secretKey: string;
    webhookSecret: string;
  };
  app: {
    url: string;
    apiUrl: string;
  };
}

export function loadConfig(): AppConfig {
  const missing = (name: string): never => {
    throw new Error(`Missing required environment variable: ${name}`);
  };

  // Cast LAST: process.env.NODE_ENV is string | undefined, so the default must
  // be applied before the assertion — casting first made `?? "development"`
  // look dead while the runtime value really could be undefined.
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;

  // Production must be explicit about both connections — no implicit local
  // fallbacks that would silently run a "production" app against a dev socket.
  if (nodeEnv === "production" && !databaseUrl) missing("DATABASE_URL");
  if (nodeEnv === "production" && !redisUrl) missing("REDIS_URL");

  const authSecret = process.env.AUTH_SECRET ?? missing("AUTH_SECRET");
  if (nodeEnv === "production" && authSecret.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters in production.");
  }
  const mfaSecretKey = process.env.MFA_SECRET_KEY ?? authSecret;
  if (nodeEnv === "production" && mfaSecretKey.length < 32) {
    throw new Error("MFA_SECRET_KEY must contain at least 32 characters in production.");
  }

  return {
    nodeEnv,
    databaseUrl,
    pgSocketDir: process.env.PG_SOCKET_DIR ?? "/var/run/postgresql",
    pgDatabase: process.env.PGDATABASE ?? "serpvera_dev",
    dbRuntimeRole: process.env.DB_RUNTIME_ROLE ?? "serpvera_app",
    redisUrl,
    authSecret,
    gscTokenKey: process.env.GSC_TOKEN_KEY ?? authSecret,
    mfaSecretKey,
    s3: {
      endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
      accessKey: process.env.S3_ACCESS_KEY ?? "minioadmin",
      secretKey: process.env.S3_SECRET_KEY ?? "minioadmin",
      bucket: process.env.S3_BUCKET ?? "serpvera-evidence",
      region: process.env.S3_REGION ?? "us-east-1",
    },
    gsc: process.env.GSC_CLIENT_ID
      ? {
          clientId: process.env.GSC_CLIENT_ID,
          clientSecret: process.env.GSC_CLIENT_SECRET ?? missing("GSC_CLIENT_SECRET"),
          redirectUri: process.env.GSC_REDIRECT_URI ?? missing("GSC_REDIRECT_URI"),
        }
      : undefined,
    stripe: process.env.STRIPE_SECRET_KEY
      ? {
          secretKey: process.env.STRIPE_SECRET_KEY,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? missing("STRIPE_WEBHOOK_SECRET"),
        }
      : undefined,
    app: {
      url: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      apiUrl: process.env.API_URL ?? "http://localhost:3001",
    },
  };
}

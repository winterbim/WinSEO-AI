#!/usr/bin/env tsx
/**
 * Seed plans into the database.
 * Idempotent — uses ON CONFLICT DO NOTHING.
 */

import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://serpvera:serpvera@localhost:5432/serpvera_dev";

const PLANS = [
  { name: "free", price_monthly_cents: 0, sites_limit: 1, crawl_urls_limit: 50, gsc_enabled: false, ai_checks_limit: 0, history_days: 7, exports_enabled: false, team_members_limit: 1, competitor_limit: 0, api_access: false, white_label: false },
  { name: "solo", price_monthly_cents: 1200, sites_limit: 1, crawl_urls_limit: 3000, gsc_enabled: true, ai_checks_limit: 100, history_days: 90, exports_enabled: true, team_members_limit: 1, competitor_limit: 3, api_access: false, white_label: false },
  { name: "growth", price_monthly_cents: 2900, sites_limit: 3, crawl_urls_limit: 20000, gsc_enabled: true, ai_checks_limit: 500, history_days: 180, exports_enabled: true, team_members_limit: 3, competitor_limit: 5, api_access: false, white_label: false },
  { name: "studio", price_monthly_cents: 5900, sites_limit: 10, crawl_urls_limit: 75000, gsc_enabled: true, ai_checks_limit: 2000, history_days: 365, exports_enabled: true, team_members_limit: 10, competitor_limit: 10, api_access: true, white_label: false },
  { name: "agency", price_monthly_cents: 11900, sites_limit: 25, crawl_urls_limit: 250000, gsc_enabled: true, ai_checks_limit: 5000, history_days: 730, exports_enabled: true, team_members_limit: 25, competitor_limit: 25, api_access: true, white_label: true },
];

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    for (const plan of PLANS) {
      await client.query(
        `INSERT INTO plans (name, price_monthly_cents, sites_limit, crawl_urls_limit, gsc_enabled, ai_checks_limit, history_days, exports_enabled, team_members_limit, competitor_limit, api_access, white_label)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (name) DO UPDATE SET
           price_monthly_cents = EXCLUDED.price_monthly_cents,
           sites_limit = EXCLUDED.sites_limit,
           crawl_urls_limit = EXCLUDED.crawl_urls_limit,
           gsc_enabled = EXCLUDED.gsc_enabled,
           ai_checks_limit = EXCLUDED.ai_checks_limit,
           history_days = EXCLUDED.history_days,
           exports_enabled = EXCLUDED.exports_enabled,
           team_members_limit = EXCLUDED.team_members_limit,
           competitor_limit = EXCLUDED.competitor_limit,
           api_access = EXCLUDED.api_access,
           white_label = EXCLUDED.white_label`,
        [plan.name, plan.price_monthly_cents, plan.sites_limit, plan.crawl_urls_limit, plan.gsc_enabled, plan.ai_checks_limit, plan.history_days, plan.exports_enabled, plan.team_members_limit, plan.competitor_limit, plan.api_access, plan.white_label],
      );
    }
    console.log(`✅ Seeded ${PLANS.length} plans`);
  } catch (err) {
    console.error("❌ Seed failed:", (err as Error).message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
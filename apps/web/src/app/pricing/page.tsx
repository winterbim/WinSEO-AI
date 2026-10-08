import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing — SERPVERA",
  description: "Transparent pricing for SEO, GSC, and AI Search intelligence.",
};

const PLANS = [
  {
    name: "Free",
    price: "€0",
    period: "",
    description: "Try the public audit on any domain.",
    features: ["1 snapshot audit", "50 URLs per scan", "Public pages only", "Evidence sample"],
    cta: "Start free",
    href: "/",
    highlighted: false,
  },
  {
    name: "Solo",
    price: "€12",
    period: "/month",
    description: "For independent site owners.",
    features: [
      "1 site",
      "3,000 URLs crawled/month",
      "Search Console integration",
      "100 AI checks/month",
      "90-day history",
      "Export reports",
    ],
    cta: "Start 14-day trial",
    href: "/signup?plan=solo",
    highlighted: false,
  },
  {
    name: "Growth",
    price: "€29",
    period: "/month",
    description: "For consultants and growing businesses.",
    features: [
      "3 sites",
      "20,000 URLs crawled/month",
      "Search Console integration",
      "500 AI checks/month",
      "180-day history",
      "3 team members",
      "5 competitor tracking",
      "Export reports",
    ],
    cta: "Start 14-day trial",
    href: "/signup?plan=growth",
    highlighted: true,
  },
  {
    name: "Studio",
    price: "€59",
    period: "/month",
    description: "For SEO consultants and small agencies.",
    features: [
      "10 sites",
      "75,000 URLs crawled/month",
      "2,000 AI checks/month",
      "365-day history",
      "10 team members",
      "10 competitor tracking",
      "API access",
    ],
    cta: "Start 14-day trial",
    href: "/signup?plan=studio",
    highlighted: false,
  },
  {
    name: "Agency",
    price: "€119",
    period: "/month",
    description: "For agencies with white-label needs.",
    features: [
      "25 sites",
      "250,000 URLs crawled/month",
      "5,000 AI checks/month",
      "2-year history",
      "25 team members",
      "25 competitor tracking",
      "White-label reports",
      "API access",
    ],
    cta: "Contact us",
    href: "mailto:hello@serpvera.dev",
    highlighted: false,
  },
];

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-16">
      <div className="text-center">
        <h1 className="text-3xl font-bold">Simple, transparent pricing</h1>
        <p className="mt-4 text-lg text-slate-700">
          All plans include deterministic SEO checks, evidence links, and verification gates.
          <br />
          No hidden fees. No magical scores.
        </p>
      </div>

      <div className="mt-12 grid gap-6 md:grid-cols-3 lg:grid-cols-5">
        {PLANS.map((plan) => (
          <div
            key={plan.name}
            className={`rounded-lg border p-6 ${
              plan.highlighted ? "border-primary ring-2 ring-primary/20" : "border-line"
            } bg-panel`}
          >
            <h3 className="text-lg font-bold">{plan.name}</h3>
            <p className="mt-1 text-sm text-slate-700">{plan.description}</p>
            <div className="mt-4">
              <span className="text-3xl font-bold">{plan.price}</span>
              <span className="text-slate-700">{plan.period}</span>
            </div>
            <a
              href={plan.href}
              className={`mt-4 block rounded-lg px-4 py-2 text-center text-sm font-medium transition ${
                plan.highlighted
                  ? "bg-primary text-white hover:bg-primary/90"
                  : "border border-line text-ink-950 hover:bg-surface"
              }`}
            >
              {plan.cta}
            </a>
            <ul className="mt-4 space-y-1.5">
              {plan.features.map((f) => (
                <li key={f} className="text-sm text-slate-700">
                  <span className="mr-1.5 text-verified">✓</span>
                  {f}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="mt-10 text-center text-sm text-slate-700">
        Prices are introductory and subject to change. All plans include a 14-day free trial — no
        credit card required.{" "}
        <a href="/methodology" className="text-primary underline">
          See our methodology.
        </a>
      </p>
    </main>
  );
}

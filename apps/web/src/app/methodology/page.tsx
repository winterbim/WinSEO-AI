import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Methodology — SERPVERA",
  description: "How SERPVERA measures SEO, AI Search visibility, and Search Console data — honestly.",
};

export default function MethodologyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-bold">Methodology</h1>
      <p className="mt-4 text-slate-700">
        SERPVERA is built on the principle that every claim should be traceable to evidence. This
        page describes exactly what we measure, how we measure it, and what we don&apos;t measure.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Epistemic Classification</h2>
      <p className="mt-2 text-slate-700">
        Every finding is classified by how we know it:
      </p>
      <ul className="mt-4 space-y-2 list-disc pl-6 text-slate-700">
        <li>
          <strong>OBSERVED</strong> — Directly observed in the HTML, HTTP response, or crawl data
        </li>
        <li>
          <strong>MEASURED</strong> — Quantified from first-party data (e.g., GSC clicks,
          impressions)
        </li>
        <li>
          <strong>DOCUMENTED</strong> — Verifiable against official documentation (e.g., Schema.org,
          Google guidelines)
        </li>
        <li>
          <strong>INFERRED</strong> — Logical conclusion from observed data, not directly measured
        </li>
        <li>
          <strong>HYPOTHESIS</strong> — Plausible explanation requiring verification
        </li>
        <li>
          <strong>UNKNOWN</strong> — Insufficient data for any classification
        </li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold">What We Measure</h2>
      <div className="mt-4 space-y-4 text-slate-700">
        <p>
          <strong>Technical SEO:</strong> We crawl your site and analyze every page for over 50
          deterministic checks — title tags, meta descriptions, headings, canonical URLs, structured
          data, robots directives, internal links, and more. All checks are rules-based, not AI
          guesses.
        </p>
        <p>
          <strong>Search Console:</strong> We connect to Google Search Console (read-only) to pull
          your actual search performance data — clicks, impressions, CTR, and average position. GSC
          data has known limitations: not all rows are guaranteed, and recent data may be marked
          &quot;PRELIMINARY&quot;. We display these limitations transparently.
        </p>
        <p>
          <strong>AI Search Visibility:</strong> We run your defined prompts against AI search
          engines and record which URLs are cited, in what order, and whether your brand is
          mentioned. We run multiple repetitions because AI responses are stochastic — a single
          answer is not proof of visibility.
        </p>
      </div>

      <h2 className="mt-10 text-xl font-semibold">What We Don&apos;t Measure</h2>
      <ul className="mt-4 space-y-2 list-disc pl-6 text-slate-700">
        <li>
          We don&apos;t display a magical &quot;SEO score&quot; or &quot;ranking probability&quot;
        </li>
        <li>We don&apos;t claim to know Google&apos;s ranking algorithm</li>
        <li>We don&apos;t invent backlink data — we rely on your GSC data</li>
        <li>A single AI answer is not treated as proof of visibility</li>
        <li>HTTP 200 does not mean a page is indexed</li>
      </ul>

      <h2 className="mt-10 text-xl font-semibold">Data Freshness</h2>
      <p className="mt-2 text-slate-700">
        Every response includes <code>data_freshness</code> and <code>method_version</code> fields.
        You can always check when data was last collected and which version of our rules produced a
        finding.
      </p>

      <h2 className="mt-10 text-xl font-semibold">Verification Loop</h2>
      <p className="mt-2 text-slate-700">
        When you implement a fix, SERPVERA doesn&apos;t just mark it &quot;done&quot;. It re-crawls,
        re-checks, and verifies that the issue is resolved. Every action has a verification gate
        that must pass before the finding is closed.
      </p>
    </main>
  );
}
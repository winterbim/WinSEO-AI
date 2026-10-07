import Link from "next/link";
import { GeoCsvLab } from "./geo-csv-lab";

export const dynamic = "force-dynamic";

export default async function AiVisibilityPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;

  return (
    <div className="space-y-7">
      <div>
        <p className="text-xs uppercase tracking-[0.18em] text-slate-700">
          Repeated samples, not a magic GEO score
        </p>
        <h1 className="mt-1 text-2xl font-bold">AI Visibility Lab</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
          Measure whether your brand is mentioned or cited across a stable panel of real customer
          questions. Because generative answers vary between runs, WinSEO reports rates and
          confidence intervals instead of treating one answer as a ranking.
        </p>
        <nav className="mt-3 flex flex-wrap gap-4 text-sm" aria-label="AI visibility">
          <Link href={`/dashboard/${projectId}`} className="text-primary underline">
            Overview
          </Link>
          <Link
            href={`/dashboard/${projectId}/decision-center`}
            className="text-slate-700 hover:text-ink-950"
          >
            Decision Center
          </Link>
          <Link
            href={`/dashboard/${projectId}/search-performance`}
            className="text-slate-700 hover:text-ink-950"
          >
            Search Performance
          </Link>
        </nav>
      </div>

      <section className="grid gap-3 md:grid-cols-4" aria-label="AI visibility method">
        {[
          [
            "01",
            "Build a prompt panel",
            "Use natural-language questions a real prospect would ask.",
          ],
          [
            "02",
            "Capture repeated runs",
            "Record engine, prompt, brand mention, citation and source domains.",
          ],
          [
            "03",
            "Compare samples",
            "Use mention/citation rates and Wilson intervals, not a single answer.",
          ],
          ["04", "Re-run on cadence", "Keep the same panel so movement is comparable over time."],
        ].map(([number, title, copy]) => (
          <article key={number} className="rounded-lg border border-line bg-panel p-4">
            <span className="font-mono text-xs text-slate-700">{number}</span>
            <h2 className="mt-2 font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-slate-700">{copy}</p>
          </article>
        ))}
      </section>

      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="font-semibold">Capture schema</h2>
        <p className="mt-1 text-sm text-slate-700">
          Import captures from a manual test or an external export. WinSEO does not make automated
          calls to ChatGPT, Claude, Gemini, Perplexity, or other answer engines.
        </p>
        <pre className="mt-3 overflow-x-auto rounded bg-slate-950 p-3 text-xs text-slate-100">
          engine,prompt_id,brand_mentioned,client_cited,citation_domains,sampled_at (optional)
        </pre>
      </section>

      <GeoCsvLab key={projectId} projectId={projectId} />
    </div>
  );
}

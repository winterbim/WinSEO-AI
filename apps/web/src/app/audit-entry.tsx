"use client";

import { useState, type SubmitEvent } from "react";

interface AuditFinding {
  ruleId: string;
  title: string;
  epistemicClass: string;
  severity: string;
  explanation: string;
  recommendation?: string;
  affectedUrls: string[];
}

interface AuditEvidence {
  kind: string;
  sourceRef: string;
  capturedAt: string;
  httpStatus: number;
  contentHash: string;
  summary: string;
}

interface InlineAudit {
  mode: "preview_inline";
  domain: string;
  status: "completed" | "failed";
  createdAt: string;
  findings: AuditFinding[];
  evidence: AuditEvidence[];
  httpStatus: number;
  finalUrl: string;
  contentHash: string;
  errorMessage?: string;
  render?: {
    escalated: boolean;
    renderedSha256?: string;
    error?: string;
    reasons: string[];
    divergences: string[];
  };
}

interface ApiResponse extends Partial<InlineAudit> {
  scanId?: string;
  error?: { message?: string };
}

const severityLabel: Record<string, string> = {
  critical: "Critique",
  high: "Élevée",
  medium: "Moyenne",
  low: "Faible",
};

export function AuditEntry({
  apiConfigured,
  previewAuditEnabled,
}: {
  apiConfigured: boolean;
  previewAuditEnabled: boolean;
}) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<InlineAudit | null>(null);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setReport(null);

    const target = url.trim();
    if (!target) {
      setError("Saisissez l’adresse complète d’une page publique.");
      return;
    }
    if (target.length > 2048) {
      setError("L’adresse est trop longue (maximum 2 048 caractères).");
      return;
    }

    setLoading(true);
    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: target }),
      });
      const data = (await response.json()) as ApiResponse;
      if (!response.ok) {
        setError(data.error?.message ?? `L’audit a échoué (HTTP ${response.status}).`);
        return;
      }
      if (data.scanId) {
        window.location.assign(`/scan/${data.scanId}`);
        return;
      }
      if (data.mode === "preview_inline" && data.findings && data.evidence) {
        setReport(data as InlineAudit);
        return;
      }
      setError("Le service n’a pas renvoyé de rapport vérifiable.");
    } catch {
      setError("Le service d’audit ne répond pas. Réessayez dans quelques instants.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <form
        className="audit-form"
        lang="fr"
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <label className="sr-only" htmlFor="audit-domain">
          Adresse complète de la page à auditer
        </label>
        <span className="audit-protocol" aria-hidden="true">
          URL
        </span>
        <input
          id="audit-domain"
          type="text"
          autoComplete="url"
          inputMode="url"
          placeholder="https://exemple.fr/produit"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
          aria-describedby={error ? "audit-error" : "audit-helper"}
          required
        />
        <button type="submit" disabled={loading || (!apiConfigured && !previewAuditEnabled)}>
          {loading ? "Analyse en cours…" : "Lancer l’audit"}
          {!loading && <span aria-hidden="true">↗</span>}
        </button>
        <span
          className={`audit-helper${error ? " audit-error" : ""}`}
          id={error ? "audit-error" : "audit-helper"}
          role={error ? "alert" : undefined}
        >
          {error ||
            (apiConfigured
              ? "URL complète acceptée · pages publiques uniquement · constats liés à leur preuve"
              : previewAuditEnabled
                ? "Essai preview : 1 page réelle · HTML source · rapport non conservé · 5 essais/heure"
                : "Le service d’audit n’est pas connecté sur cet environnement.")}
        </span>
      </form>

      {report && <InlineAuditReport report={report} />}
    </>
  );
}

function InlineAuditReport({ report }: { report: InlineAudit }) {
  return (
    <section
      className="audit-report"
      lang="fr"
      aria-live="polite"
      aria-labelledby="audit-report-title"
    >
      <div className="audit-report-heading">
        <div>
          <p className="audit-report-kicker">AUDIT PUBLIC · HTML SOURCE</p>
          <h2 id="audit-report-title">Résultat pour {new URL(report.domain).host}</h2>
          <a href={report.finalUrl} target="_blank" rel="noreferrer">
            {report.finalUrl} <span aria-hidden="true">↗</span>
          </a>
        </div>
        <span className={report.status === "completed" ? "audit-status-ok" : "audit-status-failed"}>
          {report.status === "completed" ? "OBSERVÉ" : "ÉCHEC"}
        </span>
      </div>

      <div className="audit-report-metrics">
        <div>
          <strong>{report.findings.length}</strong>
          <span>constats</span>
        </div>
        <div>
          <strong>{report.httpStatus || "—"}</strong>
          <span>statut HTTP</span>
        </div>
        <div>
          <strong>{report.evidence.length}</strong>
          <span>preuves</span>
        </div>
      </div>

      {report.status === "failed" && report.errorMessage && (
        <p className="audit-report-error" role="alert">
          {report.errorMessage}
        </p>
      )}

      {report.findings.length === 0 && report.status === "completed" ? (
        <p className="audit-report-empty">
          Aucun défaut détecté par les règles exécutées sur cette page.
        </p>
      ) : (
        <div className="audit-report-findings">
          {report.findings.map((finding, index) => (
            <article className="audit-report-finding" key={`${finding.ruleId}-${index}`}>
              <div className="audit-report-finding-meta">
                <code>{finding.ruleId}</code>
                <span>{severityLabel[finding.severity] ?? finding.severity}</span>
                <span>
                  {finding.epistemicClass === "OBSERVED"
                    ? "Preuve observée"
                    : finding.epistemicClass}
                </span>
              </div>
              <h3>{finding.title}</h3>
              <p>{finding.explanation}</p>
              {finding.recommendation && (
                <p className="audit-report-recommendation">À faire : {finding.recommendation}</p>
              )}
            </article>
          ))}
        </div>
      )}

      <details className="audit-report-evidence">
        <summary>Voir la preuve technique et l’empreinte</summary>
        <p>
          Analysé le {new Date(report.createdAt).toLocaleString("fr-FR")} · URL finale :{" "}
          {report.finalUrl}
        </p>
        <code>SHA-256 HTML : {report.contentHash || "non disponible"}</code>
        {report.evidence.map((item, index) => (
          <div className="audit-evidence-item" key={`${item.kind}-${index}`}>
            <strong>{item.kind}</strong>
            <span>{item.summary}</span>
          </div>
        ))}
      </details>

      {report.render?.escalated && (
        <p className="audit-render-note">
          Le HTML indiquait un rendu JavaScript à vérifier, mais aucun navigateur de rendu n’est
          disponible dans cette preview.
          {report.render.error ? ` Détail : ${report.render.error}` : ""} Ce résultat ne valide donc
          que le HTML source.
        </p>
      )}

      <p className="audit-report-limit">
        Portée : une seule page, sans historique persistant, sans inspection Google et sans mesure
        de trafic. Un scan complet nécessite le service WinSEO connecté.
      </p>
    </section>
  );
}

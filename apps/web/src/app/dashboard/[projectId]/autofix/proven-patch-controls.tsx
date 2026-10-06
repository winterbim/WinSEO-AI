"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type SubmitEvent } from "react";

type PatchStatus =
  | "proposed"
  | "previewed"
  | "approved"
  | "deploying"
  | "deployed"
  | "deployed_manually"
  | "live_verified"
  | "google_observed"
  | "measuring"
  | "measured"
  | "drifted"
  | "rolled_back"
  | "failed"
  | "rejected"
  | "superseded"
  | "detected";

export interface ProvenPatch {
  id: string;
  findingId: string;
  field: "title" | "image_alt";
  risk: "R0" | "R1";
  url: string;
  contentHash: string;
  evidence: { url: string; capturedAt: string; contentHash: string };
  status: PatchStatus;
  version: number;
  change: { before: string | null; after: string };
  preview: null | { mode: "simulated"; beforeHtml: string; afterHtml: string; contentHash: string };
  approval: null | { actor: string; at: string; contentHash: string };
  deployment: null | {
    mode: "fixture" | "manual";
    at: string;
    receiptHash: string | null;
    rollbackDryRunHash: string | null;
    instructions?: string;
  };
  verification: null | {
    verdict: "pass" | "fail" | "inconclusive";
    at: string;
    observations: {
      userAgent: "browser" | "googlebot";
      mode: "raw" | "rendered";
      observedAt: string;
      status: number;
      value: string | null;
      occurrences: number;
      contentHash: string | null;
    }[];
  };
  events: { from: string | null; to: string; at: string; reason: string; contentHash: string }[];
}

const statusLabel: Record<PatchStatus, string> = {
  detected: "Constaté",
  proposed: "Proposé",
  previewed: "Aperçu prêt",
  approved: "Approuvé",
  deploying: "Publication en cours (simulateur)",
  deployed: "Publié (simulateur)",
  deployed_manually: "Publication manuelle déclarée, en attente de vérification",
  live_verified: "Vérifié sur le site de test",
  google_observed: "Exploré par Google",
  measuring: "Mesure en cours",
  measured: "Mesuré",
  drifted: "Correction disparue du site",
  rolled_back: "Annulé (vérifié)",
  failed: "Échec",
  rejected: "Refusé",
  superseded: "Remplacé par une modification humaine",
};

function labelForStatus(value: string): string {
  return value in statusLabel ? statusLabel[value as PatchStatus] : value;
}

export function ProvenPatchControls({
  projectId,
  initialPatches,
  mfaEnabled,
}: {
  projectId: string;
  initialPatches: ProvenPatch[];
  mfaEnabled: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [proofPatchId, setProofPatchId] = useState<string | null>(null);

  async function request(path: string, body: Record<string, unknown>) {
    setBusy(path);
    setError("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!response.ok) throw new Error(result.error?.message ?? "Patch operation failed.");
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Patch operation failed.");
    } finally {
      setBusy("");
    }
  }

  async function createDemo(field: "image_alt" | "title") {
    await request(`/api/v1/projects/${projectId}/autofix/demo`, { field });
  }

  function codeFrom(event: SubmitEvent<HTMLFormElement>): string {
    const value = new FormData(event.currentTarget).get("code");
    return typeof value === "string" ? value.trim() : "";
  }

  function stepUpForm(patch: ProvenPatch, action: "deploy" | "manual" | "rollback") {
    const path = `/api/v1/autofix/${patch.id}/${action}`;
    return (
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void request(path, { expectedVersion: patch.version, code: codeFrom(event) });
          event.currentTarget.reset();
        }}
      >
        <label className="w-40 text-xs font-medium text-slate-700">
          Code d’authentification
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            disabled={!mfaEnabled}
            className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 font-mono text-sm disabled:bg-slate-100"
          />
        </label>
        <button
          disabled={Boolean(busy) || !mfaEnabled}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === path
            ? "En cours…"
            : action === "deploy"
              ? "Simuler la publication"
              : action === "manual"
                ? "Déclarer une publication manuelle"
                : "Vérifier l’annulation"}
        </button>
        {!mfaEnabled && (
          <Link href="/dashboard/security" className="text-xs text-primary underline">
            Activer l’authentification à deux facteurs
          </Link>
        )}
      </form>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-warning/30 bg-warning/5 p-4 text-sm text-slate-700">
        <strong>Simulateur local uniquement.</strong> Ces pages d’exemple sont stockées dans le
        parcours de test. Aucun site client ni WordPress n’est contacté, et l’API désactive ces
        routes en production. Authentification à deux facteurs :{" "}
        <strong>{mfaEnabled ? "activée" : "non activée"}</strong>.
      </section>

      {error && (
        <p role="alert" className="rounded bg-critical/10 p-3 text-sm text-critical">
          {error}
        </p>
      )}

      <section className="rounded-lg border border-line bg-panel p-5">
        <h2 className="font-semibold">Créer un exemple reproductible</h2>
        <p className="mt-1 text-sm text-slate-700">
          Chaque exemple crée un constat de test, une preuve liée et une proposition de correction.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            disabled={Boolean(busy)}
            onClick={() => void createDemo("image_alt")}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy.includes("demo") ? "Création…" : "Exemple de texte alternatif · R0"}
          </button>
          <button
            disabled={Boolean(busy)}
            onClick={() => void createDemo("title")}
            className="rounded border border-line bg-white px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Exemple de titre de page · R1
          </button>
        </div>
      </section>

      {initialPatches.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-panel p-8 text-center text-sm text-slate-700">
          Aucune proposition pour le moment. Crée un exemple pour parcourir l’aperçu, l’approbation,
          la vérification et l’annulation.
        </div>
      ) : (
        <ul className="space-y-4">
          {initialPatches.map((patch) => {
            const operation = (name: string) => `/api/v1/autofix/${patch.id}/${name}`;
            return (
              <li key={patch.id} className="rounded-lg border border-line bg-panel p-5">
                <header className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    {patch.risk}
                  </span>
                  <span className="rounded bg-surface px-2 py-1 text-xs font-medium">
                    <button
                      type="button"
                      aria-expanded={proofPatchId === patch.id}
                      aria-controls={`patch-proof-${patch.id}`}
                      className="underline decoration-dotted underline-offset-2"
                      onClick={() => {
                        setProofPatchId((current) => (current === patch.id ? null : patch.id));
                      }}
                    >
                      {statusLabel[patch.status]} · preuve
                    </button>
                  </span>
                  <span className="font-mono text-xs text-slate-700">{patch.field}</span>
                  <span className="ml-auto text-xs text-slate-700">v{patch.version}</span>
                </header>
                <p className="mt-3 break-all font-mono text-xs text-slate-700">{patch.url}</p>
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs uppercase text-slate-700">Avant</dt>
                    <dd className="break-words">{patch.change.before ?? "(absent)"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase text-slate-700">Proposé</dt>
                    <dd className="break-words font-medium">{patch.change.after}</dd>
                  </div>
                </dl>
                <p className="mt-3 break-all font-mono text-[11px] text-slate-700">
                  Empreinte SHA-256 {patch.contentHash}
                </p>

                <section
                  id={`patch-proof-${patch.id}`}
                  hidden={proofPatchId !== patch.id}
                  aria-label={`Preuves du statut ${statusLabel[patch.status]}`}
                  className="mt-4 rounded border border-line bg-surface p-4"
                >
                  <h3 className="font-semibold">Preuves observées</h3>
                  <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="font-medium uppercase text-slate-700">Constat capturé</dt>
                      <dd>{new Date(patch.evidence.capturedAt).toLocaleString("fr-FR")}</dd>
                      <dd className="break-all font-mono">{patch.evidence.contentHash}</dd>
                    </div>
                    <div>
                      <dt className="font-medium uppercase text-slate-700">Approbation</dt>
                      <dd>
                        {patch.approval
                          ? `${patch.approval.actor} · ${new Date(patch.approval.at).toLocaleString("fr-FR")}`
                          : "Aucune approbation"}
                      </dd>
                      {patch.approval && (
                        <dd className="break-all font-mono">
                          Hash approuvé : {patch.approval.contentHash}
                        </dd>
                      )}
                    </div>
                    <div>
                      <dt className="font-medium uppercase text-slate-700">Publication</dt>
                      <dd>
                        {patch.deployment
                          ? `${patch.deployment.mode === "manual" ? "Déclarée manuellement" : "Écriture du simulateur"} · ${new Date(patch.deployment.at).toLocaleString("fr-FR")}`
                          : "Aucune publication"}
                      </dd>
                      {patch.deployment?.receiptHash && (
                        <dd className="break-all font-mono">
                          Reçu : {patch.deployment.receiptHash}
                        </dd>
                      )}
                      {patch.deployment?.rollbackDryRunHash && (
                        <dd className="break-all font-mono">
                          Retour arrière validé à blanc : {patch.deployment.rollbackDryRunHash}
                        </dd>
                      )}
                      {patch.deployment?.instructions && (
                        <dd className="mt-2 rounded bg-white p-2">
                          Instructions : {patch.deployment.instructions}
                        </dd>
                      )}
                    </div>
                    <div>
                      <dt className="font-medium uppercase text-slate-700">
                        Vérification en ligne
                      </dt>
                      <dd>
                        {patch.verification
                          ? `${patch.verification.verdict === "pass" ? "Réussie" : patch.verification.verdict === "fail" ? "Échec" : "Non concluante"} · ${new Date(patch.verification.at).toLocaleString("fr-FR")}`
                          : "Aucune observation"}
                      </dd>
                    </div>
                  </dl>
                  {patch.verification?.observations.length ? (
                    <ul className="mt-4 space-y-2">
                      {patch.verification.observations.map((observation, index) => (
                        <li
                          key={`${observation.userAgent}-${observation.mode}-${index}`}
                          className="rounded border border-line bg-white p-3 text-xs"
                        >
                          <strong>
                            {observation.userAgent === "googlebot" ? "Googlebot" : "Navigateur"} ·{" "}
                            {observation.mode === "raw" ? "HTML brut" : "HTML rendu"}
                          </strong>
                          <span className="ml-2">
                            HTTP {observation.status} · {observation.occurrences} occurrence(s) ·{" "}
                            {new Date(observation.observedAt).toLocaleString("fr-FR")}
                          </span>
                          <p className="mt-1 break-words">
                            Valeur observée : {observation.value ?? "aucune"}
                          </p>
                          {observation.contentHash && (
                            <p className="mt-1 break-all font-mono">
                              Hash observé : {observation.contentHash}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </section>

                {patch.preview && (
                  <details className="mt-4 rounded border border-line bg-surface p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Aperçu simulé : HTML avant / après
                    </summary>
                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-xs">
                        {patch.preview.beforeHtml}
                      </pre>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-white p-3 text-xs">
                        {patch.preview.afterHtml}
                      </pre>
                    </div>
                    <p className="mt-2 text-xs text-slate-700">
                      Hash de l’aperçu {patch.preview.contentHash}
                    </p>
                  </details>
                )}

                {patch.status === "proposed" && (
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void request(operation("preview"), { expectedVersion: patch.version })
                    }
                    className="mt-4 rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    {busy === operation("preview") ? "Préparation…" : "Préparer un nouvel aperçu"}
                  </button>
                )}
                {patch.status === "previewed" && (
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void request(operation("approve"), {
                        expectedVersion: patch.version,
                        contentHash: patch.contentHash,
                      })
                    }
                    className="mt-4 rounded bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Approuver exactement ce contenu
                  </button>
                )}
                {patch.status === "approved" && (
                  <div className="mt-3 space-y-3">
                    {stepUpForm(patch, "deploy")}
                    {stepUpForm(patch, "manual")}
                  </div>
                )}
                {(patch.status === "deployed" || patch.status === "deployed_manually") && (
                  <button
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void request(operation("verify"), { expectedVersion: patch.version })
                    }
                    className="mt-4 rounded bg-ink-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  >
                    Vérifier le HTML brut/rendu et la parité des agents
                  </button>
                )}
                {(patch.status === "live_verified" || patch.status === "failed") &&
                  stepUpForm(patch, "rollback")}
                {patch.verification && (
                  <p className="mt-3 text-sm">
                    Dernière vérification du simulateur :{" "}
                    <strong>{patch.verification.verdict}</strong> ·{" "}
                    {new Date(patch.verification.at).toLocaleString("fr-FR")}
                  </p>
                )}

                <details className="mt-4 border-t border-line pt-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Historique immuable ({patch.events.length})
                  </summary>
                  <ol className="mt-3 space-y-2">
                    {patch.events.map((event, index) => (
                      <li
                        key={`${event.to}-${index}`}
                        className="border-l-2 border-line pl-3 text-xs"
                      >
                        <strong>
                          {event.from ? `${labelForStatus(event.from)} → ` : ""}
                          {labelForStatus(event.to)}
                        </strong>{" "}
                        · {new Date(event.at).toLocaleString("fr-FR")}
                        <p className="mt-0.5 text-slate-700">{event.reason}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import Link from "next/link";
import { ApiError, apiFetch } from "@/lib/api";
import { ProvenPatchControls, type ProvenPatch } from "./proven-patch-controls";

export const dynamic = "force-dynamic";

export default async function ProvenPatchesPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  let patches: ProvenPatch[] = [];
  let mfaEnabled = false;
  let unavailable = "";
  try {
    const [patchResponse, mfa] = await Promise.all([
      apiFetch<{ patches: ProvenPatch[] }>(`/v1/projects/${projectId}/autofix/patches`),
      apiFetch<{ enabled: boolean }>("/v1/auth/mfa/status"),
    ]);
    patches = patchResponse.patches;
    mfaEnabled = mfa.enabled;
  } catch (error) {
    if (error instanceof ApiError) unavailable = error.message;
    else throw error;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
            Parcours de correction
          </p>
          <h1 className="mt-1 text-2xl font-bold">Corrections avec preuves</h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-700">
            Examine un changement de texte alternatif ou de titre, approuve son contenu exact, puis
            vérifie sa publication simulée et son annulation.
          </p>
        </div>
        <Link href={`/dashboard/${projectId}`} className="text-sm text-primary underline">
          ← Vue d’ensemble
        </Link>
      </header>

      {unavailable ? (
        <div
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/5 p-5 text-sm text-slate-700"
        >
          Le parcours de test est indisponible : {unavailable}
        </div>
      ) : (
        <ProvenPatchControls
          projectId={projectId}
          initialPatches={patches}
          mfaEnabled={mfaEnabled}
        />
      )}
    </div>
  );
}

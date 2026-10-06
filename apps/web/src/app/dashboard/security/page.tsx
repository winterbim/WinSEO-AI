import { apiFetch } from "@/lib/api";
import { MfaControls } from "./mfa-controls";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const { enabled } = await apiFetch<{ enabled: boolean }>("/v1/auth/mfa/status");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">Account</p>
        <h1 className="mt-1 text-2xl font-bold">Security</h1>
        <p className="mt-2 text-sm text-slate-700">
          An authenticator code establishes a five-minute step-up on this session before simulated
          publish or rollback. The API binds it to this session and rejects replay from other
          sessions.
        </p>
      </header>
      <MfaControls initialEnabled={enabled} />
    </div>
  );
}

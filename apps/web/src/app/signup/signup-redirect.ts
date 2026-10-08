export function signupRedirectUrl(plan: string | undefined, next?: string): string {
  const params = new URLSearchParams({ mode: "register" });
  if (plan !== undefined) params.set("plan", plan);
  if (next !== undefined) params.set("next", next);
  return `/login?${params.toString()}`;
}

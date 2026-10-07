import { redirect } from "next/navigation";
import { signupRedirectUrl } from "./signup-redirect";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; next?: string }>;
}) {
  const { plan, next } = await searchParams;
  redirect(signupRedirectUrl(plan, next));
}

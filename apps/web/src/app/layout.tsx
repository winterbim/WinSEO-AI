import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WinSEO — Search fixes with proof",
  description:
    "Find the signal, approve the exact change, verify what happened, and keep the way back.",
  openGraph: {
    title: "WinSEO — Search fixes with proof",
    description: "Evidence-first search operations across pages, images, and video.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-surface text-ink-950 antialiased">{children}</body>
    </html>
  );
}

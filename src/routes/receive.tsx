import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { GuestPanel } from "@/components/transfer-panels";

export const Route = createFileRoute("/receive")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => {
    if (typeof search.code !== "string") return {};
    const code = search.code.replace(/\D/g, "").slice(0, 10);
    return code ? { code } : {};
  },
  head: () => ({
    meta: [{ title: "Join · Peakline" }],
  }),
  component: ReceivePage,
});

function ReceivePage() {
  const { code: searchCode = "" } = Route.useSearch();
  const [code, setCode] = useState(searchCode);

  useEffect(() => {
    // Read passcode from URL hash fragment if present (#code=1234567890 or #1234567890)
    // Hash fragments are never transmitted to servers or in HTTP Referer headers
    if (typeof window !== "undefined") {
      const hash = window.location.hash.replace(/^#/, "");
      const match = hash.match(/(?:code=)?(\d{10})/);
      if (match?.[1]) {
        setCode(match[1]);
      }
      // If code was passed in search query (?code=...), strip it from search to protect referrers
      if (window.location.search.includes("code=")) {
        const c = match?.[1] || searchCode;
        const cleanUrl = window.location.pathname + (c ? `#code=${c}` : "");
        window.history.replaceState(null, "", cleanUrl);
      }
    }
  }, [searchCode]);

  return (
    <div className="min-h-screen bg-mist">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-5 py-8">
        <GuestPanel initialCode={code} />
      </main>
      <SiteFooter />
    </div>
  );
}

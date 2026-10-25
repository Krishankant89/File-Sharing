import { createFileRoute } from "@tanstack/react-router";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";
import { HostPanel } from "@/components/transfer-panels";

export const Route = createFileRoute("/send")({
  head: () => ({
    meta: [{ title: "Send files · Peakline" }],
  }),
  component: SendPage,
});

function SendPage() {
  return (
    <div className="min-h-screen bg-mist">
      <SiteHeader />
      <main>
        <HostPanel />
      </main>
      <SiteFooter />
    </div>
  );
}

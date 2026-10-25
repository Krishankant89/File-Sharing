import { createFileRoute } from "@tanstack/react-router";
import { handleShare } from "@/lib/share/rooms.server";

const handle = ({ request }: { request: Request }) => handleShare(request);

export const Route = createFileRoute("/api/share")({
  server: { handlers: { GET: handle, POST: handle } },
});

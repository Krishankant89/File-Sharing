import { Link } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/cn";

const links = [
  { href: "/#product", label: "Product" },
  { href: "/#transfer", label: "Transfer" },
  { href: "/#security", label: "Security" },
  { href: "/#pricing", label: "Pricing" },
];

export function SiteHeader({ tone = "paper" }: { tone?: "paper" | "navy" }) {
  const onDark = tone === "navy";
  const [open, setOpen] = useState(false);
  return (
    <header className={cn("sticky top-0 z-30", onDark ? "bg-navy text-paper" : "border-b border-line bg-paper text-ink")}>
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-5">
        <Link to="/" aria-label="Peakline home" onClick={() => setOpen(false)}>
          <Logo onDark={onDark} />
        </Link>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className={cn("text-sm font-semibold", onDark ? "text-foam hover:text-paper" : "text-muted hover:text-navy")}
            >
              {link.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">
          <Link
            to="/receive"
            className="inline-flex h-11 items-center justify-center rounded-md bg-sand px-4 text-sm font-bold text-navy hover:opacity-90"
          >
            Join
          </Link>
          <Link
            to="/send"
            className="inline-flex h-11 items-center justify-center rounded-md bg-action px-4 text-sm font-bold text-paper hover:opacity-90"
          >
            Send files
          </Link>
        </div>
        <button
          type="button"
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center rounded-md md:hidden",
            onDark ? "text-paper" : "text-navy",
          )}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>
      {open ? (
        <div className={cn("border-t px-5 py-4 md:hidden", onDark ? "border-foam/30 bg-navy" : "border-line bg-paper")}>
          <nav className="grid gap-1" aria-label="Mobile">
            {links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={cn("flex h-11 items-center text-sm font-semibold", onDark ? "text-paper" : "text-navy")}
              >
                {link.label}
              </a>
            ))}
            <Link
              to="/receive"
              onClick={() => setOpen(false)}
              className="mt-2 inline-flex h-11 items-center justify-center rounded-md bg-sand text-sm font-bold text-navy"
            >
              Join
            </Link>
            <Link
              to="/send"
              onClick={() => setOpen(false)}
              className="inline-flex h-11 items-center justify-center rounded-md bg-action text-sm font-bold text-paper"
            >
              Send files
            </Link>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="bg-navy-deep text-foam">
      <div className="mx-auto grid max-w-6xl gap-8 px-5 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="sm:col-span-2">
          <Logo onDark />
          <p className="mt-3 max-w-sm text-sm leading-6">
            Passcode file transfer for people on the same couch or opposite coasts. Up to 10 GB. The host key is part of the handshake.
          </p>
        </div>
        <div>
          <p className="text-sm font-bold text-paper">Product</p>
          <ul className="mt-3 grid gap-2 text-sm">
            <li><a href="/#product" className="hover:text-paper">Direct transfer</a></li>
            <li><a href="/#transfer" className="hover:text-paper">Local network</a></li>
            <li><a href="/#security" className="hover:text-paper">SSH session</a></li>
          </ul>
        </div>
        <div>
          <p className="text-sm font-bold text-paper">Start</p>
          <ul className="mt-3 grid gap-2 text-sm">
            <li><a href="/send" className="hover:text-paper">Send files</a></li>
            <li><a href="/receive" className="hover:text-paper">Join with a passcode</a></li>
            <li><a href="/#pricing" className="hover:text-paper">Ways to connect</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-foam/20">
        <p className="mx-auto max-w-6xl px-5 py-4 text-xs">Peakline keeps file bytes off the passcode itself. Compare the fingerprint, then send.</p>
      </div>
    </footer>
  );
}

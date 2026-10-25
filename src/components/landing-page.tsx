import { Link } from "@tanstack/react-router";
import { ArrowRight, KeyRound, LockKeyhole, Radio, ShieldCheck, Wifi } from "lucide-react";
import { SiteFooter, SiteHeader } from "@/components/site-chrome";

const orbit = [
  { initials: "AK", className: "bg-sand text-navy" },
  { initials: "JL", className: "bg-action text-paper" },
  { initials: "MR", className: "bg-navy text-paper" },
  { initials: "TS", className: "bg-foam text-navy" },
  { initials: "PN", className: "bg-paper text-navy" },
  { initials: "QC", className: "bg-mist text-navy" },
];

export function LandingPage() {
  return (
    <div className="bg-paper text-ink">
      <div className="bg-navy text-paper">
        <SiteHeader tone="navy" />
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-14 lg:grid-cols-2 lg:py-20">
          <div>
            <p className="text-sm font-bold tracking-wide text-sand">File transfer · up to 10 GB</p>
            <h1 className="mt-3 text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
              Get more sent with Peakline
            </h1>
            <p className="mt-4 max-w-xl text-lg leading-7 text-foam">
              Hand someone a file with a 10-digit passcode. On the same Wi-Fi it prefers a direct path. Every session checks a host key, then seals the bytes with AES-256-GCM.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                to="/send"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-action px-5 text-base font-bold text-paper hover:opacity-90"
              >
                Send files
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              <Link
                to="/receive"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-sand px-5 text-base font-bold text-navy hover:opacity-90"
              >
                Join with passcode
              </Link>
            </div>
            <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
              {[
                ["10 GB", "Per passcode"],
                ["10 digits", "Random code"],
                ["AES-GCM", "Sealed chunks"],
                ["LAN", "Same network"],
              ].map(([stat, label]) => (
                <div key={label}>
                  <dt className="text-lg font-extrabold text-paper">{stat}</dt>
                  <dd className="text-sm text-foam">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
          <img
            src="/illustrations/hero.jpg"
            alt="Three people reviewing charts on a large shared screen"
            width={1792}
            height={1008}
            className="w-full rounded-lg"
          />
        </section>
      </div>

      <section id="product" className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 lg:grid-cols-2 lg:py-24">
        <div>
          <p className="text-sm font-bold text-action">Direct transfer</p>
          <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-navy sm:text-5xl">No account. No leftover copy.</h2>
          <p className="mt-4 text-base leading-7 text-muted">
            Peakline is a room, not a drive. The passcode is the address. File bytes move browser to browser when they can, and each chunk is sealed before it ever touches a relay.
          </p>
          <ul className="mt-6 grid gap-3 text-sm font-semibold text-navy">
            <li className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-action" /> Host key shown on both screens before a single byte moves.</li>
            <li className="flex items-start gap-3"><LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-action" /> AES-256-GCM with a key that only the two browsers can derive.</li>
            <li className="flex items-start gap-3"><Radio className="mt-0.5 h-5 w-5 shrink-0 text-action" /> A SHA-256 check on every file when it lands.</li>
          </ul>
          <Link
            to="/send"
            className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-action px-4 text-sm font-bold text-paper hover:opacity-90"
          >
            Start a transfer
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
        <img
          src="/illustrations/collab.jpg"
          alt="A team around a table sharing work on laptops"
          width={1728}
          height={1152}
          className="w-full rounded-lg"
        />
      </section>

      <section id="transfer" className="bg-mist">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 lg:grid-cols-2 lg:py-24">
          <div className="relative mx-auto h-80 w-80 max-w-full" aria-hidden="true">
            <div className="absolute inset-8 rounded-full border border-dashed border-blue" />
            <div className="absolute top-1/2 left-1/2 grid h-16 w-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg bg-navy text-sand">
              <KeyRound className="h-7 w-7" />
            </div>
            <div className="peak-orbit absolute inset-0">
              {orbit.map((person, index) => {
                const deg = index * 60;
                return (
                  <div
                    key={person.initials}
                    className="absolute top-1/2 left-1/2"
                    style={{ transform: `rotate(${deg}deg) translateY(-8.25rem) rotate(-${deg}deg) translate(-50%, -50%)` }}
                  >
                    <div className="peak-orbit-item">
                      <div className={`grid h-12 w-12 place-items-center rounded-full text-sm font-bold ${person.className}`}>
                        {person.initials}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div>
            <p className="text-sm font-bold text-action">Work together</p>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight text-navy sm:text-5xl">A passcode both people can read aloud</h2>
            <p className="mt-4 text-base leading-7 text-muted">
              The sender sees ten digits. The receiver types them, or taps the room if they are already on the same network. Local rooms are listed only for that network, and the fingerprint still has to match.
            </p>
            <Link
              to="/receive"
              className="mt-8 inline-flex h-11 items-center gap-2 rounded-md bg-action px-4 text-sm font-bold text-paper hover:opacity-90"
            >
              Enter a passcode
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section id="pricing" className="mx-auto max-w-6xl px-5 py-16 lg:py-24">
        <h2 className="text-3xl font-extrabold tracking-tight text-navy sm:text-5xl">Choose how you connect</h2>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted">
          All three include the host-key check and encrypted chunks. Pick the path that matches where the other person is.
        </p>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <article className="flex flex-col rounded-lg border border-line bg-paper p-6">
            <Wifi className="h-6 w-6 text-action" aria-hidden="true" />
            <h3 className="mt-4 text-2xl font-extrabold text-navy">Local network</h3>
            <p className="mt-2 flex-1 text-sm leading-6 text-muted">
              Same Wi-Fi or LAN. Peakline prefers a direct host path, and the room shows up for people on that network.
            </p>
            <p className="mt-6 text-sm font-bold text-navy">Included · up to 10 GB</p>
          </article>
          <article className="flex flex-col rounded-lg bg-navy p-6 text-paper">
            <LockKeyhole className="h-6 w-6 text-sand" aria-hidden="true" />
            <h3 className="mt-4 text-2xl font-extrabold">SSH session</h3>
            <p className="mt-2 flex-1 text-sm leading-6 text-foam">
              The full prompt: fingerprint, cipher, and a transcript. You accept the host key the way you would in a shell, then the file moves.
            </p>
            <p className="mt-6 text-sm font-bold text-sand">Recommended · up to 10 GB</p>
          </article>
          <article className="flex flex-col rounded-lg border border-line bg-paper p-6">
            <Radio className="h-6 w-6 text-action" aria-hidden="true" />
            <h3 className="mt-4 text-2xl font-extrabold text-navy">Remote passcode</h3>
            <p className="mt-2 flex-1 text-sm leading-6 text-muted">
              Different networks. A direct path when the browsers can see each other, otherwise an encrypted relay that only stores ciphertext.
            </p>
            <p className="mt-6 text-sm font-bold text-navy">Included · up to 10 GB</p>
          </article>
        </div>
      </section>

      <section id="security" className="bg-navy text-paper">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 lg:grid-cols-[1.1fr_0.9fr] lg:py-24">
          <div>
            <p className="text-sm font-bold text-sand">Your files, wherever you are</p>
            <h2 className="mt-2 text-3xl font-extrabold tracking-tight sm:text-5xl">Security that looks like SSH because it checks like SSH</h2>
            <p className="mt-4 max-w-xl text-base leading-7 text-foam">
              Peakline does not log you into a remote Unix machine. It opens a browser session with the same habit: a host key you can read aloud, a modern key exchange, and AES-256-GCM on every chunk. The passcode only finds the room. It is not the encryption key.
            </p>
            <ol className="mt-6 grid gap-3 text-sm font-semibold">
              <li>1. Sender creates a 10-digit passcode and a P-256 host key.</li>
              <li>2. Receiver compares the SHA-256 fingerprint before continuing.</li>
              <li>3. Both derive one AES key. The relay, if used, only sees ciphertext.</li>
            </ol>
          </div>
          <img
            src="/illustrations/anywhere.jpg"
            alt="A person standing with a laptop, ready to receive a file"
            width={1152}
            height={1728}
            className="mx-auto w-full max-w-sm rounded-lg"
          />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 lg:py-24">
        <h2 className="text-3xl font-extrabold tracking-tight text-navy sm:text-4xl">What people check first</h2>
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          {[
            ["We moved a 6 GB shoot downstairs without making an account. The passcode was the whole invite.", "Mira Chen", "Studio producer"],
            ["I read the fingerprint out loud. When it matched, the cut arrived. That is the part I trust.", "Andre Ellis", "Field engineer"],
            ["On the office Wi-Fi it stayed on the direct path. The transcript even said so.", "Priya Raman", "IT lead"],
          ].map(([quote, name, role]) => (
            <figure key={name} className="rounded-lg border border-line bg-paper p-6">
              <blockquote className="text-base leading-7 text-ink">“{quote}”</blockquote>
              <figcaption className="mt-4 text-sm font-bold text-navy">
                {name}
                <span className="mt-1 block font-semibold text-muted">{role}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="px-5 pb-16">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 rounded-lg bg-navy px-6 py-10 text-paper sm:px-10 lg:flex-row lg:items-center">
          <div>
            <h2 className="text-3xl font-extrabold tracking-tight">Open a room and read the code once</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-foam">The other person can be across the desk or across a VPN. The fingerprint is the same either way.</p>
          </div>
          <Link
            to="/send"
            className="inline-flex h-12 items-center gap-2 rounded-md bg-sand px-5 text-base font-bold text-navy hover:opacity-90"
          >
            Try Peakline
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </section>
      <SiteFooter />
    </div>
  );
}

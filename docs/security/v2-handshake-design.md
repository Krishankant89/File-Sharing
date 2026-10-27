# Peakline V2 Handshake Design

Status: design proposal only. Part 5 implementation: **NO-GO**. This document
does not authorize V2 protocol code or dependency changes.
Reviewed against the repository state on 2026-10-26.

## Summary

V1 is a browser-to-browser ECDH exchange where only the receiver verifies the
host key, and that verification is meaningful against a malicious room service
only when the fingerprint is compared over an independent trusted channel. V1
does not authenticate the guest key, is not a PAKE, and has no explicit
transcript-bound key confirmation.

V2 may use a balanced PAKE because both endpoints are peers sharing a
short-lived passcode, but no implementation is approved. CPace draft-21
describes a balanced protocol and CPACE-X25519-SHA512 suite. The `cpace-ts`
0.1.6 README claims draft-21 support and its package declares a web-target WASM
export; this does not verify a WebCrypto path, browser compatibility, or
independent review of that release. The draft expired on 2026-10-25. **Part 5
is NO-GO.** The flow, key schedule, and SAS below are requirements and open
design work, not a frozen or implementation-ready protocol profile.

## Current Architecture

### V1 sequence

```mermaid
sequenceDiagram
    participant H as Host browser
    participant R as Room service
    participant S as Signaling / WebRTC
    participant G as Guest browser
    H->>H: Generate P-256 ECDH pair
    H->>R: Create room(code, host public JWK, file count/bytes)
    G->>R: Lookup by 10-digit code
    R-->>G: Host public JWK and file metadata
    G->>G: Fingerprint host public JWK; user compares out-of-band
    G->>R: Publish guest public JWK
    R-->>H: Guest public JWK on next room poll
    H->>S: Exchange SDP/ICE; establish data channel
    G->>S: Exchange SDP/ICE; establish data channel
    H->>H: ECDH(host private, guest public) then HKDF
    G->>G: ECDH(guest private, host public) then HKDF
    H->>G: Encrypted proof(code)
    G->>H: Encrypted proof-ok
    H->>G: Encrypted file controls and chunks
```

`generateRoomKeys()` now asks WebCrypto for a non-extractable P-256 private
key (`extractable: false`) and exports only the public key as JWK. The host
creates the room in `transfer-panels.tsx`; the guest looks it up, fingerprints
the host public key, and asks the user to compare it before launching a guest
session. `session.ts` publishes the guest public key and derives an AES key on
each side. No caller exports or serializes the private key.

`deriveSessionKey()` uses ECDH and HKDF-SHA-256. Its salt includes the code and
its `info` is a fixed V1 string; the derivation does not explicitly bind the
two public keys, roles, or a complete handshake transcript. The encrypted
`proof` and `proof-ok` show possession of the resulting key and code, but do
not authenticate the guest's identity to the host. The host accepts the guest
JWK returned by the room service. The guest's host-fingerprint check protects
against a substituted host key only when independently compared with the
host's fingerprint.

The passcode is sent to `/api/share` as the room lookup/create identifier and
is also used as HKDF salt and in the encrypted proof. Capturing the encrypted
proof alone is not a direct offline verifier without the session key; however,
V1 is not designed to prevent offline guessing after session-key compromise
and is not a PAKE. The service already receives the passcode in cleartext as
an application request value.

`SecurePipe` uses AES-GCM with a random 96-bit IV, a 32-bit sequence value in
authenticated data, and in-order receive checks. This prevents accepted
reordering and replay within one pipe. The random IV provides probabilistic
nonce uniqueness; the same AES key is used both directions. The proof controls
are not an explicit transcript MAC confirmation protocol.

`FileLink` sends SDP offers/answers and ICE candidates through `/api/rtc`.
The signaling server stores and returns those payloads without authenticating
them as an application transcript. A malicious signaling service can alter,
drop, replay, or redirect connection setup and cause denial of service. The
separate ECDH/AEAD layer protects file contents only when its key has not been
substituted. V1 room metadata (host name, file count, byte total, host key) is
returned before the guest confirms the fingerprint. Encrypted relay packets
are sent to `/api/share` using the passcode as room selector. The generic
`P2PRoom` implementation was not found in the Peakline share-session call
sites; the share flow uses `FileLink`.

Current tests cover crypto primitives and key extractability in
`src/lib/share/crypto.test.ts`, and rate-limit/lockout HTTP behavior in
`src/lib/share/rooms.server.test.ts`. They do not exercise a complete host and
guest session over WebRTC or relay.

### Pre-authentication transport model

V2 must separate the network bootstrap from the authenticated protocol state.
Before the PAKE completes, there is no authenticated session key. Any data
sent before explicit V2 key confirmation is attacker-controlled transport data
and must not be trusted as a proof of identity, version, or file metadata.

Direct WebRTC path:

- Each peer creates a WebRTC `RTCPeerConnection` and uses `/api/rtc` only for
  SDP/ICE exchange.
- The direct path is a raw transport layer: it may be blocked, modified,
  replayed, or redirected by the signaling server or network adversary.
- The peer must not attempt to interpret any offer/answer or ICE message as a
  cryptographic authentication. These messages only establish connectivity.
- Direct-path bootstrap and type validation must remain minimal, with strict
  size caps and a handshake timeout. If an offer/answer or ICE candidate is
  malformed, the connection attempt is aborted and a fresh attempt is created
  under a new `sid`.

Relay path:

- The relay path is the same conceptually but uses the existing room/relay
  service to exchange packets with no trust that the relay is honest.
- Any relay bytes sent before PAKE completion must be treated as unauthenticated
  application data, even if they are framed as request/response packets.
- If the implementation needs a bootstrap channel before PAKE completion, it
  must use a message envelope that is explicitly unauthenticated and cannot be
  mistaken for a completed session or transport proof. The bootstrap channel must
  not derive any session key from the same passcode or transcript state before the
  PAKE is complete.
- No sensitive file metadata or content may cross the relay before the host and
  guest have both completed the authenticated key confirmation and SAS-state
  acceptance checks.

No circular dependency is allowed: we cannot say the PAKE-encrypted channel is
established before the PAKE finishes, and we cannot import keys from untrusted
early transport messages into the PAKE state. The only valid bootstrap is a
separate pre-authenticated message envelope whose contents are strictly limited
to routing and minimal session negotiation metadata.

Message validation requirements for incomplete handshakes:

- Max payload size for pre-authentication bootstrap messages: 32 KiB for SDP/ICE
  envelopes and 64 KiB for relay bootstrap frames unless a future profile defines
  a higher bound with a matching review.
- Message type must be a fixed enum with explicit rejection of unknown values.
- Queue bounds: if a peer receives more than 64 pending bootstrap messages or a
  large number of repeated malformed frames, the handshake is aborted and the
  session is closed.
- Timeout: if the handshake does not advance from hello -> share -> finish ->
  SAS acceptance within a bounded window (for example, 30–60 seconds, subject to
  a reviewed profile), all session state is destroyed and the peer must start a
  fresh attempt.
- Cleanup: all transient room state, relay queue entries, pending signal rows,
  and in-memory attempts are deleted after failure or timeout.

## Proposed V2 Profile

### Version selection and rendezvous

V2 is intentionally specification-first and must not be integrated until the
selected PAKE implementation passes a review gate. The design below is written
as an implementation-ready specification draft for review, not as approved
production code.

The room and signaling services are untrusted routers, not peer authenticators.
They must never receive the V2 passcode in an HTTP request, URL, database key,
signaling message, relay routing value, log, or persistent server-side field.
The passcode remains local to the endpoints and is supplied only as the PAKE
input. Sharing a `rid` or receiving the same room record does not authenticate
a peer. A malicious room or signaling service can deny service and observe
routing metadata; the protocol cannot prevent those actions.

Do not negotiate a version based on a room-service response. The host
explicitly creates either a V1 room or a V2 room, and the invite is explicitly
marked V1 or V2. V2 uses a separate endpoint/record schema, for example
`/api/share/v2/rooms`, and a freshly generated 128-bit random rendezvous ID
(`rid`). The `rid` is public routing data, not an authenticator. Keep the
passcode out of room lookup, signaling, database keys, and relay API requests.

For V2, share the `rid` in a link/QR fragment and have the guest enter the
For V2, share the `rid` in a link/QR fragment and have the guest enter the
10-digit passcode separately. The fragment is not sent in the HTTP request;
the application uses the `rid` to route the room and retains the passcode
locally as PAKE input. The passcode must not appear in any URL component,
request body/header, signaling payload, relay selector, database field, log,
telemetry, analytics, crash report, or error message. The exact invite UX
remains an open product decision.
Do not hash the ten-digit code and store that hash as a verifier: it is
cheaply enumerable offline. V2 room records and responses must not expose
host name or file metadata before authenticated confirmation.

The current proposal names a single suite, but this is not a frozen profile:

- PAKE: CPace
- Group: X25519
- Hash: SHA-512
- KDF: HKDF-SHA-512
- CPace draft-21 identifies `CPACE-X25519-SHA512`; HKDF-SHA-512 is a proposed
  application KDF, not an output mandated by CPace.
- The exact suite identifier, draft version, implementation, and how the KDF
  consumes CPace's ISK remain unresolved. Draft-21 is expired as of
  2026-10-26. This proposal does not authorize substituting draft-20,
  Ristretto255, or another PAKE.

If no reviewed implementation can be demonstrated for the exact version and
suite, V2 must fail closed with a clear unsupported-version / blocked
implementation error. No silent downgrade to V1 is permitted.

### Roles, inputs, and transcript

The host is always the PAKE initiator; the guest is always the responder.
These are protocol roles, not claims about a person's real identity. V2
authenticates that both endpoints know the same passcode and joined the same
session; it does not identify a human without SAS comparison over an
independent channel.

Use the exact ten ASCII digits as the passcode input to the PAKE. Do not
invent a custom password transform. Use a fresh 256-bit random PAKE session ID
(`sid`) for every attempt. Put an unambiguous, versioned, length-prefixed
application context (`CI`) into the PAKE-associated data or transcript input:

- `peakline-file-transfer`
- protocol version `2`
- the fixed PAKE suite identifier
- `rid`
- ordered roles `host` / `guest`
- a canonical room attempt identifier or transcript hash if required by the
  chosen implementation

The exact associated-data encoding is unresolved until the chosen PAKE library
and specification are reviewed. The following is a Peakline-specific
requirement, not a claim that a specific library already implements it:

- every message must bind `version`, `rid`, the fixed suite, `sid`, and the
  sender role
- the transcript hash must be built from the canonical byte encoding, not the
  serialized object ordering of a JavaScript map
- any mismatch in role, `rid`, version, or suite aborts the attempt

### Wire sequence and key confirmation

PAKE messages travel over the WebRTC data channel or relay as unauthenticated
transport bytes. The relay is not assumed encrypted or trusted before the
application's authenticated transport is established. The PAKE is intended to
provide end-to-end key agreement; the services must not participate in
deriving the session secret and do not authenticate peers.

1. Host creates the V2 room using `rid`; it does not send the passcode or file
   metadata to the service. Guest fetches the room using `rid` and receives
   only the version and minimal rendezvous state.
2. Host sends `HELLO(version=2, suite, rid, sid, role=host)`; guest validates
   the exact version, suite, `rid`, and role and aborts on any mismatch.
3. Host sends the initiator PAKE share; guest validates it and replies with
   the responder share. Host validates the responder share. Both sides derive
   the PAKE intermediate key state. No file metadata is released here.
4. Derive the transcript hash over the canonical V2 hello, `rid`, `sid`, fixed
   roles, suite, and both PAKE messages. The exact encoding and length-prefix
   rules remain unresolved pending the specific library and implementation review.
5. Derive confirmation and traffic secrets from the PAKE output using HKDF-SHA-512
   with fixed labels. The exact labels and output lengths must be fixed by the
   reviewed PAKE profile and are not approved yet.
6. Host sends a key-confirmation message; guest verifies it, then returns a
   symmetric confirmation. The verification order is strict: host confirms guest,
   guest confirms host, and both fail closed on mismatch or replay.
7. Each side derives a short SAS from the confirmed transcript context. The SAS
   is visible to the human user and compared over an independent trusted channel.
   Only after both key confirmations and explicit SAS acceptance may the host
   share room/file metadata or the guest accept the receive path.
8. Continue with the existing file-size checks, warnings, chunk integrity hashes,
   and acknowledgements after the authenticated session state is established.

The SAS is not the cryptographic proof. It is a human comparison step that
The SAS is not the cryptographic proof. It is a human comparison step that
reduces the risk of the wrong device or attacker being accepted after a
successful PAKE. The comparison must occur over a genuinely independent
trusted channel, such as an in-person verbal comparison or a separately trusted
communication channel; displaying two values only within this potentially
compromised application is not independent verification. Any party that
rejects, times out, reconnects, or starts a new attempt aborts the session and
closes the transfer state.

### Directional transport and replay handling

The reviewed V2 design requires distinct host-to-guest and guest-to-host
AES-256-GCM keys, with independent nonce bases and a monotonic per-direction
counter. The exact construction of directional key derivation and the final
AEAD framing must be fixed by the reviewed library and security review.

The following are explicit requirements before implementation:

- `directional-key = HKDF(..., info="...host-to-guest...")` and
  `directional-key = HKDF(..., info="...guest-to-host...")`
- nonce construction must avoid reuse and must reject counter wrap
- associated data must include version, sender role, frame type, sequence,
  `rid`, `sid`, and transcript hash
- duplicate, out-of-order, wrong-direction, or wrong-session frames are invalid
- replay into a different `sid` is rejected by the session state machine
- V1 framing remains unchanged and cannot be silently reused for V2 traffic

The current V1 `SecurePipe` approach is compatible as a transport layer but does
not by itself authenticate the peer; the V2 state machine must enforce that the
transport is only used after PAKE key confirmation and attempt validation.

## PAKE Candidate Evaluation

The detailed evidence, links, labels, and exact-release caveats are in
[pake-feasibility-review.md](pake-feasibility-review.md). In brief: `cpace-ts`
0.1.6 is eligible for deeper design review, but its suitability remains
unverified; `@cipherman/pake-js` 0.1.1 requires a deliberate profile decision
and more evidence; both OPAQUE packages are rejected for this balanced
peer-to-peer use case, which is a model mismatch and not an insecurity
finding. No candidate is approved for integration. A maintainer claim,
registry record, protocol RFC/draft, test vector, or provenance attestation is
not an independent cryptographic audit of the exact package and code path.

## Threat Model

The table below records desired V2 properties, not verified behavior. No V2
implementation exists, and the selected PAKE/profile is unresolved. A malicious
room or signaling service is never a peer authenticator and can always deny
service.

### Practical online-guessing model

The application can enforce only a subset of the anti-guessing controls. The
following limits are practical and must be documented before any production use:

- Attempts per rendezvous ID: limit repeated failed PAKE starts or finished
  attempts to a small number per `rid` and a per-window cooldown, with the
  countdown bounded by the trusted proxy and server identity.
- Attempts per trusted client identity or IP: use the existing trusted proxy
  helper and the room service's current in-memory passcode lockout logic to
  enforce a stricter attempt cap. This protects against distributed clients or
  repeated bad attempts behind a single proxy, but it cannot be guaranteed if the
  server itself is malicious or if a distributed attacker controls many clients.
- Room lifetime and cleanup: short-lived V2 rooms and explicit cleanup of stale
  failed attempts are required. A room or handshake state that remains after a
  timeout is a replay and offline brute-force advantage.
- Local cooldown and repeated attempt handling: both peers must rate-limit local
  retries and surface consistent error messages without revealing whether the
  passcode was correct. Do not leak a passcode correctness signal to the server.
- Distributed guessing: if the signaling or room service is malicious or the
  attacker controls multiple clients, the application cannot guarantee an
  absolute cap on guesses. At best, it can enforce a best-effort limit using
  trusted proxy identity and server-side rate limiting. The ten-digit code is
  not equivalent to a high-entropy password and must be treated as a short,
  user-entered shared secret, not as a long-term credential.

The practical model is: rate limiting reduces the attack surface, but it does
not prevent a compromised or malicious server from acting as a guessing oracle.
Only the PAKE transcript and an independent verification channel provide the
necessary authentication signal.

| Threat                       | V2 expectation                                                                                                                                                                                                                          | Remaining limits                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious room service       | Sees `rid`, network metadata, timing, message sizes, and CPace public shares. Cannot learn the passcode from a passive transcript or derive ISK. Mutating context, messages, or routing causes peers to derive different keys or abort. | Can observe metadata after the peers intentionally send it, drop traffic, delay, replay, or prevent connection. Must not receive the passcode in any HTTP request.                                    |
| Malicious signaling server   | Can alter SDP/ICE, split paths, suppress messages, and cause denial of service. CPace remains end-to-end on top of the transport; it does not trust DTLS/SDP as identity proof.                                                         | If the attacker also controls served application JavaScript or same-origin execution, it can steal the passcode; this protocol cannot protect against a compromised client application.               |
| Passive eavesdropper         | Learns no offline password verifier from a valid CPace transcript; sees the public `rid`, CPace messages, and traffic patterns.                                                                                                         | Reveals IP addresses, timing, connection mode, and encrypted traffic volume.                                                                                                                          |
| Active MITM without passcode | Cannot complete two independent CPace sessions with honest peers except by an online password guess. Transcript binding, key confirmation, and the SAS confirmation state abort split-handshake attempts.                               | Can always deny service. A malicious peer with the actual code is an authenticated peer at the protocol level. SAS lets users detect they reached the wrong human/device when compared independently. |
| Replay/downgrade             | Fresh per-attempt `sid`, one-run PAKE state, role/context binding, strict frame sequence, and fixed V2 message tags reject stale/reordered data. V2 client never falls back to V1.                                                      | A stale V2 client/server combination fails closed and may require an app update.                                                                                                                      |
| Online guessing              | Rate-limit V2 starts/failed sessions by trusted client identity and rendezvous ID; impose short room TTL, cap attempts, and add local cooldown. Keep failure responses uniform.                                                         | A malicious server may itself mount online guesses; PAKE limits each active attempt to a guess, not the total number of guesses. A 10-digit code is not a high-entropy long-term password.            |

The web asset origin and same-origin script execution are trusted. TLS is
still required for app delivery, but TLS to the app server does not replace
the peer PAKE. SAS comparison must use a communication path independent of
the app/server being checked.

## SAS Guarantees and Confirmation States

The SAS is useful only when the users compare it through an independent and
trusted channel, such as a side-by-side verification screen or a verbal
comparison that is not mediated by the application or relay service. It does
not authenticate a machine to the network or prove that the server is honest.

If either participant rejects the SAS, times out, disconnects, reconnects, or
starts a new session, the transfer state must abort rather than continue. The
session must be closed and the server/relay state cleaned up. No file metadata,
filenames, content, or save paths may be released before every required
confirmation condition is satisfied: version match, PAKE success, key-confirmation
success, SAS acceptance by both parties, and local policy checks for file size,
filename safety, and transfer mode.

The design requires a strict state machine:

- idle
- rendezvous-open
- hello-sent
- PAKE in progress
- key-confirmation in progress
- SAS pending
- SAS accepted
- transfer active
- cancel / timeout / failure

Any transition into transfer-active without all required acceptance steps is a
protocol failure. Reconnection to a stale session or a restarted handshake must
be rejected unless the same `rid` and `sid` state is explicitly re-established
under the same protocol attempt.

## Compatibility And Migration

1. V1 protocol behavior, routes, cryptography, and framing remain unchanged by
   this V2 design task. Any proposed V1 fix is separate work. V1 remains
   explicitly labeled V1 and receives no silent upgrade or downgrade behavior.
2. V2 room creation uses a distinct route/schema and random `rid`; V2 requests
   never carry the 10-digit code. V2 lookup and relay calls route solely by
   `rid`. The server returns only version/suite state before confirmation.
3. The host selects V2 locally and shares a V2 invite. The guest client must
   validate exact V2 version and suite, then run only V2. An unsupported
   version, changed suite, malformed message, or any PAKE/SAS/KC failure
   aborts. Never retry the same invite through V1 automatically.
4. Roll out server support for V1 and V2 before enabling V2 in the UI. V1
   active rooms remain usable through their existing TTL (currently two
   hours). Rollback may disable creation of new V2 rooms, but must retain V2
   handlers until their TTL expires; if V2 cannot be supported, return an
   explicit unsupported-version failure rather than forwarding to V1.
5. Remove V1 only in a separately announced breaking release after its room
   TTL and transfer compatibility window have elapsed. Do not let server
   negotiation silently choose the weaker version.

## Implementation Prerequisites / Open Questions

The following items remain unresolved and must be addressed before any real
implementation attempt is allowed. Writing requirements here does not mean
they are implemented, tested, or independently reviewed:

- Exact PAKE and suite profile: choose a valid, fixed specification version,
  suite identifier, group, hash, and implementation. CPace draft-21 is expired
  as of this review date; draft-20 and alternate groups are not automatic
  substitutes. No server-controlled suite negotiation or downgrade is allowed.
- Exact passcode input and encoding: confirm ten ASCII digits enter the chosen
  PAKE unchanged; do not hash, stretch, or transform them outside an approved
  profile. Prove no server API, signaling, routing, logs, telemetry, or
  persistent state receives the passcode.
- `rid`/`sid` lifecycle: define generation, uniqueness, room expiry, replay
  behavior, reconnect, duplicate starts, cancellation, and stale-state cleanup.
  The room service must not authenticate a peer based on shared `rid`.
- Canonical encoding and length-prefix rules: the PAKE and transcript messages
  need deterministic field boundaries, type/unknown-field handling, and
  maximum lengths. The exact wire encoding remains unresolved.
- Exact PAKE context and associated-data inputs: the field set above is the
  Peakline requirement, but how version, suite, `rid`, `sid`, ordered roles,
  both PAKE shares, and application context are authenticated by the chosen API
  is unresolved. Do not assume a separately computed transcript hash is
  authenticated by CPace.
- Transcript-hash construction: the design states it must be a canonical,
  versioned hash over roles, `rid`, `sid`, and PAKE messages, but the exact
  byte ordering and length prefix are not yet approved.
- Key schedule: define and review the PAKE ISK handling, HKDF input keying
  material, salt, domain-separated labels, output lengths, and nonce-base
  material. No passcode-as-AEAD-key or bidirectional key reuse.
- Key confirmation: define exact messages, MAC construction, transcript
  coverage, verification order, and failure behavior. CPace draft-21 does not
  mandate explicit confirmation; do not imply it does.
- SAS: define derivation from authenticated context, unbiased mapping,
  effective entropy, display/comparison, abort behavior, and a genuinely
  independent trusted channel. Matching values shown only in this application
  are not independent verification.
- Directional transport: define distinct directional keys, reviewed nonce
  construction, authenticated frame fields, direction/session binding,
  sequence rules, duplicate rejection, replay handling, counter exhaustion,
  and reconnect behavior. The exact AEAD framing is unresolved.
- Resource limits: set and review message/frame sizes, queue and relay-backlog
  bounds, handshake timeouts, room lifetime, attempts per `rid` and trusted
  client identity, malformed-message limits, and cleanup intervals. Values
  require load/abuse analysis, not assumption.
- Error/privacy behavior: define uniform failure responses and ensure logs,
  telemetry, crash data, API bodies, database state, and errors exclude the
  passcode, secret key material, and pre-authentication file metadata.
- State machine/data release: define legal transitions and fail-closed handling
  for malformed input, wrong roles/version, PAKE/KC failure, SAS rejection,
  timeout, cancellation, reconnect, and stale state. No filenames, counts,
  byte totals, or contents before all authentication and acceptance gates.

## Dated review findings and resolutions

### Review date

2026-10-26

### Finding 1: pre-authentication transport must not be trusted

Resolution: the design now explicitly states that all data before PAKE key
confirmation is attacker-controlled transport data. The direct WebRTC path and
relay path are treated separately, and both are required to enforce strict
message-size, queue, timeout, and cleanup rules before any session state is
accepted.

### Finding 2: PAKE implementation approval requires evidence beyond passing tests

Resolution: the PAKE section now states that `cpace-ts` is not approved merely
because its tests pass. Production implementation remains blocked until the
specific release and cryptographic code path are independently reviewed and
explicitly approved under a fixed versioned protocol profile.

### Finding 3: the design had unresolved cryptographic details and was too implicit

Resolution: the document now calls out the remaining unresolved details for
CPace versioning, canonical encoding, transcript-hash construction,
HKDF labeling, key confirmation, directional AEAD keys, nonce construction, and
SAS mapping. These are clearly separated from Peakline-specific protocol
requirements.

### Finding 4: anti-guessing controls need practical limits and honest caveats

Resolution: the threat model now includes practical limits for attempts per
rendezvous ID, per trusted client identity, room lifetime, and repeat attempts,
while also explicitly noting that a ten-digit code is not a high-entropy
password and that server-side controls cannot guarantee safety against a
malicious or distributed attacker.

### Finding 5: SAS guarantees were not stated precisely enough

Resolution: SAS is now defined as a human-verification step over an
independent trusted channel, not as a cryptographic proof of identity. The
state machine requires abort on rejection, timeout, reconnect, or a new session,
with no metadata or file-content release before all confirmation conditions are
met.

### Finding 6: the document needed an explicit review gate before any implementation step

Resolution: the design now includes an implementation blocker and acceptance
criteria. Production implementation is explicitly blocked until the audited
PAKE release and exact protocol profile are approved, and all protocol details
above have been fixed and tested.

### Acceptance criteria before Part 5

1. A specific PAKE library release and exact browser code path are independently
   reviewed and approved for the chosen version.
2. The protocol version, suite, canonical encoding, transcript hash, and HKDF
   labels are frozen and reviewed.
3. Key confirmation, SAS derivation, and directional AEAD framing are specified
   and tested.
4. Online-rate-limit and failure-state cleanup rules are documented and
   enforced.
5. A separate implementation review signs off on the final V2 profile before
   any live code or dependency changes.

No production source code or dependencies were changed for this design.
This document is design-only and does not authorize changing V1 behavior or
implementing V2.

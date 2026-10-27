# Peakline PAKE Feasibility Review

Status: design-only assessment; no implementation approval. Reviewed against the
repository and public sources available on 2026-10-26. No production changes
were made as part of this final documentation audit.

## Scope and decision question

The question is whether Peakline can responsibly proceed with the V2 authenticated handshake described in [docs/security/v2-handshake-design.md](docs/security/v2-handshake-design.md) using a browser-to-browser PAKE with a 10-digit shared passcode.

This review separates:

- protocol-level feasibility
- implementation-level assurance
- deployment-level suitability for this app's passcode model and browser architecture

It does not recommend implementing a custom PAKE, nor does it approve any candidate for production use without independent evidence.

## Candidates considered

Package versions and identities below were checked against npm and upstream
sources on 2026-10-26. **Verified** means directly supported by a cited source;
it does not mean cryptographically secure. **Maintainer claim** identifies
project-authored statements. **Independent review** is only used for an
external report whose exact scope is stated. **Inference** identifies this
review's Peakline-specific assessment.

### `cpace-ts` 0.1.6

- **Verified, registry/provenance:** [npm package metadata](https://www.npmjs.com/package/cpace-ts)
  identifies `cpace-ts` 0.1.6 and its repository; its provenance record points
  to source commit [`5e6ef33047cb085da4c13d436789b56740e18c6b`](https://github.com/slava-nikulin/cpace-ts/tree/5e6ef33047cb085da4c13d436789b56740e18c6b).
- **Maintainer claim:** its [README](https://github.com/slava-nikulin/cpace-ts/blob/main/README.md)
  claims CPace draft-21 and CPACE-X25519-SHA512. Its [package manifest](https://github.com/slava-nikulin/cpace-ts/blob/main/package.json)
  has a separate `./wasm` export built for the web target and lists
  `@noble/curves` as a runtime dependency. This verifies a web-target WASM
  export is declared, not that Peakline's browser bundle or WebCrypto path was
  tested.
- **Independent review:** no report covering the exact 0.1.6 release, selected
  TypeScript/WASM path, and dependencies was verified in the sources reviewed.
  This is an evidence gap, not evidence that the package is insecure.
- **Inference / decision:** the claimed balanced PAKE suite is a plausible
  design-review candidate. Suitability remains unverified; **eligible for a
  deeper design review, not approved for integration**.

### `@cipherman/pake-js` 0.1.1

- **Verified, registry/release/provenance:** [npm metadata](https://www.npmjs.com/package/@cipherman/pake-js)
  identifies version 0.1.1. Its [upstream release](https://github.com/alicommit-malp/pake-js/releases/tag/v0.1.1)
  and npm provenance point to source commit
  [`f1b001df0983c329c91cac9b419702365ec72ec1`](https://github.com/alicommit-malp/pake-js/tree/f1b001df0983c329c91cac9b419702365ec72ec1).
  Provenance links support artifact/source traceability; they are not an
  independent cryptographic audit.
- **Maintainer claim:** the [versioned README](https://github.com/alicommit-malp/pake-js/blob/v0.1.1/README.md)
  describes SPAKE2+ (RFC 9383) and CPace draft-20/Ristretto255/SHA-512,
  browser support, and test vectors. Its [threat model](https://github.com/alicommit-malp/pake-js/blob/v0.1.1/THREAT_MODEL.md)
  says the application owns transport, rate limiting, and production audit
  responsibilities. These are project claims, not independent findings.
- **Independent review:** no independent audit covering the exact 0.1.1
  release and browser path was verified in the cited sources.
- **Inference / decision:** the declared CPace model could be considered in a
  later review, but it uses draft-20/Ristretto255, not the proposed
  draft-21/X25519 profile. **More evidence and a deliberate profile decision
  are required; suitability remains unverified.**

### `@serenity-kit/opaque` 1.1.0

- **Verified, registry:** [npm metadata](https://www.npmjs.com/package/@serenity-kit/opaque)
  identifies version 1.1.0 and lists its dependencies.
- **Maintainer claim:** the [project README](https://github.com/serenity-kit/opaque)
  describes OPAQUE registration/login and links a 7ASecurity penetration-test
  and white-box review report at [7asecurity.com](https://7asecurity.com/reports/pentest-report-opaque.pdf).
  The report URL could not be inspected with the available web retrieval. Its
  precise source revision, npm release, browser path, and full dependency
  coverage therefore remain unverified; it is not asserted here as an audit
  of 1.1.0.
- **Verified, protocol:** [RFC 9807](https://www.rfc-editor.org/rfc/rfc9807.html)
  specifies augmented OPAQUE in a client-server registration/AKE model. It is
  an Informational IRTF RFC, not Internet Standards Track.
- **Inference / decision:** reject for the proposed balanced, ephemeral
  peer-rendezvous model due to protocol-model mismatch. This is not a claim
  that the package is insecure.

### `@cloudflare/opaque-ts` 0.7.5

- **Verified, registry:** [npm metadata](https://www.npmjs.com/package/@cloudflare/opaque-ts)
  identifies version 0.7.5.
- **Maintainer claim for that release:** the [v0.7.5 README](https://github.com/cloudflare/opaque-ts/blob/0.7.5/README.md)
  identifies OPAQUE draft-07, WebCrypto hashing/KDF, `@cloudflare/voprf-ts`,
  and `@noble/hashes` dependencies.
- **Verified, source drift:** current [main package metadata](https://github.com/cloudflare/opaque-ts/blob/main/package.json)
  reports version 0.9.0. Main-branch metadata is not evidence about the
  published 0.7.5 artifact.
- **Independent review:** no report covering the exact npm 0.7.5 artifact and
  browser path was verified in the sources reviewed. This does not establish
  insecurity.
- **Inference / decision:** reject for the proposed balanced peer-to-peer
  model because this is an augmented client-server OPAQUE implementation.
  This is a model mismatch, not an insecurity finding.

## Protocol sources and evidence limits

- [CPace draft-21](https://www.ietf.org/archive/id/draft-irtf-cfrg-cpace-21.txt)
  describes CPace as balanced and defines CPACE-X25519-SHA512. It assigns
  suite agreement, input encoding, and application integration to the
  application layer; it does not mandate explicit key confirmation. The
  draft states that it expired on 2026-10-25, so it is an expired
  Internet-Draft on this review date, not a final RFC.
- [OPAQUE RFC 9807](https://www.rfc-editor.org/rfc/rfc9807.html) is an
  Informational IRTF RFC. Its publication status is not an implementation
  audit or proof of suitability for Peakline.
- npm records establish package identity and published metadata. Project
  README/threat-model material establishes only what maintainers claim. Neither
  proves conformance, secure randomness, side-channel behavior, browser
  compatibility, or the security of a given release.

## What the evidence does establish

### 1. Protocol family feasibility

CPace is specified as a balanced PAKE for two peers sharing a low-entropy
secret. That makes a browser-to-browser design plausible in principle; it
does not approve any package or Peakline application protocol.

The evidence that supports that conclusion is:

- CPace draft-21 defines a balanced PAKE and an X25519/SHA-512 suite.
- RFC 9807 defines augmented OPAQUE in a client-server model.
- Browser support is a maintainer claim for the relevant packages; no
  Peakline-target browser validation was performed.

This shows that the general design goal is viable, but it does not prove that a specific library release is safe for this integration.

### 2. Implementation-level maturity is mixed

The linked registries and repositories establish that packages declare the
listed protocols, suites, runtimes, and dependencies. They do not establish
that a package conforms to its protocol, passes independent review, or fits
Peakline's exact security model.

## What the evidence does not establish

This is the critical gate.

### 1. Independent-review coverage remains unverified

For `cpace-ts`, `@cipherman/pake-js`, and `@cloudflare/opaque-ts`, no
independent audit covering the exact reviewed release and proposed browser
path was verified in the cited sources. For `@serenity-kit/opaque`, a
maintainer-linked external report exists, but its coverage of version 1.1.0,
the shipped browser path, and all dependencies was not verified. These are
evidence gaps, not findings that any candidate is insecure.

### 2. Passing tests are not sufficient evidence

A library may have unit tests, browser support, and protocol examples without being safe to integrate into a system with a short passcode and external relay/signaling services.

The following are not enough by themselves:

- passing tests
- TypeScript support
- browser support claims
- active maintainer activity
- the existence of a spec document

They are useful signals, but they are not independent evidence of implementation security.

### 3. Protocol specification status matters

CPace draft-21 is an expired Internet-Draft on this review date. The draft's
suite definition does not prove a package implements it correctly. OPAQUE's
RFC status likewise does not transfer assurance to a JavaScript package.
Exact protocol version and implementation path remain selection gates.

## Browser compatibility and dependency risks

### Browser / WebCrypto risk

A browser implementation is necessary because Peakline delegates peer authentication to browser clients. Maintainer runtime claims do not establish Peakline compatibility. Remaining checks include:

- code path differences between Node, Deno, Bun, and browser bundles
- WebCrypto differences across browser engines
- fallback code paths that may not be used in the same way during testing
- silent behavior changes under bundlers or minifiers

The exact published artifact, selected entry point, transitive dependencies, WASM/native assets, randomness source, and fallback behavior must be inspected and tested in the browser bundle Peakline would ship. No such bundle validation was performed here.

### Dependency risk

Dependencies must be read from the exact published tarball and reviewed as part of the implementation gate. Do not use current repository-main metadata as a substitute for an older published artifact.

The key questions that remain open for Peakline are:

- which exact package and file are shipped in the browser bundle
- which crypto primitives are used under the hood
- whether there are fallback code paths that change the security surface
- whether the dependency graph has audited transitive crypto code
- whether the chosen release has a verifiable tag or provenance trail that matches the source tree used in the app

### Passcode-model risk

The proposed Peakline passcode is ten decimal digits. If generated uniformly, its maximum entropy is $\log_2(10^{10}) \approx 33.22$ bits. This is a mathematical inference, not a verified measurement of the production generator.

That is not equivalent to a high-entropy password. It is a short secret that must rely on:

- tight online-rate limiting
- strong session-level protection
- freshness of each attempt
- short-lived rooms and failed-attempt cleanup
- restricted retry behavior tied to trusted identity or routing state

The code length does not make the protocol automatically safe. It only means the system must use a protocol that is designed for a short, user-entered password and must apply rate limits carefully.

## Feasibility of CPace for Peakline

### Conclusion: plausible protocol fit, implementation not approved

Peakline can conceptually use CPace for a shared-passcode browser-to-browser handshake. CPace draft-21 describes a balanced peer model, but it does not specify Peakline's room service, invite, lifecycle, application transcript, or transport profile. It does not imply a particular JavaScript implementation is suitable.

However, the feasibility assessment is not the same as approval.

The following remain unresolved for the exact `cpace-ts` path:

- exact published source and browser/WASM entry path to ship
- independent review coverage for the exact artifact, code path, and dependencies
- Peakline target-browser compatibility and randomness/fallback behavior
- complete application protocol profile and transcript inputs
- online-guessing, room lifetime, relay limits, and cleanup controls

Therefore, CPace is eligible for a deeper design review as a protocol family, while `cpace-ts` suitability remains unverified. Neither is approved for implementation.

## Recommended decision

Recommended decision: remain blocked.

Reason:

- no chosen package and exact browser artifact has verified independent review
- the draft-level protocol fit does not settle the application protocol
- rate limits reduce online opportunities but cannot constrain a malicious room/signaling service or a sufficiently distributed attacker

This means Peakline should not move to Part 5 implementation with the current evidence.

## Evidence required to unblock Part 5

The following is the minimum practical evidence gate before any production implementation is considered:

1. Exact version and source provenance

- specific package version pinned
- exact Git tag or commit hash reviewed
- source-to-package correspondence verified

2. Independent implementation review

- public or private independent cryptographic review of the exact release and browser code path
- review scope explicitly includes browser/WebCrypto use, fallback code paths, and state handling

3. Protocol-level specification freeze

- an unexpired, fixed CPace version and exact suite, or a separately approved replacement profile
- exact PRS, CI, sid, roles, associated-data inputs, and transcript conventions
- exact message encoding, version/suite identifiers, and fail-closed negotiation
- explicit confirmation and proof of how all Peakline context is authenticated
- an SAS construction with defensible entropy/display mapping and a genuinely independent verification channel
- reviewed directional key derivation, AEAD frame/nonce format, and strict replay rules

4. Security testing evidence

- specification vectors and independent interoperability evidence
- invalid-input, role/context mix-up, replay, downgrade, malformed-message, and mismatch tests
- browser compatibility validation for the exact production bundle

5. Operational controls review

- measured message/frame and queue caps, handshake timeouts, attempt caps per rendezvous and trusted client identity, and rate-limit failure behavior
- load/abuse analysis for room lifetime, relay backlog, and stale-room cleanup
- cleanup and reconnect/cancel behavior for failed or aborted handshakes

6. Transparent blocker status

- any remaining uncertainty must be disclosed as a blocker, not silently assumed away

Without these items, the implementation should remain blocked.

## Bottom line

Peakline should not proceed to Part 5 implementation with a newly selected PAKE library unless the exact crate/package release, browser code path, and cryptographic review evidence are all in place.

The most responsible decision is to keep V2 blocked until an independent reviewer approves a concrete implementation profile. Absence of verified audit evidence is a reason to withhold approval, not a conclusion that a candidate is insecure.

No production code or dependencies were changed in this assessment.

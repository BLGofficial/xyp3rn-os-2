# Project audit and next steps — 2026-10-02

## Scope and repository

Audited the active `xyp3rn-os-2-engine` checkout, its Next.js application, selected authentication/data boundaries, test suite and dependency tree. This is a targeted engineering audit, not a penetration test or a production-readiness certification.

GitHub access is authenticated and `origin` already points to `BLGofficial/xyp3rn-os-2`. Remote `main` was fetched at `4d606592631a0ee9c8fb0bc72ba0e750389a9b30`. Local branch `feat/hud-live` starts at `607c443`: five local-only commits and seven remote-only commits. Remote main includes Galaxy; the active branch includes the HUD. Galaxy and the unfinished Studio capture work were already present as local changes. They were preserved. No merge, commit, push or deployment was performed.

The existing product contract is a local, single-owner application. Team growth, release cadence and cloud budget are unspecified. This change retains the existing stack and deployment model, adds no paid service and makes no new architecture commitment.

## Delivered

1. **Official logo locked.** The exact GitHub artwork is stored locally, shared across Mercury and HUD, and copied byte-for-byte into Galaxy's static directory. Headers, HUD hub, Galaxy startup and browser icons use it. Two checksum tests enforce the approved bytes. [Brand source and policy](BRAND.md).
2. **Critical dependencies patched.** Next.js `14.2.35` upgraded to `15.5.27`. Async route parameters, query parameters and cookies were migrated; the obsolete instrumentation flag was removed. Next's transitive PostCSS is pinned to the already-used `8.5.28`. The workspace trace root is explicit. Registry audit changed from 27 advisories (2 critical, 10 high, 13 moderate, 2 low) to **zero reported vulnerabilities**.
3. **HUD discoverability.** Mercury HUD is now reachable from the existing More navigation, preserving the eight primary areas.
4. **Windows verification repairs.** Kernel ownership and TRACE ownership tests normalize path separators; the clock subprocess imports a file URL; Vault CLI tests use the filesystem API instead of the Unix `ls` executable. Catalog scheduling tests read the database's current date instead of UTC.

The upgrade addresses the maintainer's [Windows remote-code-execution advisory](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36) and [image optimization advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2xp9-vwfh-vxw4). Zero audit findings mean no advisories reported by that registry check, not proof that all application code is secure.

## Verification

- Production build passed on Next.js 15.5.27. Root and web TypeScript checks passed.
- End-to-end `web:smoke` passed against a throwaway migrated database and temporary Vault. It exercised login/refusal, real file persistence, song/release operations, Studio packages, research fixtures, graph provenance, authenticated APIs, HUD events, keyboard navigation and reduced motion.
- Logo decoded before login; browser icon returned successfully without a session; HUD header and hub both decoded the approved image.
- No horizontal overflow across 19 pages at 390 px. Desktop/tablet/mobile screenshots were captured. Selected [desktop HUD](proofs/2026-10-02-brand/hud-desktop.png) and [mobile HUD](proofs/2026-10-02-brand/hud-mobile.png) evidence is retained.
- Local headless measurement on the smoke's 900-entity dataset: LCP **856 ms**, CLS **0.022**. This is not a mobile-4G measurement; INP and availability were not measured.
- Galaxy branding passed desktop/mobile checks using an isolated static preview. Galaxy backend, phone, mail and model integrations were not invoked.
- Final full suite: **1,587 passed, 2 failed, 14 skipped; 128 of 130 test files passed**. The first run had 22 failures; twenty checks were repaired. Remaining failures and skipped tests involve Windows symlink fixtures. [Verification record](proofs/2026-10-02-brand/verification.txt).
- Senior Fullstack's heuristic analyzer scanned 425 source files. Its 15 critical secret-pattern matches were in test/smoke fixtures. Sampled SQL-injection flags included parameterized database templates and Python regular expressions. Raw heuristic severity and file-count “coverage” were not treated as verified vulnerabilities or measured coverage.

## Follow-up: symlink proofs made portable

Index-scan and file-viewer escape tests now link to real temporary targets outside the root instead of `/etc/hostname` and `/etc/passwd`. `tests/helpers/symlink.ts` creates a file symlink, and on Windows' unprivileged `EPERM` falls back to a directory junction at the target's own location, which Node also reports as a symbolic link, so the same inside/outside rule is exercised. The directory-escape case uses a junction directly and no longer masks a failed link with a cleanup `ENOENT`. The backslash-filename fixture cannot exist on Windows; it is created and asserted only elsewhere, with the one skip named in the test.

Fresh run on Windows: TypeScript passed; full suite **130 of 130 files, 1,602 passed, 0 failed, 1 skipped** (the backslash case). The Linux runner should still run once to confirm the file-symlink path.

## Prioritized next work

| Priority | Work item | Evidence and acceptance gate |
| --- | --- | --- |
| P1 | Reconcile the active branch with main | Integrate the existing HUD commits, upstream Galaxy and separately reviewed Studio work on a clean integration branch. Preserve local changes, rerun build/full suite/browser smoke, then publish. Do not force-push or treat an untracked Galaxy directory as a completed merge. |
| P1 | Finish Jarvis Prompt 02 live acceptance | Follow `docs/handoffs/JARVIS-02.md`: real English/Bulgarian Wispr capture, review/save, microphone denial, pause/resume, cancel/retry and playback denial. Browser transcription requires the intended Whisper-compatible service. Typed fixtures do not prove transcription accuracy. |
| P2 | Continue Prompt 03: answers focus their sources | Follow the ratified sequence after Prompt 02. Use existing indexed IDs, edges and inspectors; every answer reference must resolve to its actual source. Add search-to-node focus and richer filters without invented relationships. |
| P2 | Resume HUD events after reconnect | F53: the stream currently restarts from now. Add bounded replay from a validated cursor and a regression test proving no missing/duplicate events across reconnect. LISTEN/NOTIFY is a later, measured database change. |
| P2 | Finish HUD accessibility and frame-budget checks | F53 notes small component targets. Measure keyboard focus, target sizes and contrast; verify usable 44 px targets without overlapping graph controls. Capture animation performance and switch to Calm only from measured frame pressure. The current full-screen HUD also leaves the underlying shell in the document's scroll extent. |
| P2 | Establish automated release checks | No tracked `.github/workflows` was present in this checkout. Add a Linux database test job plus Windows path checks, build, dependency audit and browser smoke when integration is ready. Keep provider calls opt-in and fixture claims explicit. |

Proposed acceptance targets for subsequent performance/reliability work: local read APIs p50 ≤100 ms, p95 ≤300 ms, p99 ≤1000 ms on a declared dataset; mobile-4G LCP ≤2.5 s, INP ≤200 ms, CLS ≤0.1; 99.5% request success while the local runtime is intentionally running. These are proposed gates, not achieved SLOs or cloud-hosting commitments.

The build guide's Phase 10/11/12 live evidence and Phase 15–17 release gates remain open as documented in README and handoffs. This logo/security audit does not promote canonical knowledge or close those gates.

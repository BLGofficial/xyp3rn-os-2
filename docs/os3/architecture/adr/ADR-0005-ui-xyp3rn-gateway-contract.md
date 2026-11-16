---
schema: "xyp3rn.decision-record/v3"
id: "ADR-0005"
decision_key: "OS3-D5"
type: "decision_record"
title: "UI-xyp3rn Visual Preservation and 127.0.0.1:8077 Gateway Contract"
domain: "CORE"
sector: "05_XYP3RN_RECORDS"
status: "approved"
decided_by: "blago"
decided_at: "2026-11-16T00:00:00.000Z"
supersedes: null
tags: ["xyp3rn", "adr", "decision", "os3", "ui"]
---

# ADR-0005: `UI-xyp3rn` Visual Preservation and `127.0.0.1:8077` Gateway Contract

## Context
`UI-xyp3rn` implements the approved Constellation Job Map, Jarvis Operator Dock, Full-Screen Jarvis Console, Harmonic Voice Visualizer, and X3LIUS Music Player with deterministic polar layout geometry (`lib/layout.ts`) and visual tokens (`lib/tokens.ts`).

## Decision
1. **100% Visual & Geometry Preservation:** Keep `UI-xyp3rn` as the primary operator interface without altering its visual design, SVG layout math, motion springs, or token palette.
2. **Localhost Gateway (`127.0.0.1:8077`):** Connect `UI-xyp3rn` (`lib/gateway.ts`) to the local Node.js runtime over `http://127.0.0.1:8077` (`/api/health`, `/api/jarvis`, `/api/music/pulse`, `/api/vault/note`, `/api/vault/search`, `/api/approvals`, `/api/approvals/decide`, `/api/events`, `/api/runs`).
3. **Graceful Offline Fallback:** Whenever `127.0.0.1:8077` is unreachable, `UI-xyp3rn` falls back deterministically to its built-in `local-vault` execution engine (`data/map.ts`) without throwing errors.

## Consequences
- `UI-xyp3rn` passes all 4 quality gates (`npm test`, `npm run typecheck`, `npm run lint`, `npm run build`) both standalone and when connected live to the OS 3.0 Gateway.

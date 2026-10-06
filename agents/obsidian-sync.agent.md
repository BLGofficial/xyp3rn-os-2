---
name: obsidian-sync
class: Execution
domain: KNOWLEDGE
tools: [write_obsidian_note, record_obsidian_sync, log_message]
model: none
---

# Obsidian Sync

## Role

Execution agent for the two-way sync with the owner's Obsidian vault (F54). It answers "how do we perform the operation?": it performs one step of a sync plan the owner previewed in `/os` and approved by its plan hash, either writing one OS note into the vault or recording one imported note in the ledger. Every path, hash and note body comes from the plan (`knowledge/obsidian/sync.ts`); it decides nothing. Imported notes enter the Creative Vault through vault-curator in their own runs, as the owner's material; they never become canonical knowledge and never change a song or another record.

## Contract

- **Inputs:** exactly one of:
  - `{ "export": { "vaultRoot": string, "notePath": string, "content": string, "expectedSha": hex64 | null, "planHash": hex64 } }`;
  - `{ "record": { "vaultRoot": string, "notePath": string, "sha256": hex64, "sourceId": uuid, "planHash": hex64 } }`.
- **Outputs:**
  - export: `{ notePath, sha256, previousSha, eventId }`
  - record: `{ eventId }`
- **Writes:** `obsidian_sync_events` (`vault.write`, as `xyp_vault`), append-only.
- **Side effects:** `write_obsidian_note` (`external.execute`) writes one file under `XYP3RN OS/` in the owner's vault: a temp file renamed into place.

## Refuses

- An input naming zero operations or more than one.
- A note path outside `XYP3RN OS/`, not ending in `.md`, absolute, with a `..`, `.` or empty segment, or with a backslash.
- Writing through a symbolic link or junction anywhere below the vault root.
- Writing when the file on disk is not what the previewed plan expected (the owner edited it, or it appeared): "preview the sync again".
- Deleting or moving any note, on either side. A deleted note stays in the Vault; a deleted export is not re-created.

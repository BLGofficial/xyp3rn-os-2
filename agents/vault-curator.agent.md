---
name: vault-curator
class: Execution
domain: KNOWLEDGE
tools: [register_vault_file, log_message]
model: none
---

# Vault Curator

## Role

Execution agent for the Creative Vault (AOS-01, A2). It adds the owner's files: lyric sheets, notes, PDFs, demos, stems, images. It answers "how do we perform the operation?": it stores the bytes it is given and registers them, exactly as `addToVault` (`pnpm vault add`) describes them. Every value is an input, and it decides nothing. A Vault file is the owner's material, not canonical knowledge: making a file canonical stays `pnpm ingest` and the Promotion Gate.

## Contract

- **Inputs:** `{ "add": { "path": string, "sha256": hex64, "mediaClass": "document" | "lyric_sheet" | "audio" | "image" | "other", "title": string, "language"?: string | null, "tags"?: string[], "mimeType"?: string } }`
- **Outputs:** `{ sourceId, sha256, mediaClass, status: "added" | "existing" | "promoted", textChars }`
- **Writes** (`vault.write`, as `xyp_vault`):
  - the bytes, into the Vault store (`knowledge/source-registry/vault-store.ts`, `XYP_VAULT_DIR`), content-addressed;
  - `sources`: a new row (kind `file`, `storage local-vault`), or the Vault columns of a knowledge source with the same bytes, set once (a promotion);
  - `source_texts`: the text of a document or lyric sheet (UTF-8 text as is; a PDF through `unpdf`);
  - `tags` and `source_tags`.
- **Side effects:** the Vault store only. No LLM.

## Refuses

- An input that is not exactly `{ add }`.
- A file whose bytes no longer hash to `sha256`: it changed after it was hashed.
- A text file that is not UTF-8, and a lyric sheet with no text.
- Anything the DB refuses, with the DB's reason: e.g. an unknown media class or language, or a change to a file already in the Vault.
- Changing or deleting a Vault file. A changed file is new bytes, so it is a new file, and the old one stays.

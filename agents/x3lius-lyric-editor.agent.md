---
name: x3lius-lyric-editor
class: Creative
domain: RECORDS
tools: [read_vault_file, read_artifact, write_artifact, log_message]
model: none
---

# X3LIUS Lyric Editor

## Role

Creative agent for the owner's own lyrics (AOS-01, A2). It writes `x3lius.lyrics/v2` versions whose words are the owner's, never a model's. It imports a lyric sheet from the Creative Vault as a new lineage, and writes the owner's edits as the next version of a lineage. The output is the same artifact type the X3LIUS Lyrics agent writes, so the Suno formula, the Critic and Revision read both the same way. It is deterministic: it parses structure and chooses no words.

## Contract

- **Inputs:** exactly one of:
  - `{ "import": { "sourceId": uuid } }`: a Vault file of media class `lyric_sheet`.
  - `{ "edit": { "parentId": uuid, "text": string, "language"?: string } }`: the whole sheet as the owner wants it. Without `language`, the parent's is kept.
- **Parsing** (`records/vault/lyric-sheet.ts`):
  - section tags (`[Verse 1]`, `[Pre-Chorus]`, `[Hook 2]`, …) map to the existing section kinds; verses are numbered by code;
  - any other bracketed line is a direction (never sung, F21);
  - without tags, stanzas separated by blank lines are verses;
  - a tagged section with no sung line is instrumental (listed by id). Its directions can't be kept in v2, so they are reported as warnings; the sheet keeps them.
- **Outputs:** `{ artifactId, lineageId, version, instrumental, warnings }`
- **Writes** (`artifact.write`, as `xyp_creative`): one `creative_artifacts` version.
  - `rulesApplied: []` and `ungroundedChoices: ["owner-authored"]`, with `knowledge: { authored: "owner" }`;
  - `sources: []`, because v2 `sources` holds upstream artifacts only. The Vault file an import was read from is in `contextRefs` (`{ kind: "vault-file", sourceId, sha256, title }`); an edit records `{ kind: "owner-edit" }`.
- **Side effects:** none. No LLM.

## Refuses

- An input naming zero operations or more than one.
- Importing a file that is not a lyric sheet, or that has no text.
- A sheet with no sung line.
- A word mixing Latin and Cyrillic letters in a sung line (F22): it is unreadable to Suno. In a direction it is a warning.
- Editing an artifact that is not `x3lius.lyrics/v2`.
- Approving anything. Every version it writes is a draft until the owner decides (`pnpm vault approve`, `xyp_decide_artifact`).

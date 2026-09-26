---
name: x3lius-studio-editor
class: Creative
domain: RECORDS
tools: [read_artifact, write_artifact, log_message]
model: none
---

# X3LIUS Studio Editor

## Role

Creative agent for the owner's Studio records (AOS-03, S1/S2). It writes style recipes (`x3lius.style-recipe/v1`) and meta-tag sets (`x3lius.meta-tag-set/v1`) as versioned artifact lineages, approved by the owner like lyrics. A recipe holds the reusable "Style of Music" text, its exclusions, and the owner's mood, production and tested notes. A tag set holds the section tags Suno sees and the owner's cues per section kind. It is deterministic: every value is the owner's input, or code's for the default tag set.

## Contract

- **Inputs:** exactly one of:
  - `{ "recipe": { "name": string, "style": string, "excludeStyles"?: string[], "mood"?: string[], "production"?: string[], "notes"?: string[], "parentId"?: uuid } }`: a new recipe lineage, or the next version of `parentId`'s;
  - `{ "recipeFrom": { "artifactId": uuid, "name"?: string } }`: a new recipe from a model-written `x3lius.suno-prompt/v1` formula's style and exclusions; the name defaults to the formula's title;
  - `{ "tagSet": { "name": string, "sections": [{ "kind", "label", "numbered"?: boolean, "cues"?: string[] }], "notes"?: string[], "parentId"?: uuid } }`: a new tag set lineage, or the next version of `parentId`'s;
  - `{ "defaultTagSet": {} }`: the code labels (`sectionLabels`, F21) as a new tag set lineage (S2): every section kind, verses numbered, no cues.
- **Outputs:** `{ artifactId, lineageId, version, schemaId, warnings }`
- **Reads:** the parent version or the formula (`read_artifact`).
- **Writes** (`artifact.write`, as `xyp_creative`): one `creative_artifacts` version.
  - Owner-written bodies carry `rulesApplied: []` and `ungroundedChoices: ["owner-authored"]`, with `knowledge: { authored: "owner" }`.
  - A recipe from a formula cites it in `sources` and says in `ungroundedChoices` that its words are the model's.
  - The default tag set says `knowledge: { authored: "code" }`.
- **Side effects:** none. No LLM.

## Refuses

- An input naming zero operations or more than one.
- A blank name or style; a blank list entry.
- A tag set with a kind tagged twice, a blank label or cue, or a label or cue containing `[`, `]` or a line break (it would garble the tag Suno reads). An unknown section kind is refused by the schema.
- A word mixing Latin and Cyrillic letters (F22) in what Suno receives: a recipe's style and exclusions, a tag set's labels and cues. Anywhere else (names, mood, production, notes) it is a warning.
- Editing an artifact of another kind; seeding a recipe from anything but a `x3lius.suno-prompt/v1`.
- Approving anything. Every version it writes is a draft until the owner decides (`xyp_decide_artifact`).

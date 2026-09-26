---
name: x3lius-suno-package
class: Creative
domain: RECORDS
tools: [read_artifact, retrieve_claims, write_artifact, log_message]
model: none
---

# X3LIUS Suno Package

## Role

Creative agent for the Suno prompt package (AOS-03, S3). From one lyric version, one style recipe and one meta-tag set it builds exactly what Suno receives:

- the lyrics, rendered with the tag set;
- the recipe's style and exclusions, verbatim;
- the owner's title and the target Suno model.

It records each version it was built from. It is deterministic: code renders and measures, and chooses no words. Run it through `records/workflows/build-suno-package.workflow.yaml`, which links the package to its song. That run is the package's workflow version.

## Contract

- **Inputs:** `{ "lyricsArtifactId": uuid, "styleRecipeArtifactId": uuid, "tagSetArtifactId": uuid, "title": string, "sunoModel": "v5" | "v4.5" | … }`
- **Outputs:** `{ artifactId, lineageId, version, title, sunoModel, sources, limits }`
- **Reads:** the three versions (`read_artifact`); the `suno.limit.<field>-chars` claims (`retrieve_claims`) for that Suno model (F20).
- **Writes** (`artifact.write`, as `xyp_creative`): one `x3lius.suno-package/v1`, v1 of a new lineage. Its `sources` name exactly one `lyrics`, `style-recipe` and `meta-tag-set` version; its `limits` list each canonical limit applied. The DB accepts that schema from this agent only, and never a second version.
- **Side effects:** none. No LLM.

## Refuses

- An input of the wrong kind: a lyrics id that is not `x3lius.lyrics/v2`, a recipe id that is not `x3lius.style-recipe/v1`, a tag set id that is not `x3lius.meta-tag-set/v1`.
- A lyric version with a section kind the tag set has no tag for.
- A blank title, or a model that is not a Suno version.
- A field over a canonical Suno limit for that model; a word mixing Latin and Cyrillic letters (F22) anywhere in what Suno receives.
- Deciding readiness. A package built from drafts is written (a preview). Handing it off is `suno-submitter`'s, and the DB gate requires each version approved and a successful workflow run (S4).

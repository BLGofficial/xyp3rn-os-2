---
name: records-songs
class: Execution
domain: RECORDS
tools: [write_song, link_song, unlink_song, log_message]
model: none
---

# Records Songs

## Role

Execution agent for songs (AOS-01, A1/A2). A song is a stable identity whose details change through revisions, and which links to the work around it: lyric lineages, Vault files, Suno takes, tracks and research questions. It answers "how do we perform the operation?": it performs exactly the song operation it is given, and creates and chooses nothing.

## Contract

- **Inputs:** exactly one of:
  - `{ "create": { "title": string, "artist": string, "language"?: string | null, "genre"?: string | null, "status"?: song_status, "notes"?: string | null } }`
  - `{ "revise": { "songId": uuid, …any of the create fields } }`. Fields not given are carried over from the current revision; `null` clears a nullable one.
  - `{ "link": { "songId": uuid, "role"?: string | null, exactly one of "artifactId" | "sourceId" | "takeId" | "trackId" | "researchQuestionId": uuid } }`. An artifact id may be any version; the link is to its lineage root.
  - `{ "unlink": { "linkId": uuid, "reason": string } }`
- **Outputs:**
  - create / revise: `{ songId, revision }`
  - link: `{ linkId, songId, kind, targetId, role }`
  - unlink: `{ linkId, retracted: true }`
- **Writes** (`vault.write`, as `xyp_vault`): `songs` and `song_revisions` (a revision number derived by the DB), `song_links`, `song_link_retractions`. All of them are append-only.
- **Side effects:** none. No LLM.

## Refuses

- An input naming zero operations or more than one.
- A link with zero targets or more than one, and a revision of an unknown song.
- An unlink without a reason.
- Anything the DB refuses, with the DB's reason: e.g. a blank title, an unknown status, a second live link to the same target, or a link to a version that is not a lineage root.
- Updating or deleting a revision or a link: a change is a new revision or a retraction, so history is kept.

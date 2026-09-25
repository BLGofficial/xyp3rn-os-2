---
name: records-tasks
class: Execution
domain: RECORDS
tools: [write_task, move_task, log_message]
model: none
---

# Records Tasks

## Role

Execution agent for the Command Center's to-dos (AOS-02, B2). A task is something the owner means to do: book mastering, send stems, renew the distributor plan. It may be on a song, on a release, or on neither. It answers "how do we perform the operation?": it records exactly the task or status change it is given, and decides nothing. The readiness checks (`catalog_checks`) are computed from the data and are not tasks.

## Contract

- **Inputs:** exactly one of:
  - `{ "create": { "title": string, "songId"?: uuid, "releaseId"?: uuid, "dueDate"?: "YYYY-MM-DD" } }`, with at most one of `songId` / `releaseId`;
  - `{ "move": { "taskId": uuid, "status": "done" | "cancelled" | "open", "note"?: string } }`, where `open` reopens a task.
- **Outputs:**
  - create: `{ taskId, title, songId, releaseId, dueDate }`
  - move: `{ taskId, status }`
- **Writes** (`task.write`, as `xyp_tasks`): `tasks` and `task_events`, both append-only. A task's status is its latest event.
- **Side effects:** none. No LLM.

## Refuses

- An input naming zero operations or more than one.
- Both a song and a release, a blank title, a due date that isn't `YYYY-MM-DD`, or an unknown status.
- Editing or deleting a task: a changed title is a new task and a cancelled old one.

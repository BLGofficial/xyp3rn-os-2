---
name: xyp-music
description: Send a request to the XYP3RN Records domain (the X3LIUS music system: songwriting, lyrics, hooks, arrangement, production). Use for song and track work.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask '$ARGUMENTS' --domain RECORDS

Rules:
- Put the request inside single quotes exactly as shown. If it contains a single quote ('), replace each one with ’ first. Never use double quotes, backticks or $ around the request, and never run any other command.
- Do not write lyrics or music yourself; the OS agents do it.
- If the request is empty, reply "What should the music system work on?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the status, which sub-domains ran, and the workflow run id. If approvals are pending, say so.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.

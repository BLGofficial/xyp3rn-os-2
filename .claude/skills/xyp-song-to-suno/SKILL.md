---
name: xyp-song-to-suno
description: Run the XYP3RN song-to-suno workflow, which turns a song request into a Suno-ready prompt through the OS agents.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask '$ARGUMENTS' --workflow song-to-suno

Rules:
- Put the request inside single quotes exactly as shown. If it contains a single quote ('), replace each one with ’ first. Never use double quotes, backticks or $ around the request, and never run any other command.
- Do not write the prompt yourself; the workflow does it.
- If the request is empty, reply "Which song should I prepare for Suno?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the status and the workflow run id. If a step failed, name it.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.

---
name: xyp-retrieve-summarize
description: Run the XYP3RN retrieve-and-summarize workflow over the knowledge base for a topic.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask '$ARGUMENTS' --workflow retrieve-and-summarize

Rules:
- Put the request inside single quotes exactly as shown. If it contains a single quote ('), replace each one with ’ first. Never use double quotes, backticks or $ around the request, and never run any other command.
- Do not search or summarize yourself; the workflow does it.
- If the request is empty, reply "What topic should I retrieve and summarize?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the summary and the workflow run id.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.

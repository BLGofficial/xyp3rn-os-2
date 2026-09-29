---
name: xyp-research
description: Run an XYP3RN research question through the OS Research domain (research orchestrator and specialist agents). Use when asked to research, investigate or find the best current method for something.
---

Run exactly one command from the repository root, with the user's request as the argument:

pnpm ask '$ARGUMENTS' --domain RESEARCH_INTELLIGENCE

Rules:
- Put the request inside single quotes exactly as shown. If it contains a single quote ('), replace each one with ’ first. Never use double quotes, backticks or $ around the request, and never run any other command.
- Do not do the research yourself; the OS agents do it and record evidence.
- If the request is empty, reply "What should I research?" and stop.
- Read the JSON the command prints. Reply in plain sentences, at most 600 characters, suitable to be read aloud: the outcome, the key findings if any, and the research run id. If approvals are pending, say so.
- If the command fails, say it failed and give the run id if one was printed. Do not retry.

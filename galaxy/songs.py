"""Song sessions: concept -> lyrics -> humanize -> Suno package, with a review stop after every stage.

"Jarvis, write a song about leaving Sofia at night" proposes a session; "do it" starts it. Jarvis
offers three concepts ("go with two"), then drafts the lyrics, humanizes them and packages them for
Suno. At every stop: approve ("looks good"), revise ("make verse two darker"), or scrap the song.
Each approved stage becomes a star in captures/songs/, linked to its siblings by one shared wikilink.
The writing reads the X3LIUS canon (vocal DNA, mix rubric, Suno formula) straight from the repository.
Runs on the Claude subscription with read-only tools; nothing is submitted to Suno.
"""
import re
from pathlib import Path

import desk
import runs
import server

STAGES = ["concept", "lyrics", "humanize", "suno"]
TOOLS = "Read,Grep,Glob"
HUMANIZER = Path.home() / ".claude" / "skills" / "ai-lyric-humanizer"
RULES = """You are Jarvis's songwriting partner for the artist X3LIUS (XYP3RN RECORDS), working read-only
in the XYP3RN engine repository. Before writing, Read records/x3lius/vocal-dna.yaml (his voice, register,
delivery, ad-libs) and records/x3lius/mix-rubric.yaml, and let them shape every line. Bulgarian/English
code-switching only on bar boundaries, never mid-phrase. Never copy existing songs. Output plain text in
EXACTLY the format asked, with nothing before or after it."""
PROMPTS = {
    "concept": """Brief: {brief}{feedback}

Write exactly three distinct song concepts. Format each exactly as:
OPTION 1: <title>
Angle: <one sentence>
Hook: <the hook line, as it would be sung>
(then OPTION 2 and OPTION 3 the same way)""",
    "lyrics": """Brief: {brief}
Chosen concept:
{concept}{previous}{feedback}

Write the full song. Put each section tag on its own line in square brackets, e.g. [Intro], [Verse 1],
[Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]. Keep the hook. Output ONLY the lyrics.""",
    "humanize": """Read {skill}/SKILL.md and apply that humanizing method to these lyrics.{feedback}
Keep every section tag and the hook. Output ONLY the revised lyrics, then a line with --- and at most
three short lines saying what you changed.

{lyrics}""",
    "suno": """Read records/x3lius/suno/formula.ts for the house Suno formula, and package this song for Suno.{feedback}
Output exactly:
STYLE:
<one style prompt under 1000 characters: genre, tempo, mood, instruments, vocal per the vocal DNA>

EXCLUDE:
<comma-separated styles to avoid>

LYRICS:
<the lyrics with their section tags, unchanged words>

{lyrics}""",
}
ASK = {
    "lyrics": "The lyrics are drafted, sir. Approve them, or tell me what to change.",
    "humanize": "The humanized pass is done, sir. Approve it, or tell me what to change.",
    "suno": "The Suno package is ready, sir. Approve it to file the song, or tell me what to change.",
}
NUM = {"one": 1, "two": 2, "three": 3, "first": 1, "second": 2, "third": 3, "1": 1, "2": 2, "3": 3}
PICK = re.compile(r"\b(?:option|hook|number|concept|idea|go\s+with|pick|take|choose)\s+(?:number\s+)?(one|two|three|first|second|third|[123])\b"
                  r"|^\W*(?:the\s+)?(one|two|three|first|second|third|[123])(?:\s+one)?\W*$", re.I)
APPROVE = re.compile(r"^\W*(?:jarvis\W+)?(?:approved?|looks?\s+good|good|great|perfect|lovely|next|continue|keep\s+going"
                     r"|lock\s+it(?:\s+in)?|that'?s\s+it|move\s+on|ship\s+it|yes|yep)\b", re.I)
REVISE = re.compile(r"^\W*(?:jarvis\W+)?(?:please\s+)?(?:rewrite|redo|change|make|more|less|add|remove|cut|swap|keep|try|fix"
                    r"|tighten|replace|use|give|darker|lighter|shorter|longer|lose|drop)\b", re.I)
SCRAP = re.compile(r"\b(?:scrap|stop|cancel|kill|bin)\s+(?:the\s+|this\s+)?song\b", re.I)
START = re.compile(r"^\W*(?:jarvis\W+)?(?:let'?s\s+)?(?:write|make|start|create)\s+(?:me\s+)?(?:a\s+)?(?:new\s+)?(?:song|track|tune)\b\W*(.*)", re.I)


def session():
    """The song session waiting for your review, if any."""
    return next((r for r in reversed(desk.read("runs")) if r["kind"] == "song" and r["status"] == "review"), None)


def propose(text):
    brief = START.match(text).group(1).strip() or text
    return runs.propose("song", brief, stage="concept", drafts={}, options=None)


def _feedback(r):
    return f"\n\nHis notes on the last draft: {r['feedback']}" if r.get("feedback") else ""


def advance(run_id):
    r = next(x for x in desk.read("runs") if x["id"] == run_id)
    stage, drafts = r["stage"], r.get("drafts") or {}
    lyrics = drafts.get("humanize", drafts.get("lyrics", ""))
    lyrics = lyrics.split("\n---", 1)[0].strip()
    prompt = PROMPTS[stage].format(brief=r["text"], feedback=_feedback(r), concept=drafts.get("concept", ""),
                                   previous=f"\n\nYour previous draft:\n{r['draft']}" if r.get("feedback") and r.get("draft") else "",
                                   skill=HUMANIZER.as_posix(), lyrics=lyrics)
    extra = ["--allowedTools", TOOLS, "--max-turns", "12"]
    if stage == "humanize" and HUMANIZER.exists():
        extra += ["--add-dir", str(HUMANIZER)]
    if not runs.transition(run_id, "running", progress=[f"Writing: {stage}"]):
        return   # stopped before the worker began
    try:
        out = runs.stream_claude(run_id, prompt, RULES, "agent", tools=TOOLS, extra=extra, timeout=600)
    except runs.Stopped:
        return
    except Exception as e:
        if runs.transition(run_id, "running", status="review", progress=[f"Failed: {e}"[:160]]):
            desk.raise_card(f"The {stage} draft failed, sir: {e}. Say rewrite to try again.", speak=True, push=False,
                        source="song", kind="song")
        return
    options = None
    if stage == "concept":
        options = [m.strip() for m in re.split(r"(?m)^\s*OPTION\s+\d+\s*:", out) if m.strip()][:3]
        titles = [o.split("\n", 1)[0].strip() for o in options]
        ask = (f"Three concepts, sir: " + "; ".join(f"{i + 1}, {t}" for i, t in enumerate(titles))
               + ". Which one?") if len(options) >= 2 else "The concepts came back garbled, sir. Say rewrite."
    else:
        ask = ASK[stage]
    if runs.transition(run_id, "running", status="review", draft=out, options=options, feedback=None, progress=[]):
        desk.raise_card(ask, speak=True, push=False, source="song", kind="song")   # never for a song you stopped


def _title(r):
    concept = (r.get("drafts") or {}).get("concept", "")
    return concept.split("\n", 1)[0].strip()[:60] or r["text"][:60]


GONE = {"answer": "That song is no longer waiting for you, sir.", "nodes": [], "route": "song"}


def _restart(run_id, **fields):
    """review -> running atomically: a stop or a second click in between never starts a worker."""
    if not runs.transition(run_id, "review", status="running", **fields):
        return False
    run = next(x for x in desk.read("runs") if x["id"] == run_id)
    runs.start(run)
    return True


def reply(text):
    """Your answer to the song under review, or None when the sentence isn't about it."""
    r = session()
    if not r:
        return None
    pending = any(x["status"] == "pending" for x in desk.read("runs"))
    if SCRAP.search(text):
        return runs.stop(r["id"])
    if r["stage"] == "concept":
        m = PICK.search(text)
        if m and r.get("options"):
            n = NUM[(m.group(1) or m.group(2)).lower()]
            if n > len(r["options"]):
                return {"answer": f"There are only {len(r['options'])} concepts, sir.", "nodes": [], "route": "song"}
            drafts = {**r["drafts"], "concept": r["options"][n - 1]}
            title = drafts["concept"].split("\n", 1)[0].strip()
            if not _restart(r["id"], drafts=drafts, stage="lyrics", title=title, draft=None, options=None):
                return GONE
            return {"answer": f"{title} it is, sir. Writing the lyrics.", "nodes": [], "route": "song"}
    elif APPROVE.match(text) and not pending:
        if not r.get("draft"):   # the last generation failed: there is nothing to approve, only to retry
            return {"answer": "There's no draft to approve yet, sir. Say rewrite to try again.", "nodes": [], "route": "song"}
        stage, title = r["stage"], _title(r)
        drafts = {**r["drafts"], stage: r["draft"]}
        link = f"\n\n[[song {title}]]"
        if stage == "suno":
            runs.update(r["id"], drafts=drafts)
            node = runs.finish(r["id"], True, f"The song is filed, sir: {title}. Ready for Suno whenever you are.",
                               f"{title} suno package", r["draft"] + link, note_folder="songs", speak=False)
            return {"answer": f"Filed, sir: {title}, ready for Suno.", "nodes": [node["node"]["id"]] if node else [],
                    "route": "song"}
        server.write_note("songs", f"{title} {stage}", r["draft"] + link)
        nxt = STAGES[STAGES.index(stage) + 1]
        if not _restart(r["id"], drafts=drafts, stage=nxt, draft=None):
            return GONE
        return {"answer": f"Approved, sir. On to the {nxt} stage.", "nodes": [], "route": "song"}
    if REVISE.match(text) or (r["stage"] == "concept" and not PICK.search(text) and REVISE.search(text)):
        if not _restart(r["id"], feedback=text):
            return GONE
        return {"answer": "Very good, sir. Revising.", "nodes": [], "route": "song"}
    return None

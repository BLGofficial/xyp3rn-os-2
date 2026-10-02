#!/usr/bin/env python3
"""Index markdown notes into the Knowledge Galaxy.

    python build.py [NOTES_DIR]

NOTES_DIR defaults to the folder above galaxy/ (the XYP3RN engine repo).
Writes viewer/graph-data.js for the viewer and notes.json for the brain.
Standard library only.
"""
import json
import os
import re
import sys
from itertools import combinations
from pathlib import Path

HERE = Path(__file__).resolve().parent
NOTES_DIR = HERE.parent
CAPTURES = "captures"   # /remember writes here; walked last so a rebuild keeps earlier ids stable
SKIP_DIRS = {".git", "node_modules", ".next", ".vault", ".local-db", ".local-models",
             ".codex", ".trash", "dist", "coverage", "fixtures"}
# README.md, SKILL.md and index.md describe their folder, so they take the folder's name
# as their label and sit in the folder's parent group.
ENTRY_FILES = {"readme", "skill", "index"}
EXCERPT_CHARS = 700
BRAIN_CHARS = 12000

FRONTMATTER = re.compile(r"\A---\s*\n.*?\n---\s*\n", re.S)
WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
DOMAIN_LINE = re.compile(r"^domain:\s*([A-Z_]+)\s*$", re.M)
# The OS's six domains (core/contracts/taxonomy.ts); everything else is "shared", as in the web app's rail.
DOMAINS = ("CORE", "KNOWLEDGE", "RESEARCH_INTELLIGENCE", "RECORDS", "TECH", "GOVERNANCE")
DOMAIN_DIRS = {"core": "CORE", "knowledge": "KNOWLEDGE", "research-intelligence": "RESEARCH_INTELLIGENCE",
               "records": "RECORDS", "tech": "TECH", "governance": "GOVERNANCE"}


def clean(md):
    """Markdown to one line of prose for the excerpt."""
    text = FRONTMATTER.sub("", md)
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"^[ \t]*#{1,6}[ \t]*(.+?)[ \t#]*$", r"\1 · ", text, flags=re.M)  # headings read as "Title · Role · ..."
    text = re.sub(r"^[ \t]*(?:[-*+]|\d+\.)[ \t]+", "", text, flags=re.M)             # list bullets
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = WIKILINK.sub(r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"(?<!\w)[*_]+|[*_]+(?!\w)|[#>`|]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def excerpt(text):
    if len(text) <= EXCERPT_CHARS:
        return text
    return text[:EXCERPT_CHARS].rsplit(" ", 1)[0] + "…"


def find_notes():
    for root, dirs, files in os.walk(NOTES_DIR):
        dirs[:] = sorted((d for d in dirs
                          if d not in SKIP_DIRS and Path(root, d).resolve() != HERE),
                         key=lambda d: (Path(root) == NOTES_DIR and d == CAPTURES, d))
        for name in sorted(files):
            if name.lower().endswith(".md"):
                yield Path(root, name)


def describe(path):
    """Label, group and the path fragment other notes use to mention this one."""
    stem = path.name.split(".")[0]
    folder = path.parent
    if stem.lower() in ENTRY_FILES:
        label = folder.name
        group = "root" if folder == NOTES_DIR or folder.parent == NOTES_DIR else folder.parent.name
        mention = f"{folder.name}/{path.name}"
    else:
        label = stem
        group = "root" if folder == NOTES_DIR else folder.name
        mention = path.name
    return label, group, mention


def domain_of(rel, md):
    """A note's OS domain: its frontmatter `domain:` when it declares one, else its top folder."""
    fm = FRONTMATTER.match(md)
    m = DOMAIN_LINE.search(fm.group(0)) if fm else None
    if m and m.group(1) in DOMAINS:
        return m.group(1)
    parts = rel.split("/")
    if parts[0] == CAPTURES and len(parts) > 2 and parts[1] == "songs":
        return "RECORDS"
    return DOMAIN_DIRS.get(parts[0], "shared")


def mention_pattern(label, mention):
    """A note is mentioned by its file name, a [[wikilink]] to its title, or, when the
    title is specific enough (has a separator or digit), by the title itself."""
    parts = [re.escape(mention), r"\[\[\s*" + re.escape(label) + r"\s*\]\]"]
    if len(label) >= 4 and re.search(r"[-_ \d]", label):
        words = [w for w in re.split(r"[-_ ]+", label) if w]
        parts.append(r"(?<![\w-])" + r"[-_ ]".join(map(re.escape, words)) + r"(?![\w-])")
    return re.compile("|".join(parts), re.I)


def linked(new_text, new_pattern, new_wikis, texts, patterns, wikis):
    """Indexes of existing notes linked to a new one, by the same rules as a full build."""
    return [i for i, (text, pattern, w) in enumerate(zip(texts, patterns, wikis))
            if new_pattern.search(text) or pattern.search(new_text) or (new_wikis & w)]


def main():
    global NOTES_DIR
    if len(sys.argv) > 1:
        NOTES_DIR = Path(sys.argv[1]).resolve()
    nodes, brain, raw, patterns, wikis = [], [], [], [], []
    for path in find_notes():
        md = path.read_text(encoding="utf-8", errors="replace")
        label, group, mention = describe(path)
        rel = path.relative_to(NOTES_DIR).as_posix()
        i = len(nodes)
        nodes.append({"id": i, "label": label, "group": group, "path": rel, "domain": domain_of(rel, md),
                      "excerpt": excerpt(clean(md))})
        brain.append({"id": i, "label": label, "group": group, "path": rel,
                      "text": md[:BRAIN_CHARS]})
        raw.append(md)
        patterns.append(mention_pattern(label, mention))
        wikis.append({w.strip().lower() for w in WIKILINK.findall(md)})

    pairs = set()
    for a, text in enumerate(raw):
        for b, pattern in enumerate(patterns):
            if a != b and pattern.search(text):
                pairs.add((min(a, b), max(a, b)))
    for a, b in combinations(range(len(nodes)), 2):
        if wikis[a] & wikis[b]:
            pairs.add((a, b))
    links = [{"source": a, "target": b} for a, b in sorted(pairs)]

    (HERE / "viewer").mkdir(exist_ok=True)
    data = json.dumps({"nodes": nodes, "links": links}, ensure_ascii=False)
    (HERE / "viewer" / "graph-data.js").write_text(
        "// Generated by build.py. Do not edit.\nconst GRAPH = " + data + ";\n", encoding="utf-8")
    (HERE / "notes.json").write_text(json.dumps(brain, ensure_ascii=False), encoding="utf-8")

    groups = sorted({n["group"] for n in nodes})
    print(f"{len(nodes)} notes, {len(links)} links, {len(groups)} groups from {NOTES_DIR}")
    print("groups:", ", ".join(groups))


if __name__ == "__main__":
    main()

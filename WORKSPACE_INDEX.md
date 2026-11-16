# Workspace index

Everything produced in this workspace, and what state it is in.

---

## 1. Agentic OS — graph view (current work)

| file | what it is | state |
|---|---|---|
| `agentic-os-graph-view.html` | Force-directed graph view of the OS. Zoom, drill-down on every entity, edge clicking, breadcrumb, Jarvis voice + chat console. Self-contained — no external requests. | **Working, verified. Sample data.** |
| `GRAPH_LAYOUT_MIGRATION_PLAN.md` | Audit plan (A1–A4), layout options, edge model, 6-step migration sequence, verification checklist, and the full prototype verification log. | Current |
| `graph_view_tests/` | The verification harness + its README. Runs the real page script against a stubbed DOM. | Working |

**Open `agentic-os-graph-view.html` in a browser.** Everything is in that one file.

### What is real vs. placeholder

- **Real:** the layout engine, the render path, the camera, hit-testing, drill-down
  navigation, edge picking, and the Jarvis interpreter. All verified.
- **Placeholder:** the 26 applications, the 84 edges, and the per-domain item counts.
  These mirror the source galaxy reference; they are **not** read from the real repo.

### Two things not yet proven

1. **The microphone.** The preview sandbox denies mic permission and this sandbox has no
   browser, so the recognition path was verified against fake browser speech APIs only.
   No real microphone has reached this code. Test it on your machine — it may also fail
   when opened as a `file://` page rather than over http.
2. **The audit itself.** `https://github.com/BLGofficial/xyp3rn-os-2` is private:
   anonymous `git clone` asks for credentials and the web page returns 404. The audit
   needs repo access — a GitHub connector, a public URL, or a zip of the repo.

---

## 2. Galaxy view reverse-engineering (delivered earlier)

| file | what it is |
|---|---|
| `galaxy_view_prompts.md` | 6-part prompt pack: master spec, React/TS build brief with typed data model, image-gen prompts with per-model variants and a negative prompt, motion spec, variant matrix, QA checklist. |
| `galaxy-measurements.json` | Machine-readable measurements taken from the reference render — aspect ratio, centre, radii, counts, palette, typography, motion. |
| `agentic-os-galaxy-view.html` | Live animated SVG recreation of the galaxy map, driven by the same data model. |
| `render/` | Proof PNGs from the PDF build. |
| `uploads/` | Your original inputs: the galaxy reference image and the five source brand PDFs. |

---

## 3. XYP3RN brand identity (delivered earlier)

`brand_kit/` — the finished package.

- `README.md` — package guide (its Rebuilding section explains what was lost)
- 6 deliverable PDFs: `XYP3RN_Brand_Identity_Master.pdf` (51pp),
  `XYP3RN_System_01_Mercury` … `_04_Foundry` (14pp each),
  `XYP3RN_Color_Reference_Cards.pdf` (4pp)
- `assets/` — 41 SVGs
- `fonts/` — 12 TTFs
- ~~`build/`~~ — **the generator scripts are gone.** See the warning below.

`README_XYP3RN_Brand_Identity.md` is the original brand brief.

---

## ⚠ One thing was lost

The brand kit's generator scripts lived in `brand_kit/build/`. **`build` is on the
workspace snapshot's exclusion list** — along with `dist`, `out`, `target`, `coverage`,
`node_modules` and `.venv` — so the whole folder was silently dropped between sessions.

**Every delivered artifact survived:** 6 PDFs, 41 SVGs, 12 fonts, both READMEs. What is
gone is only the ability to *re-run* the build. The finished PDFs and SVGs are a complete
specification of the intended output, so the generator can be rewritten from them.

**If you add build scripts again, do not put them in a folder named `build/`, `dist/`,
`out/` or `target/`.** Use `generator/` or `src/`. A `brand_kit/build/` would be written
and then vanish again, exactly like this one did.

---

## Reproducing the verification

```bash
cd graph_view_tests
./run_all.sh
```

Requires Node. No setup, no absolute paths — the runners read the page from the parent
folder and extract the script themselves. Individual suites:

```bash
node run.js t_smoke.js      # boots, render loop, chips, log
node run.js t_metrics.js    # layout geometry + determinism
node run.js t_full.js       # zoom, drill-down, edges, intents, chat
node run_voice.js t_voice2.js   # speech in/out with fake browser speech APIs
```

These catch logic, runtime and geometry bugs — including two invisible to the eye. They
cannot catch a visual regression; anything cosmetic still needs a real browser.

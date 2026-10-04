# AGENTIC OS — GRAPH GALAXY VIEW
## Reverse-engineered layout → prompt system

Everything below is measured off your reference, not estimated. Geometry, hex values, radii
and node counts were extracted from the source image by pixel analysis. That matters because
"I want a space dashboard" produces a generic result, while `r=490px, 22 hex nodes, 1.23:1
canvas, #FFCB18 core rim` reproduces yours.

**How to use this document**

| § | Prompt | Use it for |
|---|---|---|
| 1 | **Master spec block** | Paste into anything. The shared DNA. |
| 2 | **Build brief** | Claude Code / Cursor / v0. Produces working software. |
| 3 | **Image generation** | Midjourney, Ideogram, Flux, Nano Banana, Seedream. |
| 4 | **Motion graphics** | After Effects, Rive, Jitter, Framer, Remotion. |
| 5 | **Variant matrix** | Swap tokens to re-skin without rewriting. |
| 6 | **QA checklist** | Verify a render or a build actually matches. |

A working live recreation of your reference ships alongside this file:
`agentic-os-galaxy-view.html` — open it and the animation runs.

---

# 1 · MASTER SPEC BLOCK

Copy this whole block into any tool as the immutable foundation. It contains no styling
opinions that conflict between tools — only measurements.

```
CANVAS
  aspect 1.234:1 (reference 1668 x 1352). Landscape, poster-grade.
  centre-anchored radial composition. Nothing is aligned to a grid – everything is
  aligned to a centre point.

BACKGROUND FIELD
  radial gradient, 4 stops, off-centre at 50%/46%:
    #1A1F38 -> #11142A (26%) -> #0A0C1C (58%) -> #04050E (100%)
  star field: ~300 points, radius 0.5–2.0px, opacity 0.10–0.52, cool white #CFE0FA.
  density increases toward the core; a clear zone of r<170px around the core.
  ~35% of stars twinkle on a 3–6s ease-in-out cycle.

RADIAL STRUCTURE  (radii in reference px, centre = 842,609)
  r   63   core disc
  r  120   inner dashed guide orbit
  r  152   ambient glow envelope
  r   90–460  the dot-cloud band (see CLUSTERS)
  r  490   ring of glass hexagon nodes (22 of them, evenly spaced)
  r  640   satellite header row

CORE
  disc r=63. fill: radial #2A2230 -> #191320 -> #0F0B16 (lit from upper-left).
  rim: single 1.6px stroke in #FFC300, plus a 0.6px inner stroke rgba(255,214,120,.55).
  glow: radial envelope to r≈152, #FFC300 at 34% alpha falling to zero, blurred ~9px.
  label: "CLAUDE.MD", bold sans, 27px, letterspacing .20em, #EEF3FC, centred.
  sublabel: mono, 13px, letterspacing .10em, gold #C9A227, "global + vault".

GLASS NODES  (outer ring, 22 units)
  40px flat-top hexagon, circumradius 27px.
  fill: linear gradient #1B2547 (78%) -> #0D1329 (62%)  -- translucent, not opaque.
  stroke: 1.1px rgba(168,205,245,.34).
  catch-light: 0.9px rgba(255,255,255,.30) arc across the top two edges only.
  outer ghost ring: same hexagon at r+3.4, rgba(120,170,240,.13).
  drop shadow: y+5, blur 7, #02030A at 75%.
  glyph: 17px single-stroke monochrome icon centred inside, #DCE6F5, stroke-width 1.5,
         round caps and joins. One glyph per node, never two.
  label: mono 14px #8FA8C8, placed OUTSIDE the ring, left-aligned on the right half
         and right-aligned on the left half, 13px clear of the hexagon.
  hover: fill lifts to rgba(38,56,96,.72), stroke to #FFF at 1.6px, label to #EAF1FB.

CONNECTORS
  one hairline per node, from r≈80 to r≈460 on the node's exact angle.
  stroke rgba(140,180,240,.055), 1px. Almost invisible until you look for them.

ORBIT MARKERS ("routines")
  7 amber orbs dwelling between the rings at r 246–268.
  each: r=7.4 ring rgba(255,195,0,.34) + r=3.4 core #FFC300 with a tight glow
        + two 1px satellite specks at ±11px.
```

**Typography**

```
display / wordmark   bold grotesque, letterspacing .18–.22em, uppercase
cluster labels       bold mono, uppercase, letterspacing .16em, 15–17px, colour = its cluster
counts               mono, 12px, #DCE6F5 at 90%
app labels           mono, 14px, letterspacing .05em, #8FA8C8
footer               mono, 13px, letterspacing .18em, #5A6B8C
```

**Cluster palette — measured from the reference**

| Cluster | Hue | Count | Radius | Arc span |
|---|---|---|---|---|
| SKILLS | `#FFCB18` | 85 | 122 | full 360° |
| MEMORY | `#A186FF` | 77 | 206 | partial |
| META & INFRA | `#52C7FD` | 9 | 300 | short |
| COLLECTIONS | `#53E485` | 5 | 296 | short |
| DEV & PRS | `#3AD9BF` | 27 | 300 | long |
| KNOWLEDGE | `#A186FF` | 13 | 322 | short |
| CONTENT & MEDIA | `#F76FB4` | 15 | 392 | short |
| LIFE OS | `#FFCB18` | 16 | 404 | short |

Secondary hues present in the dot field: cyan `#52C7FD`, blue `#6BA8FE`, teal `#3AD9BF`,
green `#53E485`, pink `#F76FB4`, violet `#A186FF`, gold `#E4B833`.

**Dot-cloud behaviour — the detail most recreations miss**

Dots are not evenly distributed. They arrive in *spoke groups* of 2–3 dots, and each spoke is
jittered ±0.6° from true while dots inside a spoke step 5–6px radially. Dot radius varies
0.72–1.22× of a 6–7.4px base. Opacity varies 0.72–1.00. Roughly half carry a 4.4px glow;
half are flat. That irregularity is what makes the field read as *organic* rather than as a
progress ring. A perfectly even distribution kills the entire effect.

---

# 2 · BUILD BRIEF
### for Claude Code, Cursor, v0, Lovable

```
Build a full-screen animated radial network visualisation — an "agentic OS galaxy view".

STACK
  React + TypeScript + Vite. Rendering in SVG (not canvas) so every element stays
  inspectable, hoverable and accessible. No animation library — CSS transform/opacity
  only, so it holds 60fps and respects prefers-reduced-motion.

DATA MODEL
  Export a single typed data file. The view must render entirely from it; no hard-coded
  geometry in components.

    type Cluster = {
      id: string; label: string; count: number;
      color: string; radius: number; from: number; to: number;
      groupSize: [number, number]; dotBase: number; jitter: number;
    }
    type AppNode  = { id:string; label:string; icon:string; angle:number }
    type Routine  = { id:string; angle:number; radius:number; label:string }
    type GalaxyData = {
      core: { title:string; subtitle:string; radius:number };
      clusters: Cluster[]; apps: AppNode[]; routines: Routine[];
    }

  Seed all randomness with a fixed PRNG so the star field and dot jitter are stable
  across reloads and across machines. Two people opening the app must see the same sky.

GEOMETRY  (implement exactly — these are measured, not invented)
  viewBox 0 0 1668 1352, centre (842, 609)
  core disc r=63 · inner dashed guide r=120 · glow envelope r=152
  dot-cloud band r 90–460 · app node ring r=490 · satellite header row r=640
  22 app nodes evenly spaced from -90° clockwise.
  7 routine orbs at r 246–268.

VISUAL SPEC
  Follow the master spec block in § 1 of the accompanying document exactly:
  background gradient, star field, core, glass hexagons, connectors, cluster palette.

BEHAVIOUR
  · Slow counter-rotation of the cluster groups — 240s, 300s and 420s periods, so the
    three shells drift out of phase and never re-align.
  · Core "breathes": scale 1 -> 1.055 -> 1 over 7s ease-in-out, glow opacity 0.62 -> 0.95
    over 9s. These are offset so the two cycles visibly separate.
  · Nodes float ±4px on a 12s cycle, phase-offset per node.
  · Travelling light pulses run outward along six of the spokes on a 5.5s cubic-bezier
    (.6,0,.4,1) cycle, staggered.
  · Hover on any node: raise glass fill, brighten the stroke to white, lift the label.
    Hover on a cluster label: highlight that cluster's dots and dim the rest to 35%.
  · Click a node: emit a selection event with the node id. Do not build the detail panel —
    just the event and a documented prop for the consumer.

ACCESSIBILITY
  Every node is a real focusable element with an accessible name.
  All motion is disabled under prefers-reduced-motion (keep the composition, drop the
  animation). Text meets WCAG AA against the deep background — the app labels are the
  risk, so verify them.

QUALITY BAR
  Crisp at any zoom. No raster assets. No CSS filters on the root element.
  Must survive being exported to a static 2x PNG for print and to a 15s loop for video.
```

---

# 3 · IMAGE GENERATION PROMPTS

Built for the "high resolution, enhanced colour, glassmorphism, luxury, dynamic layout" brief.
Every variant below is a single copy-paste block.

## 3.1 Universal prompt
Works across Midjourney, Flux, Ideogram, Seedream, Nano Banana Pro.

```
A luxury deep-space data visualisation poster, ultra high resolution, cinematic.

A single brilliant glowing core disc at the exact centre of frame — dark plum-black sphere
with a razor-thin molten amber rim, wrapped in a soft warm amber halo that bleeds outward
and dissolves. Inside the disc, crisp white bold lettering with wide letterspacing, and a
small line of gold monospace text beneath it.

Orbiting the core: concentric rings of hundreds of small luminous dots, arranged in loose
clusters and short arcs with deliberate irregularity — never an even circle. The dots form
a colour spectrum travelling around the rings: acid green, teal, ice cyan, electric blue,
soft violet, hot magenta, amber gold. Each dot glows softly, some sharper than others,
creating depth through varied bloom.

Beyond the dot rings, evenly spaced around a wide outer orbit: twenty-two small hexagonal
glass buttons. Each hexagon is translucent dark sapphire, edged with a fine cool-white
stroke, with a subtle white catch-light across its top edge, a soft drop shadow, and a
single minimal monochrome line icon inside. Tiny monospace labels sit beside each hexagon
in muted steel blue.

A field of faint stars fills the deep background — the void is a four-step radial gradient
from midnight indigo at the centre to near-black at the edges. Hair-thin radial lines
connect the core to each outer node, almost invisible. A few small amber orbs drift between
the rings, each with its own faint halo.

TYPOGRAPHY: bold grotesque wordmarks with generous letterspacing and monospace metadata
labels. Everything uppercase, everything precisely tracked.

COLOUR: deep midnight navy and indigo ground; accents of amber gold #FFCB18, teal #3AD9BF,
ice cyan #52C7FD, electric blue #6BA8FE, violet #A186FF, hot magenta #F76FB4, acid green
#53E485. High saturation accents against a very dark, very rich ground.

MOOD: premium enterprise software, precision instrument, luxury watchmaking meets
deep-space astronomy. Composed, expensive, quietly confident. Perfectly symmetrical.
Extremely sharp. No clutter.
```

## 3.2 Midjourney
Append to the universal prompt:

```
--ar 5:4 --style raw --stylize 250 --quality 2 --v 6.1
```
Notes: `--style raw` stops MJ from redecorating your palette. If it over-glows, drop to
`--stylize 100`. If the dot rings come out too regular, add `--no symmetrical ring, even
spacing` and describe the irregularity twice.

## 3.3 Ideogram / Seedream — typography-critical
These models render text reliably, so lean on that:

```
[same universal prompt]

TEXT RENDERING REQUIREMENTS:
  Centre of the core disc reads exactly: CLAUDE.MD
  Directly beneath it, smaller and in gold monospace: global + vault
  Cluster labels orbiting the core, each in its cluster colour, bold uppercase monospace
  with wide letterspacing:
      SKILLS · 85    MEMORY · 77    META & INFRA 9    COLLECTIONS 5
      DEV & PRS 27   KNOWLEDGE 13   CONTENT & MEDIA 15   LIFE OS 16
  Near the top of the frame: APPLICATIONS · 22   and beneath it   ROUTINES · 7
  Bottom edge, small centred monospace caption:
      SCROLL / PINCH TO ZOOM · DRAG TO PAN · HOVER FOR LINKS · CLICK FOR DETAIL
  Spell every word exactly. No invented characters. No warped or doubled letters.
```

## 3.4 Flux / Nano Banana Pro — photorealism pass
Bring the glass up to product-render quality:

```
[same universal prompt]

RENDER NOTES:
  Physically-based rendering. The hexagon nodes are real frosted glass — you can read the
  faintest refraction through them, with a 0.5px specular catch-light along the top bevel
  edge and a soft ambient occlusion contact shadow beneath.
  The core disc has a subtle brushed-metal micro-texture and a rim light that behaves like
  a real emissive material, with visible bloom falloff.
  Volumetric haze sits between the orbital shells so nearer rings read brighter and further
  rings slightly desaturate — atmospheric perspective.
  Shallow depth of field: the core plane is tack sharp, the outermost node ring falls
  marginally soft.
  8k, octane render, ray-traced glass, subtle chromatic aberration at the frame edges only.
```

## 3.5 Negative prompt — all models

```
no text errors, no lorem ipsum, no distorted letters, no duplicated words,
no photographic people, no faces, no hands, no animals, no spaceships,
no planets with rings, no rockets, no astronauts, no nebula clouds, no lens flare streaks,
no rainbow gradients, no pastel or washed-out colours, no white background,
no cartoon or cel-shaded look, no clipart icons, no emoji,
no cluttered UI panels, no browser chrome, no drop-shadowed boxes,
no flat evenly-spaced dots, no perfect thin circle of dots,
no watermark, no signature, no frame, no border, no mockup device
```

## 3.6 Scale / aspect variants

| Use | Prompt change |
|---|---|
| 16:9 hero | `--ar 16:9`. Add "core sits slightly left of centre, negative space right for headline copy" |
| 21:9 ultrawide | `--ar 21:9`. "wider outer orbits, node ring pushed to the extremes of frame" |
| 4:5 portrait | `--ar 4:5`. "dropped core, dense dot band upper frame" |
| Square | `--ar 1:1`. "tight crop, only the inner three shells visible" |
| 2x print | render at 4:5 then upscale; keep the dot glow tight or it turns to mush in CMYK |

---

# 4 · MOTION GRAPHICS SPEC

### 4.1 After Effects

```
Comp: 1920x1557, 29.97fps, 20s loop, 32-bit, working space Rec.709.

LAYER STACK, bottom to top:
  01  Background       radial gradient, 4 stops, off-centre 50%/46%
  02  Star Field       CC Star Burst, 300 stars, size 0.5–2.0, then a 0.35 opacity
                       Turbulent Displace for organic drift
  03  Glow Envelope    ellipse, amber, Gaussian Blur 60, opacity animated 62 -> 95 -> 62
                       over 9s ease-in-out
  04  Shell — outer    dot cloud group r 380–460      rotation 0 -> 360 over 420s
  05  Shell — mid      dot cloud group r 190–340      rotation 0 -> 360 over 300s (reverse)
  06  Shell — inner    dot cloud group r  90–150      rotation 0 -> 360 over 240s
  07  Connectors       hairline spokes, 5% opacity
  08  Routine Orbs     7 amber orbs, slow bob ±3px, per-orb halo pulse
  09  Nodes            22 hexagons: float ±4px on 12s, in-point staggered 0.06s
  10  Core             disc + rim + label. Scale 100 -> 105.5 -> 100 over 7s
  11  Labels           cluster chips, fade up 0 -> 100 over 0.8s, staggered
  12  Grain + Vignette  3% film grain, radial vignette 22%

EASING — the only three curves in the piece:
  ambient loops        linear
  breathing / pulsing  ease-in-out (cubic-bezier .42 0 .58 1)
  arrivals             cubic-bezier .16 1 .3 1   (fast out, long settle)

THE REVEAL — first 3 seconds
  0.00  background + stars fade in from black, 0 -> 100 over 40 frames
  0.30  core scales from 0.86 to 1 with the .16 1 .3 1 curve, glow blooms 8 frames late
  0.55  inner dot shell fades in and starts rotating; dots scale 0 -> 1 individually
        in angular order, 1.2s total
  1.10  mid shell, same treatment, counter-rotating
  1.60  outer shell
  2.00  connectors draw on — Trim Paths 0 -> 100%, 24 frames, staggered outward
  2.35  node hexagons pop in on the .16 1 .3 1 curve, 0.06s stagger, 18 frames each;
        their glyphs fade 4 frames behind
  2.80  labels fade up, 0.5s stagger
  3.20  settle into the ambient loop

THE AMBIENT LOOP — 20s
  Three shells rotate continuously and never re-sync (240 / 300 / 420s periods).
  Core breathes in 7s and its glow breathes in 9s — deliberately coprime so the pattern
  doesn't repeat within the loop.
  Six light pulses travel outward from core to node ring every 5.5s, staggered 0.9s,
  opacity 0 -> 100 -> 0, size 2px, amber #FFD86B.
  One flicker event per 20s: a single random node's stroke flashes to white for 4 frames
  with a soft glow. Feels alive; don't overdo it.

EXPORT
  4K ProRes 4444 with alpha for overlays.
  H.264 40Mbps for web. A 15s cut-down for social.
  First frame exported as a 2x still for hero images.
```

### 4.2 Rive / Jitter / Framer (interactive)

```
Artboard 1668 x 1352, three nested state machines.

STATES
  idle     shells rotate (240/300/420s), core breath 7s, glow 9s, stars twinkle
  hover    on node: glass fill -> rgba(38,56,96,.72); stroke -> #FFFFFF @1.6;
           label -> #EAF1FB; node lifts 4px; 280ms cubic-bezier(.16,1,.3,1)
  focus    on cluster: that cluster's dots to 100% and r+6, all others to 35% opacity;
           400ms ease-out. Cluster label scales 1 -> 1.08.

INPUTS   hoverTarget (string) · focusCluster (string) · zoom (0.6–2.4) · reducedMotion (bool)
```

### 4.3 Remotion (code-driven video)

```
Composition id="GalaxyView" fps={30} durationInFrames={600} width={1920} height={1557}

  const t = frame / fps;
  shellRotation(shell) = (t / shell.period) * 360
  coreScale            = 1 + 0.055 * (0.5 - 0.5*Math.cos(2*Math.PI*t/7))
  glowOpacity          = 0.62 + 0.33 * (0.5 - 0.5*Math.cos(2*Math.PI*t/9))
  nodeFloat(i)         = Math.sin(2*Math.PI*(t/12) + i*0.37) * 4

Render with --codec=h264 --crf=16, plus a ProRes 4444 alpha pass.
```

---

# 5 · VARIANT MATRIX

Swap only the tokens in the top block. Nothing below the fold changes.

## 5.1 Colour climate

| Climate | Token swap |
|---|---|
| **Graphite** (monochrome, enterprise) | drop all cluster hues to a single ramp `#E8EEF7 → #7C8CA6`; keep only the core rim amber |
| **Aurora** | green `#53E485` · teal `#3AD9BF` · ice `#8FE9FF` · violet `#A186FF`; core rim `#7CF0C8` |
| **Ember** | `#FFCB18` · `#FF9A3C` · `#F76FB4` · `#FF5C5C`; core rim `#FF8A00` |
| **Deep ocean** | `#52C7FD` · `#2E86FF` · `#3AD9BF` · `#6BA8FE`; core rim `#8FD4FF` |
| **Ivory / light mode** | ground `#F4F6FB → #E4E9F2`; nodes glass `rgba(255,255,255,.72)`; ink `#101828`; keep accents saturated — they carry the whole thing |
| **XYP3RN Mercury** | reuse your brand kit: core rim `#D2A44E`, dots across `#D2A44E · #D5D3DE · #53A2CE · #492F45 · #07014C` |

## 5.2 Content variants

| Variant | What to change |
|---|---|
| **Repo graph** | core = repository; ring 1 = files; ring 2 = imports; outer nodes = services |
| **Org chart** | core = company; rings = departments; hexagons = teams |
| **Knowledge base** | core = the vault; rings = domains; hexagons = sources |
| **ML pipeline** | core = model; rings = layers; hexagons = data sources and sinks |
| **Dense** | 60 nodes, 6 shells, smaller dots — reads as infrastructure |
| **Sparse** | 12 nodes, 3 shells, larger dots — reads as executive summary |

## 5.3 Density dial

```
sparse   dot radius ×1.5   nodes 12   shells 3   node ring r=420
default  dot radius ×1.0   nodes 22   shells 5   node ring r=490
dense    dot radius ×0.7   nodes 60   shells 6   node ring r=560
```
Rule: as node count rises, hold the hexagon size constant and shorten the labels to one
word. Never shrink the hexagons below 32px — the glyph stops reading.

---

# 6 · QA CHECKLIST

Run this against any render or build before it ships.

**Geometry**
- [ ] Canvas ratio 1.234:1, or an intentional scale variant from § 3.6
- [ ] Core disc r ≈ 3.8% of canvas width
- [ ] Node ring r ≈ 29.4% of canvas width
- [ ] Node count matches the data, spaced exactly `360/n` apart, first node at −90°
- [ ] Every node sits on the ring radius, not near it

**Colour**
- [ ] Background is a 4-stop radial gradient, not a flat fill
- [ ] Each cluster label's colour matches its dot colour exactly
- [ ] No more than 7 hues visible in the dot field
- [ ] Core rim is the brightest single element in the frame

**The details that separate a good render from a generic one**
- [ ] Dots arrive in irregular spoke groups of 2–3, not evenly distributed
- [ ] Dot radius and opacity both vary; roughly half carry a glow
- [ ] Each cluster occupies a distinct arc — clusters never overlap
- [ ] Hexagons have a catch-light on the top edges only
- [ ] Connector spokes are present and nearly invisible
- [ ] Star field has a clear zone around the core
- [ ] Labels sit outside the ring, aligned away from the centre

**Common failure modes**
| Symptom | Cause | Fix |
|---|---|---|
| Reads as a loading spinner | dots perfectly even | add spoke grouping + jitter (§ 1) |
| Flat, cheap | opaque nodes, no glow variance | translucent glass, half the dots glowing |
| Muddy | too many hues | cut to 5–7, keep the core warm |
| Feels empty | no connectors, no star field | add both; they carry the depth |
| Text is garbled | diffusion model lettering | use the Ideogram/Seedream variant (§ 3.3) |
| Looks like a game HUD | heavy stroke weights, bright outlines | drop strokes to ≤1.1px, opacity ≤35% |

---

## Files in this package

| File | What it is |
|---|---|
| `galaxy_view_prompts.md` | This document |
| `agentic-os-galaxy-view.html` | Live animated recreation — open in any browser |
| `galaxy-measurements.json` | Every extracted number, machine-readable |

The HTML recreation is generated from the same data model the build brief specifies, so it
doubles as a reference implementation: `CLUSTERS`, `APPS`, `ROUTINES` at the top of its
script are the exact objects § 2 asks for.

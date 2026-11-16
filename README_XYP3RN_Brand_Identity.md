# XYP3RN — Brand Visual Identity

Complete visual identity system built from the uploaded source palettes, in the visual
language of `01_XYP3RN_Brand_Guidelines.pdf` (dark ground, gradient rule, corner arcs,
Bebas/Josefin/Raleway/JetBrains Mono stack, mono metadata chrome).

Order of work: first the palette document in the toolbox, then the systems. The primary
PDF shares a lot with my visual language; I noted the strongest motifs from each PDF and
used them consistently. I hope you like them.

---

## What's in this package

### Documents

| File | Pages | What it is |
|---|---|---|
| `XYP3RN_Brand_Identity_Master.pdf` | 51 | The full identity system. Strategy, the mark, the type stack, colour architecture, all four colour systems specified in full, verbal identity, governance. |
| `XYP3RN_System_01_Mercury.pdf` | 14 | Mercury, from the original brand guidelines. |
| `XYP3RN_System_02_Meadow.pdf` | 14 | Meadow, from `Meadow Green.pdf`. |
| `XYP3RN_System_03_Twilight.pdf` | 14 | Golden Twilight, from `Golden Twilight.pdf`. |
| `XYP3RN_System_04_Foundry.pdf` | 14 | Foundry, from `palette.pdf`. |
| `XYP3RN_Color_Reference_Cards.pdf` | 4 | One-page reference sheet per system. This is the file to pin next to a monitor. |

Each system book is standalone and complete: cover, contents, thesis, palette, the ramp,
full specification table, surfaces, accessibility, the mark in that system, lockups,
product application, print application, governance and checks.

### Asset pack — `assets/`

Production SVG, one folder per system (`00_shared` holds the cross-system sheet):

| Asset | Notes |
|---|---|
| `mark-<system>.svg` | The mark, transparent background. Punch is transparent — set it to the surface it sits on. |
| `mark-on-bg-<system>.svg` | Mark with the punch already matching the page ground. |
| `mark-on-elevated-<system>.svg` | Mark with the punch matching the elevated surface. |
| `lockup-stacked-<system>.svg` | Mark above wordmark. Product chrome, cover art. |
| `lockup-horizontal-<system>.svg` | Mark beside wordmark. Headers, docs, email. |
| `wordmark-<system>.svg` | Wordmark alone, for below minimum mark size. |
| `app-icon-<system>.svg` | 1024×1024, rounded corners. |
| `app-icon-light-<system>.svg` | Same geometry on the print ground. |
| `gradient-bar-<system>.svg` | The signature gradient, 1200×60. |
| `swatches-<system>.svg` | Swatch sheet with hex labels. |

The mark SVGs are the real geometry, not a redraw — see *The mark* below.

---

## The four systems

Each palette is a complete climate. The structure underneath never changes.

| | **Mercury** | **Meadow** | **Golden Twilight** | **Foundry** |
|---|---|---|---|---|
| Source | `01_XYP3RN_Brand_Guidelines.pdf` | `Meadow Green.pdf` | `Golden Twilight.pdf` | `palette.pdf` |
| Stops | 5 | 10 | 5 | 5 |
| Character | Warm plum to cold navy | Green growing into deep water | Royal night, struck gold | Charcoal, brass, brushed steel |
| Warm pole | `#D2A44E` | `#99D98C` | `#FFC300` | `#E2C044` |
| Cool pole | `#53A2CE` | `#168AAD` | `#006FD6` | `#8FAEB2` |
| Signal neutral | `#D5D3DE` | `#EDF7E8` | `#FFD60A` | `#D3D0CB` |
| Page ground | `#060610` | `#05120C` | `#000814` | `#1E2019` |
| Deploys to | Master brand, XYP3RN Tech, TRACE, core product UI | XYP3RN Records, artist surfaces, campaign and cover art | Mobile app, live and performance, launch campaigns | Documentation, API surface, print, packaging, hardware |

**One surface, one system.** A campaign can carry Meadow on the sleeve and Mercury inside
the plugin manual — different surfaces, different systems. Two systems inside one surface
is never allowed, at any size, for any reason. When nothing fits, use Mercury.

---

## The mark

The XYP3RN mark was reverse-engineered from the vectors in the source guidelines PDF, so
the SVGs here are dimensionally identical to the original, not a redraw:

- Two round-capped bars at 45°, cool bar drawn over the warm bar
- Cap centres inset 11.40 units on a 100-unit box; bar width 22.81
- A square punched out of the exact centre, in the colour of the surface behind it
- Four signal dots, ⌀10.60, centred on the caps

Full construction drawing and annotation is on page 7 of the master book.

**What changes between systems:** the two poles and the signal dot colour.
**What never changes:** the geometry, the type stack, the voice, clear space,
minimum sizes and the forbidden treatments.

---

## Type stack

| Role | Typeface | Sizes | Colour |
|---|---|---|---|
| Display | Milligram Macro (Josefin Sans) | 48–64pt | Signal neutral |
| H1 / H2 | Bebas Neue | 28–36 / 20–26pt | Signal neutral |
| H3 | Josefin Sans 600 | 13–16pt | Warm accent |
| Body | Raleway 400/500/700 | 9–12pt, leading 1.6 | Body ink |
| Labels | JetBrains Mono | 7–9pt, tracking .14em caps | Warm or cool accent |

The source guidelines name "Milligram Macro" for display and specify Josefine Sans as its
rendering face. Josefine Sans is loaded as the display face throughout.

---

## System specifications

Contrast is calculated (WCAG relative luminance), not estimated. Full tables are on the
specification and accessibility pages of each system book.

### System 01 — MERCURY

**Warm plum to cold navy.**  
Deploys to: Master brand · XYP3RN Tech · TRACE flagship · core product UI

| Stop | Hex | RGB | HSB | CMYK | On BG | On panel |
|---|---|---|---|---|---|---|
| Plum | `#492F45` | 73, 47, 69 | 309° 36% 29% | 0, 36, 5, 71 | 1.7:1 | 1.6:1 |
| Amber | `#D2A44E` | 210, 164, 78 | 39° 63% 82% | 0, 22, 63, 18 | 8.8:1 | 8.4:1 |
| Silver | `#D5D3DE` | 213, 211, 222 | 251° 5% 87% | 4, 5, 0, 13 | 13.6:1 | 13.1:1 |
| Steel Blue | `#53A2CE` | 83, 162, 206 | 201° 60% 81% | 60, 21, 0, 19 | 7.1:1 | 6.8:1 |
| Deep Navy | `#07014C` | 7, 1, 76 | 245° 99% 30% | 91, 99, 0, 70 | 1.1:1 | 1.0:1 |

| Surface | Hex | Use |
|---|---|---|
| BG Chrome | `#04040C` | Bars, nav, chrome |
| BG Primary | `#060610` | All page backgrounds |
| BG Panel | `#0D0C1A` | Cards, sections |
| BG Elevated | `#131225` | Raised surfaces |
| Paper (print) | `#EFEEF4` | Print ground |
| Tint (print) | `#DEDCE8` | Print panel |

| | Mark warm pole | Mark cool pole | Signal dots | Core |
|---|---|---|---|---|
| | `#D2A44E` | `#53A2CE` | `#D5D3DE` | `#D2A44E` |

### System 02 — MEADOW

**Green that grows into deep water.**  
Deploys to: XYP3RN Records · artist-facing surfaces · campaign and cover art

| Stop | Hex | RGB | HSB | CMYK | On BG | On panel |
|---|---|---|---|---|---|---|
| Signal | `#D9ED92` | 217, 237, 146 | 73° 38% 93% | 8, 0, 38, 7 | 15.0:1 | 13.8:1 |
| Sprout | `#B5E48C` | 181, 228, 140 | 92° 39% 89% | 21, 0, 39, 11 | 13.1:1 | 12.1:1 |
| Fern | `#99D98C` | 153, 217, 140 | 110° 35% 85% | 29, 0, 35, 15 | 11.5:1 | 10.6:1 |
| Clover | `#76C893` | 118, 200, 147 | 141° 41% 78% | 41, 0, 27, 22 | 9.5:1 | 8.8:1 |
| Meadow | `#52B69A` | 82, 182, 154 | 163° 55% 71% | 55, 0, 15, 29 | 7.8:1 | 7.2:1 |
| Lagoon | `#34A0A4` | 52, 160, 164 | 182° 68% 64% | 68, 2, 0, 36 | 6.1:1 | 5.6:1 |
| Current | `#168AAD` | 22, 138, 173 | 194° 87% 68% | 87, 20, 0, 32 | 4.8:1 | 4.4:1 |
| Tide | `#1A759F` | 26, 117, 159 | 199° 84% 62% | 84, 26, 0, 38 | 3.7:1 | 3.4:1 |
| Marina | `#1E6091` | 30, 96, 145 | 206° 79% 57% | 79, 34, 0, 43 | 2.9:1 | 2.6:1 |
| Abyss | `#184E77` | 24, 78, 119 | 206° 80% 47% | 80, 34, 0, 53 | 2.2:1 | 2.0:1 |

| Surface | Hex | Use |
|---|---|---|
| BG Chrome | `#030A07` | Bars, nav, chrome |
| BG Primary | `#05120C` | All page backgrounds |
| BG Panel | `#0A1C15` | Cards, sections |
| BG Elevated | `#0F261D` | Raised surfaces |
| Paper (print) | `#F3FAEF` | Print ground |
| Tint (print) | `#E1F1DA` | Print panel |

| | Mark warm pole | Mark cool pole | Signal dots | Core |
|---|---|---|---|---|
| | `#99D98C` | `#168AAD` | `#EDF7E8` | `#52B69A` |

### System 03 — GOLDEN TWILIGHT

**Royal night, struck gold.**  
Deploys to: XYP3RN mobile app · live and performance surfaces · launch campaigns

| Stop | Hex | RGB | HSB | CMYK | On BG | On panel |
|---|---|---|---|---|---|---|
| Midnight Deep | `#000814` | 0, 8, 20 | 216° 100% 8% | 100, 60, 0, 92 | 1.0:1 | 1.2:1 |
| Midnight | `#001D3D` | 0, 29, 61 | 211° 100% 24% | 100, 52, 0, 76 | 1.2:1 | 1.0:1 |
| Royal | `#003566` | 0, 53, 102 | 209° 100% 40% | 100, 48, 0, 60 | 1.6:1 | 1.4:1 |
| Gold | `#FFC300` | 255, 195, 0 | 46° 100% 100% | 0, 24, 100, 0 | 12.5:1 | 10.5:1 |
| Sun | `#FFD60A` | 255, 214, 10 | 50° 96% 100% | 0, 16, 96, 0 | 14.2:1 | 12.0:1 |

| Surface | Hex | Use |
|---|---|---|
| BG Chrome | `#00040A` | Bars, nav, chrome |
| BG Primary | `#000814` | All page backgrounds |
| BG Panel | `#001D3D` | Cards, sections |
| BG Elevated | `#003566` | Raised surfaces |
| Paper (print) | `#F7F1DE` | Print ground |
| Tint (print) | `#EDE4C8` | Print panel |
| Twilight Sky (adapted accent) | `#006FD6` | from Royal `#003566` — 3.4:1 on panel |

| | Mark warm pole | Mark cool pole | Signal dots | Core |
|---|---|---|---|---|
| | `#FFC300` | `#006FD6` | `#FFF3C9` | `#FFC300` |

### System 04 — FOUNDRY

**Charcoal, brass hardware, brushed steel.**  
Deploys to: XYP3RN documentation · API and developer surfaces · print, packaging, hardware

| Stop | Hex | RGB | HSB | CMYK | On BG | On panel |
|---|---|---|---|---|---|---|
| Char | `#1E2019` | 30, 32, 25 | 77° 22% 13% | 6, 0, 22, 87 | 1.0:1 | 1.1:1 |
| Slate | `#393E41` | 57, 62, 65 | 202° 12% 25% | 12, 5, 0, 75 | 1.5:1 | 1.4:1 |
| Verdigris | `#587B7F` | 88, 123, 127 | 186° 31% 50% | 31, 3, 0, 50 | 3.6:1 | 3.2:1 |
| Bone | `#D3D0CB` | 211, 208, 203 | 38° 4% 83% | 0, 1, 4, 17 | 10.7:1 | 9.5:1 |
| Brass | `#E2C044` | 226, 192, 68 | 47° 70% 89% | 0, 15, 70, 11 | 9.3:1 | 8.3:1 |

| Surface | Hex | Use |
|---|---|---|
| BG Chrome | `#15170F` | Bars, nav, chrome |
| BG Primary | `#1E2019` | All page backgrounds |
| BG Panel | `#26292A` | Cards, sections |
| BG Elevated | `#2F3336` | Raised surfaces |
| Paper (print) | `#EDEBE6` | Print ground |
| Tint (print) | `#DEDBD4` | Print panel |
| Foundry Steel (adapted accent) | `#8FAEB2` | from Verdigris `#587B7F` — 6.2:1 on panel |

| | Mark warm pole | Mark cool pole | Signal dots | Core |
|---|---|---|---|---|
| | `#E2C044` | `#8FAEB2` | `#D3D0CB` | `#E2C044` |

---

## Adapted colours

Four background steps are needed before any interface can be built, and occasionally a
structural stop is too dark to carry a mark. Those gaps are filled under a rule:

1. **Named** — appears in the specification with the stop it came from
2. **Bounded** — only where the source stop fails contrast; never in a swatch grid,
   never in a gradient, never as a substitute for a brand colour
3. **Derived** — same hue, same saturation, lightness only
4. **Disclosed** — if a colour is not on its system's specification page, it is not in
   the system

Two adapted accents exist across all four systems:

| Adapted accent | From | Why |
|---|---|---|
| Twilight Sky `#006FD6` | Royal `#003566` | Royal reads 1.5:1 on the Twilight page ground. It is a structural colour, so it carries borders and panels — not the mark. Twilight Sky is Royal lifted to 42% lightness. |
| Foundry Steel `#8FAEB2` | Verdigris `#587B7F` | Verdigris reads 2.3:1 on the Foundry panel. Foundry Steel is Verdigris lifted to 63% lightness. |

The four background steps per system are documented, not improvised — they are the source
palette tinted toward each system's cool pole.

---

## Governance — eight checks before anything ships

1. One system — exactly one colour system per surface
2. Two poles — the mark uses the active system's warm and cool poles
3. Live punch — the centre punch is the colour of the surface behind the mark
4. Signal dots — the four corner dots use the system's signal neutral
5. Ramp order — gradients run the palette in published order, never reordered
6. Four surfaces — no more than four background steps on screen
7. Contrast tier — every text pairing cleared the measured table *before* the build
8. One accent — no composition carries two accents

Questions, approvals, asset requests: `brand@xyp3rn.com` (placeholder, as in the source).

---

## Rebuilding

Source is in `build/`:

```
build/pdata.py    palette data model + colour maths (hex/rgb/hsb/cmyk/contrast)
build/blocks.py   CSS and page chrome
build/svgs.py     the mark construction and technical drawings
build/pages.py    system pages (palette, spec, surfaces, mark, application)
build/pages2.py   master pages (strategy, architecture, voice, governance)
build/build.py    assembles every PDF
build/assets.py   writes the SVG asset pack

python3 build/build.py all      # all six PDFs
python3 build/assets.py         # SVG asset pack
```

Built with WeasyPrint. Fonts are in `fonts/` (Bebas Neue, Josefin Sans, Raleway,
JetBrains Mono — all open-licence, downloaded from Google Fonts).

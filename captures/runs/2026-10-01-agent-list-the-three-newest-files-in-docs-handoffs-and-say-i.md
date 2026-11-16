# Agent list the three newest files in docs/handoffs and say in one 

Captured 2026-10-01.

Status: done

JARVIS-02, JARVIS-01 and AOS-04 are the three newest handoffs, covering Studio voice capture, the Mercury sphere with the eight areas, and Research mode plus the Mercury shell.

Request: list the three newest files in docs/handoffs and say in one line each what they cover

JARVIS-02, JARVIS-01 and AOS-04 are the three newest handoffs, covering Studio voice capture, the Mercury sphere with the eight areas, and Research mode plus the Mercury shell.

Newest first:

1. docs/handoffs/JARVIS-02.md (dated 2026-10-01): Studio voice capture. Typed or Wispr-dictated text is reviewed and saved to the Vault, with optional Whisper recording and Kokoro read-back. The live English and Bulgarian dictation checks are still pending before Prompt 03.
2. docs/handoffs/JARVIS-01.md: The Mercury sphere graph view (overview API, geometry, SVG sphere with keyboard controls) and the eight app areas, with 1456 tests passing.
3. docs/handoffs/AOS-04.md: Research mode (briefs, 20 specialists whose quotes are checked word for word, the Findings Library, owner approval before anything becomes canonical) and the Mercury shell (design tokens, fonts, Sofia clock). The specialists' model call wasn't run live because no OpenRouter key was set here.

How I ranked them: the file listing is sorted by modification time but only puts JARVIS-02 clearly last. The others seem to share one timestamp, probably from the checkout. So I ranked 2 and 3 by their contents: test counts rise from 1012 in PHASE-14 to 1322 in AOS-04 to 1456 in JARVIS-01, and each handoff names the next one. I couldn't run git log to confirm this.

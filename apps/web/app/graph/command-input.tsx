// The command input (Jarvis Prompt 01), at the bottom of the centre column: a plain GET form to /search, so it works
// without JavaScript. It searches the whole index; answers and voice are later prompts, and no control here pretends
// otherwise (no microphone, no attachment).
export const CommandInput = () => (
  <form action="/search" method="get" role="search" aria-label="Command input" className="sticky bottom-0 z-10 mt-10 border-t border-line bg-canvas/95 pb-3 pt-3 backdrop-blur">
    <div className="flex items-end gap-2">
      <label className="field min-w-0 flex-1">
        <span>Search everything</span>
        <input id="command-q" name="q" type="search" placeholder="Search everything: files, songs, agents, decisions…" autoComplete="off" className="w-full" />
      </label>
      <button type="submit">Search</button>
    </div>
    <p className="meta mt-1">Answers from your Vault: Prompt 03 · Voice: Prompt 02</p>
  </form>
);

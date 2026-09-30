import { askAction } from '../ask-actions';
import { SKILLS } from '../../lib/skills';

// The command input (Jarvis Prompt 01), at the bottom of the centre column. Search stays the form's first button,
// a plain GET to /search, so Enter searches and it works without JavaScript. Ask posts the same text to the tier
// router (apps/web/server/ask-ops.ts) and opens /ask/[id]. Skills and the deep task run Claude Code headless, so
// they are shown only when the server runs with LLM_ENGINE=claude-code; voice is Prompt 02 (no microphone here).
export const CommandInput = () => {
  const engine = process.env.LLM_ENGINE === 'claude-code';
  return (
    <form action="/search" method="get" role="search" aria-label="Command input" className="sticky bottom-0 z-10 mt-10 border-t border-line bg-canvas/95 pb-3 pt-3 backdrop-blur">
      <div className="flex items-end gap-2">
        <label className="field min-w-0 flex-1">
          <span>Search or ask</span>
          <input id="command-q" name="q" type="search" placeholder="Search everything, or ask: how many approvals are pending?" autoComplete="off" className="w-full" />
        </label>
        <button type="submit">Search</button>
        <button type="submit" formAction={askAction}>Ask</button>
      </div>
      {engine ? (
        <div className="meta mt-2 flex flex-wrap items-center gap-2" role="group" aria-label="Skills and deep task">
          <span>Skills:</span>
          {SKILLS.map((s) => <button key={s.name} type="submit" formAction={askAction} name="skill" value={s.name}>{s.label}</button>)}
          <label className="ml-2 inline-flex items-center gap-1"><input type="checkbox" name="deep" /> Deep task (Claude Code)</label>
        </div>
      ) : (
        <p className="meta mt-1">Ask answers from stored data and routes to the domain agents · Skills and deep tasks: LLM_ENGINE=claude-code · Voice: Prompt 02</p>
      )}
    </form>
  );
};

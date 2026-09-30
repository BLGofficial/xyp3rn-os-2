'use server';

import { attempt, opt, text } from './action-kit';
import { askOps, runtime } from '../lib/server';

// Mercury's Ask (the command input's Ask and skill buttons) through apps/web/server/ask-ops.ts. A refusal
// (empty request, engine off, a cap) returns to Command as ?error=.

export async function askAction(form: FormData) {
  return attempt('/', async () => {
    const [rt, ops] = [await runtime(), await askOps()];
    return ops.startAsk(rt.owner, { text: text(form, 'q'), ...(opt(form, 'skill') ? { skill: opt(form, 'skill') } : {}), deep: form.get('deep') === 'on' }, ops.askRunners(rt.deps));
  }, (id) => `/ask/${id}`);
}

export async function cancelAskAction(form: FormData) {
  const id = text(form, 'requestId');
  return attempt(`/ask/${id}`, async () => {
    const r = (await askOps()).cancelAsk((await runtime()).owner, id);
    if (r === 'not-cancellable') throw new Error('Only a skill or deep task can be cancelled; a run keeps going and is recorded in Workflows or Research');
  });
}

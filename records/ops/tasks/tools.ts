import type { Sql } from '../../../core/db/client.ts';
import { defineTool, type Tool } from '../../../core/tool-registry/registry.ts';
import { asRole, obj, text, uuid } from '../tools.ts';

/**
 * Task tools (AOS-02, B2; design §4.2), task.write, as xyp_tasks. A task is immutable; its status is
 * its latest event (open when it has none), so the history of every task is kept.
 */

export const TASKS_ROLE = 'xyp_tasks';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
type Deps = { readonly sql: Sql };

/**
 * write_task (task.write): a to-do, on a song, a release, or neither (a general task).
 * @param deps - pool; writes as xyp_tasks
 * @returns the tool definition
 */
export const createWriteTaskTool = (deps: Deps): Tool =>
  defineTool({
    name: 'write_task',
    capability: 'task.write',
    description: 'Create a task (title, optional due date) on a song, a release, or neither.',
    handler: async (ctx, args) => {
      const a = obj('write_task', args);
      const title = text('write_task', 'title', a.title).trim();
      const given = (k: string) => a[k] !== undefined && a[k] !== null;
      if (given('songId') && given('releaseId')) throw new Error('write_task: at most one of songId, releaseId');
      const songId = given('songId') ? uuid('write_task', 'songId', a.songId) : null;
      const releaseId = given('releaseId') ? uuid('write_task', 'releaseId', a.releaseId) : null;
      const dueDate = given('dueDate') ? text('write_task', 'dueDate', a.dueDate) : null;
      if (dueDate !== null && !ISO_DATE.test(dueDate)) throw new Error('write_task: dueDate must be YYYY-MM-DD');
      const [t] = await asRole(deps.sql, TASKS_ROLE, (tx) => tx<{ id: string }[]>`
        insert into tasks (title, song_id, release_id, due_date, agent_run_id) values (${title}, ${songId}, ${releaseId}, ${dueDate}::date, ${ctx.runId})
        returning id`);
      ctx.log('info', `write_task: "${title}" → ${t!.id}`);
      return { taskId: t!.id, title, songId, releaseId, dueDate };
    },
  });

/**
 * move_task (task.write): a task's next status (done, cancelled, or open to reopen it), with a note.
 * @param deps - pool; writes as xyp_tasks
 * @returns the tool definition
 */
export const createMoveTaskTool = (deps: Deps): Tool =>
  defineTool({
    name: 'move_task',
    capability: 'task.write',
    description: "Move a task to done, cancelled, or open (reopened), with an optional note; its history is kept.",
    handler: async (ctx, args) => {
      const a = obj('move_task', args);
      const taskId = uuid('move_task', 'taskId', a.taskId);
      const status = text('move_task', 'status', a.status);
      if (!['open', 'done', 'cancelled'].includes(status)) throw new Error('move_task: status must be open, done or cancelled');
      const note = a.note === undefined || a.note === null ? null : text('move_task', 'note', a.note).trim() || null;
      await asRole(deps.sql, TASKS_ROLE, (tx) => tx`insert into task_events (task_id, status, note, agent_run_id) values (${taskId}, ${status}, ${note}, ${ctx.runId})`);
      ctx.log('info', `move_task: ${taskId} → ${status}`);
      return { taskId, status };
    },
  });

/**
 * @param deps - pool
 * @returns write_task, move_task
 */
export const createTaskTools = (deps: Deps): readonly Tool[] => [createWriteTaskTool(deps), createMoveTaskTool(deps)];

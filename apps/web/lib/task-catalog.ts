/** Public task IDs map to server-owned execution targets, never arbitrary tools or paths. */
export const TASK_CATALOG = [
  { id: 'lyrics', label: 'Write lyrics', category: 'Music', description: 'Draft verses, a chorus, or a complete lyric with the Lyrics agent.', prefix: 'Write lyrics. ', target: { workflow: 'write-lyrics' } },
  { id: 'music', label: 'Develop a song', category: 'Music', description: 'Explore songwriting, composition, genre, and arrangement.', prefix: 'Songwriting and composition. ', target: { domain: 'RECORDS' } },
  { id: 'research', label: 'Research a topic', category: 'Research', description: 'Run the research specialists and follow their sources and findings.', prefix: '', target: { domain: 'RESEARCH_INTELLIGENCE' } },
  { id: 'song-to-suno', label: 'Song to Suno', category: 'Workflow', description: 'Build structure, lyrics, style, and a Suno prompt. Submission stays separate.', prefix: '', target: { workflow: 'song-to-suno' } },
  { id: 'retrieve', label: 'Explore knowledge', category: 'Knowledge', description: 'Retrieve and summarize knowledge through the existing workflow.', prefix: '', target: { workflow: 'retrieve-and-summarize' } },
  { id: 'agent', label: 'Agent work', category: 'Agent', description: 'Run a technical brief through the registered Tech domain agents.', prefix: '', target: { domain: 'TECH' } },
] as const;
export type TaskId = (typeof TASK_CATALOG)[number]['id'];
export const taskOf = (id: unknown) => TASK_CATALOG.find(task => task.id === id);
export type KnowledgeChoice = { id: string; title: string; kind: string; detail: string };
export type RecentTask = { requestId: string; title: string; state: string; status: string; createdAt: number };
export const MAX_KNOWLEDGE = 6;

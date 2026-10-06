import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import ContextDispatchPipeline from './ContextDispatchPipeline';
import KnowledgeGraphExplorer from './KnowledgeGraphExplorer';
import GalaxyMapCanvas from './GalaxyMapCanvas';
import AudioDeck from './AudioDeck';
import './XYP3RNResearchRecordsDashboard.css';
import '../enhance.css'; // after the pack's own CSS: the finish layer must win ties

type Destination = 'research' | 'obsidian' | 'records' | 'dispatch' | 'knowledge-graph' | 'galaxy';
type Notebook = { id: string; name: string; description?: string; sourceCount?: number; sources?: SourceFile[]; updatedAt?: string; status?: string };
type Track = { id: string; title: string; artist?: string; audioUrl?: string; duration?: number; updatedAt?: string; type?: 'release' | 'demo' | string; releaseName?: string; coverUrl?: string; progress?: string; progressPercent?: number };
type SourceFile = { id: string; name: string; path?: string; kind?: string; size?: number; updatedAt?: string };
const nav = [
  { group: 'RESEARCH', items: [{ id: 'research' as const, label: 'Notebook LLM', icon: '◫' }, { id: 'dispatch' as const, label: 'Context Dispatch', icon: '⤳' }] },
  { group: 'KNOWLEDGE', items: [{ id: 'obsidian' as const, label: 'Obsidian Folder', icon: '▤' }, { id: 'knowledge-graph' as const, label: 'Knowledge Graph', icon: '⌘' }, { id: 'galaxy' as const, label: 'Galaxy Map', icon: '✳' }] },
  { group: 'RECORDS', items: [{ id: 'records' as const, label: 'Track Library', icon: '♫' }] },
];
const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
const endpoint = {
  notebooks: '/api/v1/research/notebooks',
  tracks: '/api/v1/records/tracks',
  obsidian: '/api/v1/knowledge/obsidian',
  importKnowledge: '/api/v1/knowledge/import',
  importObsidian: '/api/v1/knowledge/obsidian/import',
  importAudio: '/api/v1/records/import',
};
function obj(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function arrayFrom<T>(value: unknown, key: string): T[] { const body = obj(value); return Array.isArray(value) ? value as T[] : Array.isArray(body[key]) ? body[key] as T[] : []; }
function niceDate(value?: string) { if (!value) return 'Recently updated'; const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function sizeLabel(bytes?: number) { if (!bytes) return ''; return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`; }

export default function XYP3RNResearchRecordsDashboard() {
  const [view, setView] = useState<Destination>('research');
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebooksState, setNotebooksState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [activeNotebook, setActiveNotebook] = useState<string>('');
  const [tracks, setTracks] = useState<Track[]>([]);
  const [tracksState, setTracksState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [trackFilter, setTrackFilter] = useState<'all' | 'release' | 'demo'>('all');
  const [activeTrack, setActiveTrack] = useState<Track | null>(null);
  const [obsidianFiles, setObsidianFiles] = useState<SourceFile[]>([]);
  const [obsidianState, setObsidianState] = useState<'loading' | 'ready' | 'offline'>('loading');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);
  const [newNotebook, setNewNotebook] = useState(false);
  const [notebookName, setNotebookName] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importTarget, setImportTarget] = useState<'knowledge' | 'obsidian' | 'audio' | 'notebook' | 'lyrics' | 'metadata'>('knowledge');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [folderMode, setFolderMode] = useState(false);
  const [audioTitle, setAudioTitle] = useState('');
  const [audioKind, setAudioKind] = useState<'release' | 'demo'>('demo');
  const [lyricsLanguage, setLyricsLanguage] = useState('en');
  const [storage, setStorage] = useState<{ lyrics?: string; metadata?: string }>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const activeNotebookRecord = notebooks.find((n) => n.id === activeNotebook) || notebooks[0];
  const filteredTracks = useMemo(() => tracks.filter((track) => trackFilter === 'all' || (track.type || 'release').toLowerCase() === trackFilter), [tracks, trackFilter]);

  useEffect(() => {
    let alive = true;
    fetch(endpoint.notebooks).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((data) => {
      if (!alive) return; const rows = arrayFrom<Notebook>(data, 'notebooks'); setNotebooks(rows); setActiveNotebook(rows[0]?.id || ''); setNotebooksState('ready');
    }).catch(() => { if (alive) setNotebooksState('offline'); });
    fetch(endpoint.tracks).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((data) => {
      if (!alive) return; const rows = arrayFrom<Track>(data, 'tracks'); setTracks(rows); setActiveTrack(rows[0] || null); setStorage(obj(obj(data).storage) as { lyrics?: string; metadata?: string }); setTracksState('ready');
    }).catch(() => { if (alive) setTracksState('offline'); });
    fetch(endpoint.obsidian).then((r) => { if (!r.ok) throw new Error(); return r.json(); }).then((data) => {
      if (!alive) return; setObsidianFiles(arrayFrom<SourceFile>(data, 'files')); setObsidianState('ready');
    }).catch(() => { if (alive) setObsidianState('offline'); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { if (folderInputRef.current) folderInputRef.current.setAttribute('webkitdirectory', ''); }, []);
  const startImport = (target: 'knowledge' | 'obsidian' | 'audio' | 'notebook' | 'lyrics' | 'metadata' = 'knowledge') => {
    setImportTarget(target); setSelectedFiles([]); setImportMessage(''); setFolderMode(false); setAudioTitle(''); setAudioKind('demo'); setShowImport(true);
  };
  const submitImport = async () => {
    if (!selectedFiles.length) { setImportMessage('Select at least one file first.'); return; }
    if (importTarget === 'audio' && !audioTitle.trim()) { setImportMessage('Enter a track title before importing audio.'); return; }
    const tooBig = selectedFiles.find((file) => file.size > MAX_IMPORT_BYTES);
    if (tooBig) { setImportMessage(`Import failed: ${tooBig.name} is ${sizeLabel(tooBig.size)}; the limit is 100 MB per file.`); return; }
    setImporting(true); setImportMessage('');
    const form = new FormData(); selectedFiles.forEach((file) => form.append('files', file, (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name));
    form.append('destination', importTarget === 'obsidian' ? 'obsidian' : importTarget === 'audio' ? 'records' : importTarget === 'lyrics' || importTarget === 'metadata' ? importTarget : importTarget === 'notebook' ? 'research-notebook' : 'knowledge');
    if (importTarget === 'audio') { form.append('title', audioTitle.trim()); form.append('trackType', audioKind); }
    if (importTarget === 'lyrics') form.append('language', lyricsLanguage);
    if (importTarget === 'notebook' && activeNotebookRecord) form.append('notebookId', activeNotebookRecord.id);
    const url = importTarget === 'obsidian' ? endpoint.importObsidian : importTarget === 'audio' || importTarget === 'lyrics' || importTarget === 'metadata' ? endpoint.importAudio : importTarget === 'notebook' && activeNotebookRecord ? `${endpoint.notebooks}/${encodeURIComponent(activeNotebookRecord.id)}/sources` : endpoint.importKnowledge;
    try {
      const response = await fetch(url, { method: 'POST', body: form }); if (!response.ok) { const body = obj(await response.json().catch(() => ({}))); throw new Error(typeof body.error === 'string' ? body.error : `Import failed (${response.status})`); }
      const result = await response.json().catch(() => ({})); setImportMessage(`${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} added${result?.message ? ` · ${result.message}` : '.'}`);
      if (importTarget === 'obsidian') { const refreshed = await fetch(endpoint.obsidian).then((r) => r.json()); setObsidianFiles(arrayFrom<SourceFile>(refreshed, 'files')); }
      if (importTarget === 'audio') { const refreshed = await fetch(endpoint.tracks).then((r) => r.json()); setTracks(arrayFrom<Track>(refreshed, 'tracks')); }
      if (importTarget === 'notebook') { const refreshed = await fetch(endpoint.notebooks).then((r) => r.json()); const rows = arrayFrom<Notebook>(refreshed, 'notebooks'); setNotebooks(rows); }
      setSelectedFiles([]); setAudioTitle('');
    } catch (error) { setImportMessage(error instanceof Error ? (error.message.startsWith('Import failed') ? error.message : `Import failed: ${error.message}`) : 'Import service unavailable.'); }
    finally { setImporting(false); }
  };
  const createNotebook = async (event: FormEvent) => {
    event.preventDefault(); if (!notebookName.trim()) return;
    try {
      const response = await fetch(endpoint.notebooks, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: notebookName.trim() }) });
      if (!response.ok) throw new Error(); const data = obj(await response.json()); const created = obj(data.notebook || data) as unknown as Notebook;
      setNotebooks((items) => [created, ...items]); setActiveNotebook(created.id); setNotebookName(''); setNewNotebook(false);
    } catch { setNotebooksState('offline'); }
  };
  const askNotebook = async (event: FormEvent) => {
    event.preventDefault(); if (!question.trim() || !activeNotebookRecord) return;
    setAsking(true); setAnswer(''); setCitations([]);
    try {
      const response = await fetch(`${endpoint.notebooks}/${encodeURIComponent(activeNotebookRecord.id)}/query`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: question.trim() }) });
      if (!response.ok) throw new Error(); const data = obj(await response.json());
      setAnswer(String(data.answer ?? data.response ?? 'No answer returned.')); setCitations(Array.isArray(data.citations) ? data.citations.map((c) => typeof c === 'string' ? c : String(obj(c).title ?? obj(c).source ?? obj(c).id ?? 'Source')) : []);
    } catch { setAnswer('Notebook query service is unavailable. Connect the research query endpoint to ask questions across this notebook’s sources.'); }
    finally { setAsking(false); }
  };
  const chooseView = (next: Destination) => setView(next);

  return <div className="xos-shell">
    <aside className="xos-sidebar">
      <div className="xos-logo"><span>X</span><div><b>XYP3RN</b><small>AGENTIC OS</small></div><i className="xos-online" /></div>
      <button className="xos-command"><span>⌕</span><span>Quick command…</span><kbd>⌘ K</kbd></button>
      <nav className="xos-navigation">{nav.map((section) => <div className="xos-nav-section" key={section.group}><small>{section.group}</small>{section.items.map((item) => <button className={`xos-nav-item ${view === item.id ? 'is-active' : ''}`} key={item.id} onClick={() => chooseView(item.id)}><i>{item.icon}</i><span>{item.label}</span>{item.id === 'obsidian' && <b className="xos-nav-badge">{obsidianFiles.length || '—'}</b>}</button>)}</div>)}</nav>
      <div className="xos-sidebar-bottom"><button className="xos-import-link" onClick={() => startImport('knowledge')}><span>＋</span> Import to Knowledge</button><div className="xos-profile"><div className="xos-avatar">X</div><div><b>X3LIUS</b><small>OWNER / ADMIN</small></div><span>···</span></div></div>
    </aside>
    <main className="xos-main">
      {view === 'research' && <section className="xos-page xos-research-page">
        <header className="xos-page-header"><div><div className="xos-breadcrumb">RESEARCH <i>/</i> NOTEBOOK LLM</div><h1>Research Workspace</h1><p>Ask across curated sources, retain citations, and turn findings into reusable knowledge.</p></div><button className="xos-primary-button" onClick={() => setNewNotebook(true)}>＋ New notebook</button></header>
        <div className="xos-research-layout">
          <aside className="xos-notebook-rail"><div className="xos-rail-heading"><b>NOTEBOOKS</b><button title="New notebook" onClick={() => setNewNotebook(true)}>＋</button></div>
            {notebooksState === 'loading' && <div className="xos-empty-inline">Loading notebooks…</div>}
            {notebooksState === 'offline' && <div className="xos-empty-inline">Research service not connected.<small>Connect /api/v1/research/notebooks to load your workspaces.</small></div>}
            {notebooks.map((notebook) => <button key={notebook.id} className={`xos-notebook-item ${activeNotebookRecord?.id === notebook.id ? 'is-selected' : ''}`} onClick={() => setActiveNotebook(notebook.id)}><i>◫</i><span><b>{notebook.name}</b><small>{notebook.sourceCount ?? 0} sources · {niceDate(notebook.updatedAt)}</small></span></button>)}
            {notebooksState === 'ready' && !notebooks.length && <div className="xos-empty-inline">Your research notebooks will appear here.<button onClick={() => setNewNotebook(true)}>Create your first notebook</button></div>}
            <div className="xos-rail-storage"><span>KNOWLEDGE SOURCES</span><b>{obsidianFiles.length + 0} <small>Obsidian files</small></b><button onClick={() => chooseView('obsidian')}>Browse folder ↗</button></div>
          </aside>
          <div className="xos-notebook-content">
            <div className="xos-notebook-top"><div><small>ACTIVE NOTEBOOK</small><h2>{activeNotebookRecord?.name || 'Choose a notebook'}</h2><span>{activeNotebookRecord?.description || 'Grounded research with source-linked answers.'}</span></div><button className="xos-outline-button" onClick={() => startImport('knowledge')}>＋ Add sources</button></div>
            <div className="xos-source-strip"><div className="xos-source-heading"><span>NOTEBOOK SOURCES</span><button onClick={() => startImport('notebook')}>MANAGE SOURCES ↗</button></div>
              {activeNotebookRecord?.sources?.length ? <div className="xos-source-cards">{activeNotebookRecord.sources.slice(0, 3).map((source) => <div className="xos-source-card" key={source.id}><i>▤</i><span><b>{source.name}</b><small>{source.path || 'Linked source material'}</small></span><em>READY</em></div>)}</div> : activeNotebookRecord?.sourceCount ? <div className="xos-source-count"><b>{activeNotebookRecord.sourceCount}</b><span>indexed sources ready for retrieval</span><button onClick={() => startImport('notebook')}>Add another source</button></div> : <div className="xos-source-empty"><i>▤</i><span><b>Add sources to ground this notebook</b><small>Import documents or connect the Obsidian folder. Answers can cite their source material.</small></span><button onClick={() => startImport('notebook')}>Import files</button></div>}
            </div>
            <div className="xos-ask-card"><div className="xos-ask-heading"><div><span className="xos-ai-mark">✳</span><span><b>NOTEBOOK LLM</b><small>RESEARCH ASSISTANT · SOURCE GROUNDED</small></span></div><div className="xos-model-pill"><i /> READY</div></div>
              {answer && <div className="xos-answer"><div className="xos-answer-kicker">RESPONSE</div><p>{answer}</p>{citations.length > 0 && <div className="xos-citations"><small>SOURCES</small>{citations.map((citation, i) => <span key={`${citation}-${i}`}>{String(i + 1).padStart(2, '0')} · {citation}</span>)}</div>}</div>}
              <form className="xos-ask-form" onSubmit={askNotebook}><textarea value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question across this notebook’s sources…" disabled={!activeNotebookRecord} /><div><span>Answers stay tied to source evidence</span><button disabled={asking || !question.trim() || !activeNotebookRecord}>{asking ? 'RETRIEVING…' : 'ASK NOTEBOOK'}<b>↗</b></button></div></form>
              {!activeNotebookRecord && notebooksState === 'ready' && <div className="xos-ask-hint">Create a notebook, then add sources to start a grounded research session.</div>}
            </div>
            <div className="xos-research-lower"><div className="xos-mini-card"><small>RECENT RESEARCH</small><b>{activeNotebookRecord?.status || 'No session yet'}</b><span>Research runs and saved findings will appear here.</span></div><div className="xos-mini-card"><small>KNOWLEDGE DESTINATION</small><b>Obsidian Folder</b><span>Approved findings can be saved back into your knowledge library.</span><button onClick={() => chooseView('obsidian')}>Open Obsidian ↗</button></div></div>
          </div>
        </div>
      </section>}

      {view === 'obsidian' && <section className="xos-page"><header className="xos-page-header"><div><div className="xos-breadcrumb">KNOWLEDGE <i>/</i> OBSIDIAN FOLDER</div><h1>Obsidian Knowledge</h1><p>Bring your vault into the XYP3RN knowledge layer and keep its folder paths intact.</p></div><div className="xos-header-actions"><button className="xos-outline-button" onClick={() => { setImportTarget('obsidian'); setFolderMode(true); setShowImport(true); folderInputRef.current?.click(); }}>▤ Connect folder</button><button className="xos-primary-button" onClick={() => startImport('obsidian')}>＋ Import files</button></div></header>
        <div className="xos-folder-banner"><div className="xos-folder-icon">▤</div><div><small>OBSIDIAN SOURCE</small><b>Obsidian Folder</b><span>{obsidianState === 'ready' ? `${obsidianFiles.length} indexed files` : obsidianState === 'loading' ? 'Checking source…' : 'Folder source not connected'}</span></div><div className="xos-sync-state"><i className={obsidianState === 'ready' ? 'is-live' : ''} />{obsidianState === 'ready' ? 'SOURCE READY' : 'NOT CONNECTED'}</div></div>
        <div className="xos-files-panel"><div className="xos-files-heading"><div><b>Folder contents</b><small>Markdown notes and supported files</small></div><div><button className="xos-outline-button" onClick={() => startImport('obsidian')}>＋ Add files</button><button className="xos-icon-button" title="Refresh" onClick={() => fetch(endpoint.obsidian).then((r) => r.json()).then((d) => setObsidianFiles(arrayFrom<SourceFile>(d, 'files'))).catch(() => setObsidianState('offline'))}>↻</button></div></div>
          {obsidianState === 'offline' && <div className="xos-file-empty"><span>⌁</span><b>Connect an Obsidian folder to begin</b><p>Choose a local vault folder or import selected notes. Files are sent to the knowledge import service with their relative paths.</p><button className="xos-primary-button" onClick={() => { setImportTarget('obsidian'); setFolderMode(true); setShowImport(true); folderInputRef.current?.click(); }}>Choose folder</button></div>}
          {obsidianState === 'ready' && !obsidianFiles.length && <div className="xos-file-empty"><span>▤</span><b>The folder is ready for your notes</b><p>Import Markdown notes and supporting documents to make them available to research and retrieval.</p><button className="xos-primary-button" onClick={() => startImport('obsidian')}>Import notes</button></div>}
          {!!obsidianFiles.length && <div className="xos-file-list">{obsidianFiles.map((file) => <div className="xos-file-row" key={file.id}><span className="xos-file-type">{(file.kind || file.name.split('.').pop() || 'MD').slice(0, 3).toUpperCase()}</span><div><b>{file.name}</b><small>{file.path || 'Obsidian Folder'} · {niceDate(file.updatedAt)}</small></div><span>{sizeLabel(file.size)}</span><button aria-label={`Open ${file.name}`}>↗</button></div>)}</div>}
        </div>
      </section>}

      {view === 'records' && <section className="xos-page xos-records-page"><header className="xos-page-header"><div><div className="xos-breadcrumb">RECORDS <i>/</i> AUDIO LIBRARY</div><h1>Track Library</h1><p>Play recent releases and compare demos as each track moves toward release.</p></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="xos-outline-button" onClick={() => startImport('lyrics')}>＋ Lyrics</button><button className="xos-outline-button" onClick={() => startImport('metadata')}>＋ Metadata</button><button className="xos-primary-button" onClick={() => startImport('audio')}>＋ Add audio</button></div></header>
        <div className="xos-records-layout"><div className="xos-player-panel"><div className="xos-player-art"><div className="xos-art-ring xos-art-ring-one"/><div className="xos-art-ring xos-art-ring-two"/><div className="xos-art-core">X<span>3</span></div><small>{activeTrack?.type === 'demo' ? 'DEMO / WORKING CUT' : 'XYP3RN RECORDS'}</small></div>
            <div className="xos-player-info"><small>NOW SELECTED <i>/</i> {activeTrack?.type?.toUpperCase() || 'TRACK'}</small><h2>{activeTrack?.title || 'Select a track'}</h2><p>{activeTrack?.releaseName || activeTrack?.artist || 'Audio playback and version comparison'}</p>
              {activeTrack?.audioUrl ? <AudioDeck src={activeTrack.audioUrl} title={activeTrack.title} /> : <div className="xos-audio-empty">{tracksState === 'offline' ? 'Track service is not connected.' : tracks.length ? 'Audio file is not attached to this track.' : 'Latest tracks and demos will appear here when the Records endpoint is connected.'}</div>}
              {activeTrack?.type === 'demo' && (activeTrack.progress || activeTrack.progressPercent != null) && <div className="xos-demo-progress"><span>RELEASE READINESS</span><b>{activeTrack.progress || `${activeTrack.progressPercent}% COMPLETE`}</b>{activeTrack.progressPercent != null && <i><em style={{ width: `${Math.max(0, Math.min(100, activeTrack.progressPercent))}%` }} /></i>}</div>}
            </div>
          </div>
          <div className="xos-track-panel"><div className="xos-track-panel-head"><div><small>YOUR CATALOG</small><b>Latest &amp; Demos</b></div><div className="xos-track-tabs">{(['all', 'release', 'demo'] as const).map((filter) => <button key={filter} className={trackFilter === filter ? 'is-active' : ''} onClick={() => setTrackFilter(filter)}>{filter === 'all' ? 'ALL' : filter === 'release' ? 'LATEST' : 'DEMOS'}</button>)}</div></div>
            {tracksState === 'loading' && <div className="xos-file-empty">Loading audio catalog…</div>}
            {tracksState === 'offline' && <div className="xos-file-empty"><span>♫</span><b>Records service not connected</b><p>Connect `/api/v1/records/tracks` to list audio URLs for releases and demos.</p><button className="xos-outline-button" onClick={() => startImport('audio')}>Add audio</button></div>}
            {tracksState === 'ready' && !filteredTracks.length && <div className="xos-file-empty"><span>♫</span><b>No {trackFilter === 'all' ? 'tracks' : `${trackFilter}s`} yet</b><p>Add released tracks or work-in-progress demos to compare their progress here.</p><button className="xos-primary-button" onClick={() => startImport('audio')}>Add audio</button></div>}
            {filteredTracks.map((track, index) => <button key={track.id} className={`xos-track-row ${activeTrack?.id === track.id ? 'is-playing' : ''}`} onClick={() => setActiveTrack(track)}><span className="xos-track-index">{activeTrack?.id === track.id ? '▶' : String(index + 1).padStart(2, '0')}</span><span className="xos-track-cover">{track.coverUrl ? <img src={track.coverUrl} alt="" /> : 'X'}</span><span className="xos-track-meta"><b>{track.title}</b><small>{track.releaseName || (track.type === 'demo' ? 'Work in progress' : 'Latest release')} · {niceDate(track.updatedAt)}</small></span><span className={`xos-track-kind xos-track-kind--${track.type === 'demo' ? 'demo' : 'release'}`}>{track.type === 'demo' ? 'DEMO' : 'RELEASE'}</span><span className="xos-track-duration">{track.duration ? `${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}` : '—'}</span></button>)}
          </div>
        </div>
      </section>}

      {view === 'dispatch' && <section className="xos-embedded-view"><ContextDispatchPipeline /></section>}
      {view === 'knowledge-graph' && <section className="xos-embedded-view"><KnowledgeGraphExplorer /></section>}
      {view === 'galaxy' && <section className="xos-embedded-view"><GalaxyMapCanvas /></section>}
    </main>

    {showImport && <div className="xos-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !importing) setShowImport(false); }}><section className="xos-import-modal"><header><div><small>KNOWLEDGE INGESTION</small><h2>{importTarget === 'lyrics' ? 'Import lyrics' : importTarget === 'metadata' ? 'Import track metadata' : importTarget === 'audio' ? 'Add audio to Records' : importTarget === 'obsidian' ? 'Import to Obsidian Folder' : importTarget === 'notebook' ? `Add sources to ${activeNotebookRecord?.name || 'notebook'}` : 'Import to Knowledge'}</h2><p>{importTarget === 'audio' ? 'Add a release or a demo track to your audio library.' : 'Files become searchable sources for Notebook LLM and context retrieval.'}</p></div><button onClick={() => setShowImport(false)} disabled={importing}>×</button></header>
        <div className="xos-import-dest"><span>DESTINATION</span><b>{importTarget === 'lyrics' ? `Records / Lyrics · ${storage.lyrics || 'Documents/XYP3RN Records/lyrics'}` : importTarget === 'metadata' ? `Records / Metadata · ${storage.metadata || 'Documents/XYP3RN Records/metadata'}` : importTarget === 'audio' ? 'Records / Track Library · Creative Vault' : importTarget === 'obsidian' ? 'Knowledge / Obsidian Folder' : importTarget === 'notebook' ? `Research / ${activeNotebookRecord?.name || 'Notebook'} / Sources` : 'Knowledge / Imported Sources'}</b></div>
        {importTarget === 'lyrics' && <div className="xos-audio-import-meta"><select value={lyricsLanguage} onChange={(e) => setLyricsLanguage(e.target.value)} aria-label="Lyrics language"><option value="en">English</option><option value="bg">Bulgarian</option><option value="mixed">Mixed</option></select></div>}
        {importTarget === 'audio' && <div className="xos-audio-import-meta"><input value={audioTitle} onChange={(e) => setAudioTitle(e.target.value)} placeholder="Track title" aria-label="Track title" /><select value={audioKind} onChange={(e) => setAudioKind(e.target.value as 'release' | 'demo')} aria-label="Track type"><option value="demo">Demo</option><option value="release">Release</option></select></div>}
        <button className="xos-dropzone" onClick={() => fileInputRef.current?.click()} onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setSelectedFiles((files) => [...files, ...Array.from(e.dataTransfer.files)]); }}><span>＋</span><b>Choose files or drop them here</b><small>{importTarget === 'audio' ? 'WAV, MP3, M4A, FLAC, AIFF, OGG · up to 100 MB each' : importTarget === 'lyrics' ? 'TXT or Markdown lyric sheets · up to 100 MB each' : importTarget === 'metadata' ? 'JSON, CSV, YAML, XML, TXT, MD, PDF, DOCX · up to 100 MB each' : 'Markdown, PDF, DOCX, TXT, audio, and more'}</small></button>
        {folderMode && <button className="xos-folder-picker" onClick={() => folderInputRef.current?.click()}>▤ Choose an Obsidian vault folder</button>}
        {selectedFiles.length > 0 && <div className="xos-selected-files"><small>SELECTED · {selectedFiles.length}</small>{selectedFiles.slice(0, 5).map((file, i) => <span key={`${file.name}-${i}`}>{(file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name}<i>{sizeLabel(file.size)}</i></span>)}{selectedFiles.length > 5 && <em>+ {selectedFiles.length - 5} more files</em>}</div>}
        {importMessage && <div className={`xos-import-message ${importMessage.includes('failed') || importMessage.includes('unavailable') ? 'is-error' : ''}`}>{importMessage}</div>}
        <footer><button className="xos-outline-button" disabled={importing} onClick={() => setShowImport(false)}>Cancel</button><button className="xos-primary-button" disabled={importing || !selectedFiles.length || (importTarget === 'audio' && !audioTitle.trim())} onClick={submitImport}>{importing ? 'IMPORTING…' : `Import ${selectedFiles.length || ''} ${selectedFiles.length === 1 ? 'file' : 'files'}`}</button></footer>
      </section></div>}
    <input ref={fileInputRef} className="xos-hidden-input" type="file" multiple accept={importTarget === 'audio' ? '.wav,.mp3,.flac,.m4a,.aiff,.ogg' : importTarget === 'lyrics' ? '.txt,.md' : importTarget === 'metadata' ? '.json,.csv,.yaml,.yml,.xml,.txt,.md,.pdf,.docx' : undefined} onChange={(e) => setSelectedFiles((files) => [...files, ...Array.from(e.target.files || [])])} />
    <input ref={folderInputRef} className="xos-hidden-input" type="file" multiple onChange={(e) => { setSelectedFiles(Array.from(e.target.files || [])); setImportTarget('obsidian'); setFolderMode(true); }} />
    {newNotebook && <div className="xos-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setNewNotebook(false); }}><form className="xos-new-notebook-modal" onSubmit={createNotebook}><button type="button" className="xos-modal-close" onClick={() => setNewNotebook(false)}>×</button><small>RESEARCH WORKSPACE</small><h2>Create a notebook</h2><p>Group source material around one investigation, topic, or project.</p><input autoFocus value={notebookName} onChange={(e) => setNotebookName(e.target.value)} placeholder="Notebook name" /><footer><button type="button" className="xos-outline-button" onClick={() => setNewNotebook(false)}>Cancel</button><button className="xos-primary-button" disabled={!notebookName.trim()}>Create notebook</button></footer></form></div>}
  </div>;
}

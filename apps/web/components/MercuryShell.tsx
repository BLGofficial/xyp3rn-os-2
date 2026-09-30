'use client';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { DOMAIN_META, DOMAINS, type Domain } from '../../../core/contracts/taxonomy';
import { radialLayout } from '../lib/layout';
import { speechChunks, speechText } from '../lib/speech-text';
import { SKILLS } from '../lib/skills';
import type { GraphNode, Projection } from '../lib/types';

const NAV=['Graph','Agents','Workflows','Knowledge','Research','Records','Tech','Governance'];
const MAP=[['graph','Graph View','◎'],['list','List View','☷'],['mesh','Agent Mesh','⌘'],['flow','Workflow Flow','◇'],['knowledge-graph','Knowledge Graph','▱'],['resources','Resource Monitor','◉'],['events','Live Events','▤']];
const INFRA=[['connectors','APIs & Connectors','⌁'],['pipeline','Data Pipeline','▱'],['security','Security Layer','⬡'],['infrastructure','Scalable Infrastructure','▰'],['deployment','Global Deployment','◎']];
const DOMAIN_ICONS:Record<Domain,string>={CORE:'◇',KNOWLEDGE:'▱',RESEARCH_INTELLIGENCE:'⌘',RECORDS:'♫',TECH:'⚙',GOVERNANCE:'⬡'};
const words=(value:string)=>value.replaceAll('_',' ').replaceAll('-',' ');
const domainOf=(value:string|null):Domain|undefined=> value==='research'?'RESEARCH_INTELLIGENCE':DOMAINS.find(d=>d.toLowerCase()===value);
const validViews=new Set([...NAV.map(v=>v.toLowerCase()),...MAP.map(v=>v[0])]);
const headings:Record<Domain,{x:number;y:number}>={CORE:{x:0,y:-362},KNOWLEDGE:{x:287,y:-248},GOVERNANCE:{x:287,y:274},RECORDS:{x:0,y:315},TECH:{x:-287,y:274},RESEARCH_INTELLIGENCE:{x:-287,y:-248}};

function BrandMark(){return <svg viewBox="0 0 80 80" aria-hidden="true"><path d="M8 8h24L19 21l21 20 21-20L48 8h24v24L59 19 39 40l20 21 13-13v24H48l13-13-21-20-21 20 13 13H8V48l13 13 20-21-20-21L8 32Z" fill="none" stroke="currentColor" strokeWidth="5"/></svg>;}

const MercurySystemGraph=memo(function MercurySystemGraph({nodes,selected,enabled,focus,onSelect,onFocus,onExpand,onNavigate}:{nodes:GraphNode[];selected:string;enabled:Domain[];focus:Domain|undefined;onSelect:(id:string)=>void;onFocus:(d:Domain)=>void;onExpand:(d:Domain)=>void;onNavigate:(d:Domain)=>void}){
  const layout=useMemo(()=>radialLayout(nodes),[nodes]);
  const [hover,setHover]=useState('');
  return <svg className="system-graph" viewBox="-440 -398 880 790" role="group" aria-label="Interactive radial system architecture" onKeyDown={event=>{
    if(!['ArrowRight','ArrowLeft','ArrowDown','ArrowUp'].includes(event.key))return;event.preventDefault();const items=Array.from(event.currentTarget.querySelectorAll<SVGGElement>('[data-node]'));const index=items.indexOf(event.target as SVGGElement);items[(index+(event.key==='ArrowRight'||event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();
  }}>
    <defs><radialGradient id="space"><stop offset="0" stopColor="#142a39" stopOpacity=".45"/><stop offset="1" stopColor="#020810" stopOpacity="0"/></radialGradient><radialGradient id="hub"><stop stopColor="#362814"/><stop offset=".75" stopColor="#080e13"/><stop offset="1" stopColor="#715423"/></radialGradient><filter id="bloom" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="4"/></filter><pattern id="microgrid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#153246" strokeWidth=".3"/></pattern></defs>
    <circle r="386" fill="url(#space)"/><rect x="-435" y="-390" width="870" height="780" fill="url(#microgrid)" opacity=".6"/>
    <g className="orbit-guides" aria-hidden="true">{[113,134,148,240,320,363,371].map((r,i)=><circle key={r} r={r} fill="none" stroke={i<3?'#be9750':'#247da1'} strokeWidth={i===6?1.4:.55} opacity={i<3?.4:.4} strokeDasharray={i%2?'3 9':undefined}/>)}
      {Array.from({length:72},(_,i)=>{const a=i*Math.PI/36;return <line key={i} x1={Math.cos(a)*365} y1={Math.sin(a)*365} x2={Math.cos(a)*(i%6===0?379:371)} y2={Math.sin(a)*(i%6===0?379:371)} stroke="#78b6cb" strokeWidth=".6" opacity=".45"/>;})}
      {Array.from({length:48},(_,i)=>{const a=i*2.39996;const r=170+(i*37)%192;return <circle key={i} cx={Math.cos(a)*r} cy={Math.sin(a)*r} r={i%7===0?1.8:.7} fill={i%3?'#59bee4':'#d4ae64'} opacity=".6"/>;})}
    </g>
    {layout.filter(d=>enabled.includes(d.domain)).map(d=>{const color=DOMAIN_META[d.domain].color;const title=headings[d.domain];return <g key={d.domain} className={focus&&focus!==d.domain?'domain-group dimmed':'domain-group'} style={{'--node-color':color} as CSSProperties}>
      <line x1="0" y1="0" x2={d.center.x} y2={d.center.y} stroke={color} opacity=".35" strokeWidth="1"/>
      <circle cx={d.center.x} cy={d.center.y} r="83" fill="none" stroke={color} strokeWidth=".6" opacity=".35"/>
      {d.satellites.map(({node,x,y})=><g key={node.id}>
        <line x1={d.center.x} y1={d.center.y} x2={x} y2={y} stroke={color} opacity={hover===node.id?1:.4} strokeWidth={hover===node.id?1.8:.6}/>
        <g data-node={node.id} role="button" tabIndex={0} aria-label={`${node.label}, ${node.status}`} className={`satellite ${selected===node.id?'selected':''}`} onMouseEnter={()=>setHover(node.id)} onMouseLeave={()=>setHover('')} onFocus={()=>setHover(node.id)} onBlur={()=>setHover('')} onClick={()=>onSelect(node.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect(node.id);}}}>
          <title>{node.label} · {node.status}</title><circle cx={x} cy={y} r="10" fill={color} opacity=".3" filter="url(#bloom)"/><circle cx={x} cy={y} r="5" fill="#07121b" stroke={color} strokeWidth="1.8"/><circle className="selection-ring" cx={x} cy={y} r="10" fill="none" stroke={color}/>
          <text x={x} y={y-12} textAnchor="middle" className="satellite-label">{node.label.length>24?node.label.slice(0,22)+'…':node.label}</text>
        </g></g>)}
      <g data-node={`domain:${d.domain}`} role="button" tabIndex={0} aria-label={`Focus ${DOMAIN_META[d.domain].label}`} onClick={()=>{onFocus(d.domain);onSelect(`domain:${d.domain}`);}} onDoubleClick={()=>onNavigate(d.domain)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onFocus(d.domain);onSelect(`domain:${d.domain}`);}}} className="domain-node">
        <circle cx={d.center.x} cy={d.center.y} r="35" fill={color} opacity=".35" filter="url(#bloom)"/><circle cx={d.center.x} cy={d.center.y} r="30" fill="#04101a" stroke={color} strokeWidth="1.8"/><circle cx={d.center.x} cy={d.center.y} r="24" fill="none" stroke={color} opacity=".35"/>
        <text x={d.center.x} y={d.center.y+9} textAnchor="middle" fill={color} fontSize="29">{DOMAIN_ICONS[d.domain]}</text>
      </g>
      <text x={title.x} y={title.y} textAnchor="middle" className="domain-title" fill={color}>{DOMAIN_META[d.domain].label.toUpperCase()}</text>
      <text x={title.x} y={title.y+17} textAnchor="middle" className="domain-subtitle">{d.total} REGISTERED ENTITIES</text>
      {d.overflow.length>0&&<g role="button" tabIndex={0} aria-label={`Expand ${d.overflow.length} more ${DOMAIN_META[d.domain].label} entities`} className="overflow-node" transform={`translate(${d.center.x},${d.center.y+49})`} onClick={()=>onExpand(d.domain)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onExpand(d.domain);}}}><rect x="-39" y="-11" width="78" height="21" rx="3" fill="#0a1520" stroke={color} opacity=".9"/><text textAnchor="middle" y="3" fill={color}>+{d.overflow.length} MORE</text></g>}
    </g>;})}
    <g data-node="hub:xyp3rn" role="button" tabIndex={0} aria-label="Inspect XYP3RN system" onClick={()=>onSelect('hub:xyp3rn')} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect('hub:xyp3rn');}}} className="central-hub">
      <circle r="109" fill="#d4a34d" opacity=".1" filter="url(#bloom)"/><circle r="103" fill="url(#hub)" stroke="#c49a4c" strokeWidth="1.3"/><circle r="96" fill="none" stroke="#c49a4c" opacity=".35"/>
      <g transform="translate(-42,-62) scale(1.05)" color="#ffda80"><path d="M8 8h24L19 21l21 20 21-20L48 8h24v24L59 19 39 40l20 21 13-13v24H48l13-13-21-20-21 20 13 13H8V48l13 13 20-21-20-21L8 32Z" fill="none" stroke="currentColor" strokeWidth="5"/></g>
      <text y="45" textAnchor="middle" className="hub-name">XYP3RN</text><text y="66" textAnchor="middle" className="hub-caption">AGENTIC OS</text><text y="85" textAnchor="middle" className="hub-micro">MERCURY COMMAND CENTER</text>
    </g>
  </svg>;
});

export function MercuryShell(){
  const [data,setData]=useState<Projection|null>(null);const [login,setLogin]=useState(false);const [token,setToken]=useState('');const [message,setMessage]=useState('');const [view,setView]=useState('graph');const [selected,setSelected]=useState('');const [focus,setFocus]=useState<Domain>();const [enabled,setEnabled]=useState<Domain[]>([...DOMAINS]);const [search,setSearch]=useState('');const [leftOpen,setLeftOpen]=useState(false);const [rightOpen,setRightOpen]=useState(false);const [busy,setBusy]=useState(false);const [reason,setReason]=useState('');
  const refresh=useCallback(async(signal?:AbortSignal)=>{try{const response=await fetch('/api/projection',{signal,cache:'no-store'});if(response.status===401){setLogin(true);setData(null);return;}if(!response.ok)throw new Error('Runtime unavailable');const next=await response.json() as Projection;setData(previous=>previous&&JSON.stringify(previous.nodes)===JSON.stringify(next.nodes)?{...next,nodes:previous.nodes}:next);setLogin(false);}catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))setMessage('Connection unavailable. Last received snapshot may be stale.');}},[]);
  useEffect(()=>{const controller=new AbortController();void refresh(controller.signal);let pending=false;const timer=setInterval(()=>{if(document.hidden||pending)return;pending=true;void refresh(controller.signal).finally(()=>{pending=false;});},10000);return()=>{controller.abort();clearInterval(timer);};},[refresh]);
  useEffect(()=>{const restore=()=>{const q=new URLSearchParams(location.search);setView(validViews.has(q.get('view')??'')?q.get('view')!:'graph');setSelected(q.get('node')??'');setFocus(domainOf(q.get('domain')));};restore();window.addEventListener('popstate',restore);return()=>window.removeEventListener('popstate',restore);},[]);
  const navigate=useCallback((nextView:string,nextDomain?:Domain,nextNode='')=>{setView(nextView);setFocus(nextDomain);setSelected(nextNode);setSearch('');const q=new URLSearchParams({view:nextView});if(nextDomain)q.set('domain',nextDomain.toLowerCase());if(nextNode)q.set('node',nextNode);history.pushState(null,'',`?${q}`);setLeftOpen(false);},[]);
  const select=useCallback((id:string)=>{setSelected(id);setReason('');const q=new URLSearchParams(location.search);q.set('node',id);history.replaceState(null,'',`?${q}`);},[]);
  const close=()=>{setSelected('');const q=new URLSearchParams(location.search);q.delete('node');history.replaceState(null,'',`?${q}`);};
  useEffect(()=>{const keys=(e:KeyboardEvent)=>{if(e.key==='Escape'){setSelected('');setSearch('');setLeftOpen(false);setRightOpen(false);}if(e.key==='/'&&!(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLTextAreaElement)){e.preventDefault();document.getElementById('global-search')?.focus();}};window.addEventListener('keydown',keys);return()=>window.removeEventListener('keydown',keys);},[]);
  const post=async(path:string,input:unknown)=>{const response=await fetch(`/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};
  const signIn=async(e:FormEvent)=>{e.preventDefault();setBusy(true);try{await post('session',{token});setToken('');setMessage('');await refresh();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  const runHealth=async()=>{setBusy(true);try{const r=await post('health-check',{});setMessage(`Runtime check ${r.status} · ${r.runId}`);await refresh();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  const decide=async(decision:string)=>{setBusy(true);try{const r=await post('approvals',{id:current?.entityId,decision,reason});setMessage(r.nextAction??`Decision ${r.status}`);setReason('');await refresh();}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}};
  const current=data?.nodes.find(n=>n.id===selected);
  const results=search.trim()?data?.nodes.filter(n=>n.kind==='satellite'&&`${n.label} ${n.entityType}`.toLowerCase().includes(search.trim().toLowerCase())).slice(0,10)??[]:[];
  const agents=data?.nodes.filter(n=>n.entityType==='agent')??[];
  const filtered=useMemo(()=>{if(!data)return[];const type:Record<string,string>={agents:'agent',workflows:'workflow',knowledge:'knowledge',research:'research',records:'record',tech:'tech',governance:'approval'};
    return data.nodes.filter(n=>n.kind==='satellite'&&enabled.includes(n.domain)&&(!focus||n.domain===focus)&&(view==='resources'?['provider','infrastructure'].includes(n.entityType):view==='mesh'?n.entityType==='agent':view==='flow'?n.entityType==='workflow':view==='knowledge-graph'?n.entityType==='knowledge':view==='tech'?n.domain==='TECH':view==='governance'?n.domain==='GOVERNANCE':type[view]?n.entityType===type[view]:true));},[data,view,enabled,focus]);
  const visibleGraphNodes=useMemo(()=>!data?[]:view==='mesh'?data.nodes.filter(n=>n.kind!=='satellite'||n.entityType==='agent'):view==='flow'?data.nodes.filter(n=>n.kind!=='satellite'||['workflow','agent'].includes(n.entityType)):view==='knowledge-graph'?data.nodes.filter(n=>n.kind!=='satellite'||n.entityType==='knowledge'):data.nodes,[data?.nodes,view]);
  if(login)return <main className="login-screen"><div className="login-card panel-frame"><div className="login-mark"><BrandMark/></div><p className="eyebrow">MERCURY EDITION</p><h1>XYP3RN <span>AGENTIC OS</span></h1><p className="muted">Your operating system. One traceable view.</p><form onSubmit={signIn}><label htmlFor="session-token">Operator-issued session token</label><input id="session-token" type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)} required/><button className="gold-button" disabled={busy}>{busy?'Authenticating…':'Enter command center'}</button></form><p role="status">{message}</p><p className="login-note">Access follows your assigned role. Session tokens expire automatically.</p></div></main>;
  if(!data)return <main className="loading"><BrandMark/><p>Connecting to XYP3RN</p><p role="status">{message}</p><button onClick={()=>void refresh()}>Retry connection</button></main>;
  const metrics=[['Agents running',data.status.agentsOnline,` / ${data.status.agentsTotal.value}`],['Workflows active',data.status.workflowsActive,''],['Knowledge nodes',data.status.knowledgeNodes,''],['Research projects',data.status.researchTasksOpen,''],['Records projects',data.status.recordsProjectsOpen,''],['APIs configured',data.status.apiConnections,''],['Uptime',data.status.uptimePercent,'%']] as const;
  const graphView=['graph','mesh','flow','knowledge-graph'].includes(view);
  return <main className="mercury-shell" style={Object.fromEntries(DOMAINS.map(d=>[`--domain-${d.toLowerCase()}`,DOMAIN_META[d].color])) as CSSProperties}>
    <a className="skip-link" href="#workspace">Skip to workspace</a>
    <header className="top-command"><a className="brand panel-frame" href="?view=graph" aria-label="XYP3RN home"><BrandMark/><div><strong>XYP3RN</strong><span>AGENTIC OS <small>v{data.version}</small></span><em>MERCURY EDITION</em></div></a>
      <nav className="top-nav" aria-label="Domains">{NAV.map(n=><button key={n} className={view===n.toLowerCase()?'active-tab':''} aria-current={view===n.toLowerCase()?'page':undefined} onClick={()=>navigate(n.toLowerCase())}>{n}</button>)}</nav>
      <div className="search-wrap"><label className="global-search"><span aria-hidden="true">⌕</span><input id="global-search" aria-label="Search system entities" placeholder="Search nodes, agents, workflows…" value={search} onChange={e=>setSearch(e.target.value)}/><kbd>/</kbd></label>{search&&<div className="search-results panel-frame" aria-label="Search results">{results.length?results.map(n=><button key={n.id} onClick={()=>{navigate('graph',n.domain,n.id);}}><span>{n.label}</span><small>{n.entityType}</small></button>):<p>No matching entities</p>}</div>}</div>
      <div className="identity"><span className="identity-symbol">◈</span><div><strong>{data.identity.name}</strong><span>{data.identity.role}</span></div><button title="Sign out" aria-label="Sign out" onClick={async()=>{await post('logout',{});setLogin(true);setData(null);}}>↗</button></div>
    </header>
    <div className="mobile-controls"><button onClick={()=>setLeftOpen(!leftOpen)} aria-expanded={leftOpen}>☷ System controls</button><button onClick={()=>setRightOpen(!rightOpen)} aria-expanded={rightOpen}>◉ Intelligence</button></div>
    <aside className={`left-rail ${leftOpen?'drawer-open':''}`} aria-label="System controls">
      <section className="panel-frame system-map"><h2>System map</h2><nav aria-label="System map">{MAP.map(([id,label,icon])=><button key={id} className={view===id?'selected':''} aria-current={view===id?'page':undefined} onClick={()=>navigate(id!)}><span className="nav-icon" aria-hidden="true">{icon}</span>{label}</button>)}</nav></section>
      <section className="panel-frame filters"><h2>Filter nodes</h2>{data.domains.map(d=><label key={d.id}><input type="checkbox" checked={enabled.includes(d.id)} onChange={()=>setEnabled(enabled.includes(d.id)?enabled.filter(x=>x!==d.id):[...enabled,d.id])}/><span className="domain-dot" style={{background:d.color}}/>{d.label}</label>)}{focus&&<button className="clear-filter" onClick={()=>navigate(view)}>Clear domain focus ×</button>}</section>
      <section className="panel-frame status-list"><h2>Agent state</h2>{['pending','success','error','unknown'].map(s=><div key={s}><i className={`status-dot ${s}`}/><span>{s==='pending'?'Running':s==='unknown'?'Not observed':`Last run ${s}`}</span><b title="Derived from registry and latest 100 agent_runs">{agents.filter(a=>a.status===s).length}</b></div>)}<small>Latest observed runs · no heartbeat</small></section>
      <section className="panel-frame manifesto"><p>A MORE CREATIVE<br/>INTELLIGENT TOMORROW.</p><hr/><small>TECHNOLOGY × MUSIC<br/>KNOWLEDGE × RESEARCH<br/>HUMAN CREATIVITY</small></section>
    </aside>
    <section id="workspace" className="workspace" aria-label="System workspace"><div className="workspace-topline"><span>◈ {graphView?'SYSTEM ARCHITECTURE':words(view).toUpperCase()}</span><span className="snapshot-time">{data.errors.length?'PARTIAL SNAPSHOT':'SOURCE-CONNECTED'} · {new Date(data.generatedAt).toLocaleTimeString()}</span></div>
      {data.errors.length>0&&<p className="error-banner" role="alert">{data.errors.join(' · ')}</p>}
      {graphView?<><div className="graph-viewport"><MercurySystemGraph nodes={visibleGraphNodes} selected={selected} enabled={enabled} focus={focus} onSelect={select} onFocus={setFocus} onExpand={d=>navigate('list',d)} onNavigate={d=>navigate('list',d)}/></div><section className="music-system panel-frame"><h2>X3LIUS MUSIC SYSTEM</h2><div>{data.nodes.filter(n=>n.entityType==='agent'&&n.entityId.startsWith('x3lius-')&&!['x3lius-revision','x3lius-rvc-post'].includes(n.entityId)).map(n=><button key={n.id} onClick={()=>select(n.id)}><span>✦</span>{words(n.entityId.replace('x3lius-',''))}</button>)}</div></section><div className="graph-help"><span>SELECT TO INSPECT · ARROWS TO NAVIGATE</span><button onClick={()=>navigate('graph')}>Reset view ↺</button></div></>:view==='events'?<section className="entity-list"><h1>Live events <small>{data.events.length} latest</small></h1>{data.events.length?data.events.map(e=><article key={e.id} className="event-row"><i className={`status-dot ${e.severity}`}/><div><strong>{e.summary}</strong><code>{e.sourceRef}</code></div><time dateTime={e.timestamp}>{new Date(e.timestamp).toLocaleString()}</time></article>):<Empty message="No recorded activity"/>}</section>:<section className="entity-list"><div className="list-heading"><h1>{focus?DOMAIN_META[focus].label:words(view)}</h1><small>{filtered.length} entities in projection</small></div>{filtered.length?<div className="table-wrap"><table><thead><tr><th>Entity</th><th>Type</th><th>State</th><th>Source</th></tr></thead><tbody>{filtered.map(n=><tr key={n.id}><td><button onClick={()=>select(n.id)}><span className="domain-dot" style={{background:DOMAIN_META[n.domain].color}}/>{n.label}</button></td><td>{n.entityType}</td><td><span className={`state ${n.status}`}>{n.status}</span></td><td><code>{n.sourceRef}</code></td></tr>)}</tbody></table></div>:<Empty message="No matching registered entities"/>}{data.truncated.length>0&&<p className="muted">Projection limited to 200 entries per table: {data.truncated.join(', ')}.</p>}</section>}
      {message&&<div className="toast" role="status">{message}<button aria-label="Dismiss message" onClick={()=>setMessage('')}>×</button></div>}
    </section>
    <aside className={`right-rail ${rightOpen?'drawer-open':''}`} aria-label="Intelligence"><p className="motto">INTELLIGENCE<br/>WORKS FOR CREATORS.<br/><span>X3LIUS</span></p>
      <CommandPanel canRun={data.identity.permissions.includes('runtime.execute')} post={post} onDone={()=>void refresh()}/>
      <section className="panel-frame telemetry"><h2>System status</h2><p className={`health ${data.status.systemHealth.toLowerCase()}`}><i className="status-dot"/>{words(data.status.systemHealth)}</p>{metrics.map(([label,m,suffix])=><div className="metric" key={label} title={`${m.source}\n${m.query}\n${m.generatedAt}${m.note?'\n'+m.note:''}`} data-source={m.source}><span>{label}</span><b>{m.value===null?'—':m.value.toLocaleString()}{m.value!==null?suffix:''}</b></div>)}<p className="telemetry-note">{data.status.systemHealth==='UNKNOWN'?'Full dependency health not measured':'Local runtime evaluation'} · hover values for sources</p>{data.identity.permissions.includes('runtime.execute')&&<button className="run-check" disabled={busy} onClick={()=>void runHealth()}>{busy?'Working…':'Run runtime check ↗'}</button>}</section>
      <section className="panel-frame activity"><h2>Live activity <button onClick={()=>navigate('events')}>View all</button></h2>{data.events.length?data.events.slice(0,5).map(e=><button className="activity-item" key={e.id} onClick={()=>{navigate('events');setMessage(`${e.sourceRef} · ${e.timestamp}`);}}><span className="event-icon" style={{color:DOMAIN_META[e.domain].color}}>{DOMAIN_ICONS[e.domain]}</span><span>{e.summary}<small>{e.source}</small></span><time dateTime={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></button>):<Empty message="No recorded activity"/>}</section>
      <section className="panel-frame global-reach"><h2>Global reach</h2><svg viewBox="0 0 300 125" role="img" aria-label="Geographic analytics not configured"><defs><pattern id="map-dots" width="4" height="4" patternUnits="userSpaceOnUse"><circle r=".75" cx="2" cy="2" fill="#3ca8ca"/></pattern></defs><path d="M20 24 57 12 87 20 97 39 75 52 57 48 48 63 27 45Z M75 67 95 72 101 96 86 120 78 98Z M130 27 151 18 167 27 171 44 153 49 140 41Z M137 51 164 49 183 65 163 99 148 100 132 74Z M171 22 211 13 269 23 278 48 254 58 230 47 223 70 199 60 185 41Z M238 89 262 79 280 100 271 111 241 111Z" fill="url(#map-dots)"/></svg><p>No analytics source configured</p><small>Geographic reach unavailable</small></section>
    </aside>
    <footer className="infrastructure-rail"><div className="footer-brand">XYP3RN AGENTIC OS<br/><span>MERCURY EDITION</span></div>{INFRA.map(([id,label,icon])=><button key={id} onClick={()=>{if(id==='connectors')navigate('resources');else select(`infra:${id}`);}}><span>{icon}</span>{label}</button>)}<span className="footer-caption">BUILT FOR<br/>A HIGHER TOMORROW</span></footer>
    {selected&&<aside className="inspector panel-frame" aria-label="Entity inspector"><header><span>ENTITY INSPECTOR</span><button aria-label="Close inspector" onClick={close}>×</button></header>{current?<><p className="eyebrow" style={{color:DOMAIN_META[current.domain].color}}>{current.entityType} / {DOMAIN_META[current.domain].label}</p><h2>{current.label}</h2><span className={`state ${current.status}`}>{current.status}</span><dl><dt>Source</dt><dd><code>{current.sourceRef}</code></dd><dt>Entity ID</dt><dd><code>{current.entityId}</code></dd></dl>{current.kind==='domain'&&<button className="gold-button" onClick={()=>navigate('list',current.domain)}>Open domain view</button>}{Object.entries(current.metadata).map(([key,value])=><section className="inspector-field" key={key}><h3>{words(key)}</h3>{typeof value==='object'?<pre>{JSON.stringify(value,null,2)}</pre>:<p>{value===null?'Not measured':String(value)}</p>}</section>)}{current.entityType==='approval'&&current.status==='pending'&&data.identity.permissions.includes('approval.decide')&&<form onSubmit={e=>{e.preventDefault();void decide('approve');}}><label htmlFor="decision-reason">Decision reason</label><textarea id="decision-reason" value={reason} onChange={e=>setReason(e.target.value)} required/><div className="decision-buttons"><button className="gold-button" disabled={busy||!reason.trim()}>Approve</button><button type="button" disabled={busy||!reason.trim()} onClick={()=>void decide('reject')}>Reject</button></div></form>}<a className="deep-link" href={current.href}>Open entity deep link ↗</a></>:<Empty message="Entity unavailable or access restricted"/>}</aside>}
  </main>;
}
type AskReply={requestId:string;state:'running'|'done';action:string;route:{status:string;domain?:string};status:string;reply:string;approvalRequired?:boolean;sessionId?:string;
  refs?:{workflowRunId?:string;researchRunId?:string;agentRunIds:string[];artifactIds:string[];approvalIds:string[]}};
const getJson=async(path:string)=>{const r=await fetch(path,{cache:'no-store'});const body=await r.json();if(!r.ok)throw new Error(body.error);return body;};

const stored=(key:string,fallback:string)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const store=(key:string,value:string)=>{try{localStorage.setItem(key,value);}catch{/* per-viewer convenience only */}};

const SPEED_MIN=0.5,SPEED_MAX=2;
const clampSpeed=(v:unknown)=>{const n=Number(v);return Number.isFinite(n)?Math.min(SPEED_MAX,Math.max(SPEED_MIN,Math.round(n*10)/10)):1;};
type SpeechPhase='idle'|'synthesizing'|'playing'|'blocked';
const UNAVAILABLE='Speech unavailable. Text reply is unaffected.';

/**
 * Local Kokoro playback of assistant replies through /api/speech. Chunks play strictly in order
 * (next one synthesized while the current plays); a token discards stale results; every stop,
 * replacement and unmount releases audio elements and object URLs. Never touches agent work.
 */
function useSpeech(){
  const [enabled,setEnabledState]=useState(false);const [voice,setVoiceState]=useState('af_heart');const [voices,setVoices]=useState<string[]>([]);
  const [speed,setSpeedState]=useState(1);const [phase,setPhase]=useState<SpeechPhase>('idle');const [part,setPart]=useState<[number,number]|null>(null);const [notice,setNotice]=useState('');
  const audio=useRef<HTMLAudioElement|null>(null);const urls=useRef(new Set<string>());const token=useRef(0);const pending=useRef<AbortController|null>(null);
  const release=useCallback(()=>{pending.current?.abort();pending.current=null;const a=audio.current;audio.current=null;
    if(a){a.onended=null;a.onerror=null;a.pause();a.removeAttribute('src');a.load();}
    for(const u of urls.current)URL.revokeObjectURL(u);urls.current.clear();},[]);
  // Stop ends synthesis in flight (the abort reaches Kokoro) and playback. It never cancels OS work.
  const stop=useCallback(()=>{token.current++;release();setPhase('idle');setPart(null);},[release]);
  useEffect(()=>{setEnabledState(stored('mercury.speak','off')==='on');setVoiceState(stored('mercury.voice','af_heart'));setSpeedState(clampSpeed(stored('mercury.speed','1')));
    fetch('/api/speech/voices',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then((s:{voices:string[]})=>{setVoices(s.voices);if(!s.voices.length)setNotice('No supported voices are installed in the local Kokoro service.');}).catch(()=>setNotice(UNAVAILABLE));
    fetch('/api/speech/status',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then((s:{ready:boolean})=>{if(!s.ready)setNotice(UNAVAILABLE);}).catch(()=>setNotice(UNAVAILABLE));
    // Esc is an easy Stop speaking: the browser cannot know when Wispr starts recording.
    const esc=(e:KeyboardEvent)=>{if(e.key==='Escape')stop();};window.addEventListener('keydown',esc);
    return()=>{window.removeEventListener('keydown',esc);token.current++;release();};},[release,stop]);
  useEffect(()=>{if(voices.length&&!voices.includes(voice))setVoiceState(voices[0]!);},[voices,voice]);
  const synth=useCallback(async(text:string,signal:AbortSignal)=>{
    const r=await fetch('/api/speech',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,voice,speed,format:'wav'}),signal});
    if(!r.ok)throw new Error(r.status===429?'busy':'unavailable');
    const u=URL.createObjectURL(await r.blob());urls.current.add(u);return u;},[voice,speed]);
  const play=(u:string)=>new Promise<void>((resolve,reject)=>{const a=new Audio(u);audio.current=a;a.onended=()=>resolve();a.onerror=()=>reject(new Error('unavailable'));a.play().catch(reject);});
  const speak=useCallback(async(reply:string)=>{stop();const mine=token.current;setNotice('');
    const chunks=speechChunks(speechText(reply));if(!chunks.length)return;
    const controller=new AbortController();pending.current=controller;
    const fetchChunk=(i:number)=>{const p=synth(chunks[i]!,controller.signal);p.catch(()=>{});return p;};
    try{let next:Promise<string>|null=fetchChunk(0);
      for(let i=0;i<chunks.length;i++){setPart([i+1,chunks.length]);setPhase('synthesizing');
        const u:string=await next!;if(mine!==token.current)return;
        next=i+1<chunks.length?fetchChunk(i+1):null;
        setPhase('playing');await play(u);if(mine!==token.current)return;
        URL.revokeObjectURL(u);urls.current.delete(u);}
      release();setPhase('idle');setPart(null);}
    catch(error){if(mine!==token.current)return;release();setPart(null);
      const name=(error as Error).name,message=(error as Error).message;
      if(name==='NotAllowedError'){setPhase('blocked');setNotice('Your browser blocked audio playback. Press Play reply to hear it.');}
      else{setPhase('idle');setNotice(message==='busy'?'Speech is busy; press Play reply to try again.':UNAVAILABLE);}}},[stop,release,synth]);
  const setEnabled=(on:boolean)=>{setEnabledState(on);store('mercury.speak',on?'on':'off');if(!on)stop();};
  const setVoice=(v:string)=>{setVoiceState(v);store('mercury.voice',v);};
  const setSpeed=(v:unknown)=>{const s=clampSpeed(v);setSpeedState(s);store('mercury.speed',String(s));};
  return {enabled,setEnabled,voice,setVoice,voices,speed,setSpeed,phase,part,notice,speak,stop};
}

/** Request box for typed, pasted or externally dictated text (e.g. Wispr Flow). Only the Send button submits. */
type Entry={id:string;request:string;at:string;view?:AskReply;error?:string};
const HISTORY_KEY='mercury.assistant.history';const HISTORY_MAX=20;
const loadHistory=():Entry[]=>{try{const v:unknown=JSON.parse(sessionStorage.getItem(HISTORY_KEY)??'[]');return Array.isArray(v)?(v as Entry[]).slice(-HISTORY_MAX):[];}catch{return [];}};
const saveHistory=(h:Entry[])=>{try{sessionStorage.setItem(HISTORY_KEY,JSON.stringify(h));}catch{/* history is a per-tab convenience */}};
/** The state shown for an entry, taken only from the server's view (or the transport error). */
const stateOf=(e:Entry):[string,string]=>e.error?['error','Request failed']:!e.view||e.view.state==='running'?['running','Running']
  :e.view.action==='clarify'||e.view.status==='clarify'?['clarify','Needs clarification']:e.view.action==='hold'?['hold','On hold']
  :e.view.status==='cancelled'?['hold','Cancelled']
  :e.view.status==='error'?['error','Failed']:e.view.approvalRequired?['approval','Approval required']
  :(e.view.action==='skill'||e.view.action==='deep')?['success','Finished']:['success','Succeeded'];
const approvalHref=(id:string)=>`?view=graph&domain=governance&node=${encodeURIComponent(`approval_queue:${id}`)}`;

/** Assistant panel: typed, pasted or externally dictated text (e.g. Wispr Flow). Only the Send button submits. */
function CommandPanel({canRun,post,onDone}:{canRun:boolean;post:(path:string,input:unknown)=>Promise<AskReply>;onDone:()=>void}){
  const [text,setText]=useState('');const [busy,setBusy]=useState(false);const [history,setHistory]=useState<Entry[]>([]);const [deep,setDeep]=useState(false);
  const speech=useSpeech();const submission=useRef<{text:string;id:string;mode:string}|null>(null);const inFlight=useRef(false);
  const box=useRef<HTMLTextAreaElement>(null);const sendButton=useRef<HTMLButtonElement>(null);
  const change=useCallback((f:(h:Entry[])=>Entry[])=>setHistory(h=>{const n=f(h).slice(-HISTORY_MAX);saveHistory(n);return n;}),[]);
  const update=useCallback((id:string,patch:Partial<Entry>)=>change(h=>h.map(e=>e.id===id?{...e,...patch}:e)),[change]);
  // Poll the server's run status until it is done; never report completion before the server does.
  const track=useCallback(async(id:string,first?:AskReply)=>{let r=first??await getJson(`/api/ask/${id}`) as AskReply;
    while(r.state==='running'){update(id,{view:r,error:undefined});await new Promise(res=>setTimeout(res,2000));r=await getJson(`/api/ask/${id}`) as AskReply;}
    update(id,{view:r,error:undefined});return r;},[update]);
  useEffect(()=>{const restored=loadHistory();setHistory(restored);
    for(const e of restored)if(!e.error&&e.view?.state==='running')track(e.id).catch(()=>update(e.id,{error:'Run status is no longer available (the server may have restarted). Check Live Events.'}));},[track,update]);
  const send=async(e:FormEvent|null,skill?:string)=>{e?.preventDefault();
    // Ref guard: a double click lands before React re-renders the disabled button.
    if(inFlight.current||!text.trim())return;inFlight.current=true;setBusy(true);
    const sent=text;const wasDeep=deep&&!skill;
    // One request id per submitted text and mode: re-sending after a failure dedupes on the server instead of running twice; a different button is a new request.
    const mode=`${skill??''}|${deep}`;if(submission.current?.text!==sent||submission.current.mode!==mode)submission.current={text:sent,id:crypto.randomUUID(),mode};const id=submission.current.id;
    change(h=>h.some(x=>x.id===id)?h.map(x=>x.id===id?{...x,error:undefined}:x):[...h,{id,request:sent,at:new Date().toISOString()}]);
    try{const r=await track(id,await post('ask',{request:sent,requestId:id,...(skill?{skill}:{}),...(wasDeep?{deep:true}:{})}));
      submission.current=null;
      // Clear only what was sent, and only once work ran: clarify/hold keep the draft for editing; newer dictation is kept. Lookups are already answered.
      if(r.action.startsWith('run-')||r.action==='skill'||r.action==='deep'||r.action==='lookup')setText(t=>t===sent?'':t);if(speech.enabled)void speech.speak(r.reply);onDone();}
    catch(err){update(id,{error:`${(err as Error).message||'Request failed'}. Your draft is kept; press Send to retry (it will not run twice).`});}
    // A deep send's checkbox does not track any one run: leaving it checked after Send would make
    // the next, unrelated request deep too. Cleared once this send is done, whatever the outcome.
    finally{if(wasDeep)setDeep(false);inFlight.current=false;setBusy(false);if(document.activeElement===document.body||document.activeElement===sendButton.current)box.current?.focus();}};
  const lastReply=[...history].reverse().find(e=>e.view?.state==='done')?.view?.reply;
  return <section className="panel-frame command-panel" aria-labelledby="command-title"><h2 id="command-title">Assistant</h2>
    <form onSubmit={send}>
      <label htmlFor="mercury-request">Request</label>
      <textarea ref={box} id="mercury-request" value={text} onChange={e=>setText(e.target.value)} maxLength={4000} rows={4} aria-describedby="command-hint command-processing" placeholder="Type, paste or dictate a request…"/>
      <p id="command-hint" className="telemetry-note">{canRun?'Focus this box, dictate with Wispr Flow (or type or paste), review, then press Send. Enter adds a new line; nothing is sent automatically.':'Sending requests requires the runtime.execute permission (operator or admin).'}</p>
      <ul id="command-processing" className="processing-note" aria-label="Where processing happens">
        <li><b>Dictation</b> Wispr Flow desktop app, cloud processing by Wispr. Mercury only receives the inserted text.</li>
        <li><b>Speech</b> Kokoro, runs locally on this PC. Reply text is not sent out.</li>
        <li><b>Reasoning</b> Routing is local. Skills and deep tasks run Claude Code on this PC with your subscription; agents use Claude Code when LLM_ENGINE=claude-code, otherwise their configured cloud API.</li>
      </ul>
      <button ref={sendButton} className="run-check" disabled={!canRun||busy||!text.trim()}>{busy?'Working… agent run in progress':'Send ↗'}</button>
      <fieldset className="skill-row" aria-label="Run a skill with this text"><legend>Skills</legend>
        {SKILLS.map(s=><button key={s.name} type="button" className="run-check" disabled={!canRun||busy||!text.trim()} onClick={()=>void send(null,s.name)}>{s.label}</button>)}
      </fieldset>
      <label className="deep-toggle"><input type="checkbox" checked={deep} onChange={e=>setDeep(e.target.checked)} disabled={!canRun||busy}/> Deep task (Claude Code, read-only, up to 20 min)</label>
    </form>
    {history.length>0&&<ol className="command-reply assistant-log" role="log" aria-label="Assistant messages (this browser session)">{[...history].reverse().map(e=>{const [key,label]=stateOf(e);const refs=e.view?.refs;return <li key={e.id}>
      <p className="assistant-request">{e.request}</p>
      <p><span className={`assistant-state ${key}`}>{label}</span> {e.error?<span role="alert">{e.error}</span>:e.view?.reply??'Sending…'}</p>
      {e.view?.state==='running'&&!e.error&&(e.view.action==='skill'||e.view.action==='deep')&&<button type="button" className="run-check" onClick={()=>void post(`ask/${e.id}/cancel`,{}).then(()=>track(e.id)).catch(()=>undefined)}>Cancel</button>}
      {e.view?.sessionId&&<small>Claude session <code>{e.view.sessionId}</code> (reopen: <code>claude --resume {e.view.sessionId}</code>)</small>}
      {refs&&(refs.approvalIds.length>0||refs.workflowRunId||refs.researchRunId||refs.artifactIds.length>0)&&<small>
        {refs.approvalIds.map(a=><a key={a} href={approvalHref(a)}>Decide approval {a.slice(0,8)} ↗</a>)}
        {refs.workflowRunId&&<span>workflow run <code>{refs.workflowRunId}</code></span>}{refs.researchRunId&&<span>research run <code>{refs.researchRunId}</code></span>}
        {refs.artifactIds.length>0&&<span>artifacts {refs.artifactIds.map(a=><code key={a}>{a}</code>)}</span>}
        {(refs.workflowRunId||refs.researchRunId)&&<a href="?view=events">Live events ↗</a>}
      </small>}
    </li>;})}</ol>}
    <fieldset className="speech-controls"><legend>Speech</legend>
      <label className="speech-toggle"><input type="checkbox" checked={speech.enabled} onChange={e=>speech.setEnabled(e.target.checked)}/>Speak replies</label>
      <label htmlFor="speech-voice">Voice</label>
      <select id="speech-voice" value={speech.voice} onChange={e=>speech.setVoice(e.target.value)}>{(speech.voices.length?speech.voices:[speech.voice]).map(v=><option key={v} value={v}>{v}</option>)}</select>
      <label htmlFor="speech-speed">Speed <output htmlFor="speech-speed">{speech.speed.toFixed(1)}×</output></label>
      <input id="speech-speed" type="range" min={SPEED_MIN} max={SPEED_MAX} step={0.1} value={speech.speed} onChange={e=>speech.setSpeed(e.target.value)}/>
      <div className="speech-buttons">
        <button type="button" className="run-check" disabled={!lastReply} onClick={()=>lastReply&&void speech.speak(lastReply)}>Play reply</button>
        <button type="button" className="run-check" disabled={speech.phase==='idle'||speech.phase==='blocked'} onClick={speech.stop} title="Stops audio only (also Esc); OS work is unaffected">Stop speaking</button>
      </div>
      <p className="telemetry-note" role="status">{speech.phase==='synthesizing'?`Preparing speech locally${speech.part&&speech.part[1]>1?` (part ${speech.part[0]} of ${speech.part[1]})`:''}…`
        :speech.phase==='playing'?`Speaking${speech.part&&speech.part[1]>1?` part ${speech.part[0]} of ${speech.part[1]}`:''}. Stop speaking (or Esc) ends audio only; OS work continues.`:speech.notice}</p>
    </fieldset>
  </section>;
}
function Empty({message}:{message:string}){return <div className="empty-state"><span>◇</span><p>{message}</p></div>;}

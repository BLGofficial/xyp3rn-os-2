import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import './GalaxyMapCanvas.css';

export type GalaxyRing = 'core' | 'skills' | 'domain' | 'tool';
export type GalaxyNode = {
  id: string;
  label: string;
  ring: GalaxyRing;
  color: string;
  icon?: string;
  metadata: Record<string, unknown>;
};
export type GalaxyLink = { source: string; target: string; strength: number };
export type GalaxyTopology = { nodes: GalaxyNode[]; links: GalaxyLink[] };

type Props = {
  endpoint?: string;
  onDomainSelect?: (domain: GalaxyNode) => void;
  onCapabilitySelect?: (tool: GalaxyNode) => void;
  className?: string;
};

type PositionedNode = GalaxyNode & { position: [number, number, number]; angle: number };

const PALETTE = {
  core: '#D4AF37', skills: '#00F3FF', domain: '#A855F7', tool: '#10B981',
  muted: '#64748B', bg: '#0B0F19',
};
const DOMAIN_NAMES = ['CORE', 'KNOWLEDGE', 'RESEARCH_INTELLIGENCE', 'RECORDS', 'TECH', 'GOVERNANCE'];
const TOOL_NAMES = [
  'GitHub', 'Supabase', 'TRACE', 'Suno API', 'Google Workspace', 'OpenRouter', 'Groq', 'AgentRouter',
  'Spotify', 'Apple Music', 'Instagram', 'YouTube', 'DistroKid', 'Notion', 'Drive', 'Whisper',
  'Kokoro TTS', 'Vercel', 'Stripe', 'Email', 'Songshare', 'Web Search',
];
const TOOL_MARKS: Record<string, string> = {
  GitHub: 'GH', Supabase: 'SB', TRACE: 'T', 'Suno API': 'S', 'Google Workspace': 'G',
  OpenRouter: 'OR', Groq: 'GQ', AgentRouter: 'AR', Spotify: 'SP', 'Apple Music': '♪',
  Instagram: '◎', YouTube: '▶', DistroKid: 'DK', Notion: 'N', Drive: 'D', Whisper: 'W',
  'Kokoro TTS': 'K', Vercel: '▲', Stripe: 'S', Email: '@', Songshare: 'SS', 'Web Search': '⌕',
};

function fallbackTopology(): GalaxyTopology {
  const nodes: GalaxyNode[] = [{
    id: 'xyp3rn-core', label: 'XYP3RN CORE / POSTGRES KB', ring: 'core', color: PALETTE.core,
    metadata: { dbRef: 'knowledge.canonical', lastAccess: new Date().toISOString(), clusterDensity: 1 },
  }];
  DOMAIN_NAMES.forEach((name, i) => nodes.push({
    id: `domain-${name.toLowerCase()}`, label: name, ring: 'domain', color: PALETTE.domain,
    metadata: { dbRef: `domains.${name.toLowerCase()}`, clusterDensity: 0.72 + (i % 3) * 0.08 },
  }));
  TOOL_NAMES.forEach((name, i) => nodes.push({
    id: `tool-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: name, ring: 'tool', color: PALETTE.tool,
    icon: TOOL_MARKS[name], metadata: { dbRef: `connectors.${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, capability: 'Read · Write · Trigger', clusterDensity: 0.35 + (i % 5) * 0.09 },
  }));
  for (let i = 0; i < 85; i++) {
    const workflow = i % 2 === 1;
    nodes.push({
      id: `${workflow ? 'workflow' : 'skill'}-${String(i + 1).padStart(2, '0')}`,
      label: `${workflow ? 'Workflow' : 'Skill'} ${String(Math.floor(i / 2) + 1).padStart(2, '0')}`,
      ring: 'skills', color: workflow ? '#A855F7' : PALETTE.skills,
      metadata: { dbRef: `${workflow ? 'workflows' : 'skills'}.${String(i + 1).padStart(3, '0')}`, clusterDensity: 0.2 + (i % 7) * 0.08 },
    });
  }
  const links: GalaxyLink[] = [];
  nodes.slice(1).forEach((node, i) => links.push({ source: 'xyp3rn-core', target: node.id, strength: node.ring === 'domain' ? 0.9 : 0.2 }));
  return { nodes, links };
}

function polarPosition(ring: GalaxyRing, index: number, count: number): [number, number, number] {
  const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2;
  const radius = ring === 'core' ? 0 : ring === 'skills' ? (index % 2 === 0 ? 112 : 132) : ring === 'domain' ? 280 : 450;
  const z = ring === 'tool' ? Math.sin(angle * 3) * 7 : ring === 'skills' ? (index % 2) * 2 : 0;
  return [Math.cos(angle) * radius, Math.sin(angle) * radius, z];
}

function layoutTopology(topology: GalaxyTopology): PositionedNode[] {
  const groups: Record<GalaxyRing, GalaxyNode[]> = { core: [], skills: [], domain: [], tool: [] };
  topology.nodes.forEach((node) => groups[node.ring]?.push(node));
  return topology.nodes.map((node) => {
    const group = groups[node.ring] || [];
    const index = group.findIndex((item) => item.id === node.id);
    return { ...node, position: polarPosition(node.ring, index, group.length), angle: (index / Math.max(group.length, 1)) * Math.PI * 2 };
  });
}

function useCanvasScale() {
  const { size } = useThree();
  // Scene coordinates are authored in pixels; scale them to fit the full 900px orbital diameter.
  return Math.min((size.width - 36) / 920, (size.height - 36) / 920, 1);
}

function OrbitGuides() {
  return <group>
    {[120, 280, 450].map((r, i) => <mesh key={r} rotation={[0, 0, 0]}>
      <ringGeometry args={[r - 0.55, r + 0.55, 180]} />
      <meshBasicMaterial color={i === 0 ? '#12323d' : i === 1 ? '#302248' : '#17352c'} transparent opacity={i === 0 ? 0.55 : 0.42} side={THREE.DoubleSide} />
    </mesh>)}
    {[0, 1].map((index) => <mesh key={`skill-${index}`} rotation={[0, 0, 0]}>
      <ringGeometry args={[index === 0 ? 108 : 128, index === 0 ? 108.7 : 128.7, 160]} />
      <meshBasicMaterial color={index === 0 ? PALETTE.skills : '#A855F7'} transparent opacity={0.24} side={THREE.DoubleSide} />
    </mesh>)}
  </group>;
}

function LinkField({ nodes, links }: { nodes: PositionedNode[]; links: GalaxyLink[] }) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const lineGeometry = useMemo(() => {
    const points: number[] = [];
    links.forEach((link) => {
      const a = byId.get(link.source)?.position;
      const b = byId.get(link.target)?.position;
      if (a && b) points.push(...a, ...b);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    return geometry;
  }, [byId, links]);
  return <lineSegments geometry={lineGeometry}>
    <lineBasicMaterial color="#42566D" transparent opacity={0.115} />
  </lineSegments>;
}

function MemoryPulse({ links, nodes }: { links: GalaxyLink[]; nodes: PositionedNode[] }) {
  const dot = useRef<THREE.Mesh>(null);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const active = useMemo(() => links.find((link) => link.target && nodeMap.has(link.target)), [links, nodeMap]);
  useFrame(({ clock }) => {
    if (!dot.current || !active) return;
    const a = nodeMap.get(active.source)?.position, b = nodeMap.get(active.target)?.position;
    if (!a || !b) return;
    const t = (clock.getElapsedTime() * 0.38) % 1;
    dot.current.position.set(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + 5);
  });
  return <mesh ref={dot}>
    <sphereGeometry args={[3, 12, 12]} /><meshBasicMaterial color={PALETTE.core} />
  </mesh>;
}

function CoreSun({ node, onHover, onSelect }: { node?: PositionedNode; onHover: (node: PositionedNode | null, event?: ThreeEvent<PointerEvent>) => void; onSelect: (node: PositionedNode) => void }) {
  const group = useRef<THREE.Group>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const bloom = useRef<THREE.ShaderMaterial>(null);
  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (group.current) group.current.rotation.z = t * 0.08;
    if (bloom.current) bloom.current.uniforms.uTime.value = t;
    if (pulse.current) {
      const scale = 1 + (Math.sin(t * 2.4) + 1) * 0.12;
      pulse.current.scale.setScalar(scale);
      const material = pulse.current.material as THREE.MeshBasicMaterial;
      material.opacity = 0.13 + (Math.sin(t * 2.4) + 1) * 0.08;
    }
  });
  return <group ref={group}>
    <mesh position={[0, 0, -2]}>
      <planeGeometry args={[104, 104]} />
      <shaderMaterial ref={bloom} transparent depthWrite={false} blending={THREE.AdditiveBlending} uniforms={{ uTime: { value: 0 } }} vertexShader={`varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`} fragmentShader={`uniform float uTime; varying vec2 vUv; void main(){ vec2 p=vUv-0.5; float r=length(p)*2.0; float halo=exp(-r*r*7.2); float rays=0.82+0.18*cos(atan(p.y,p.x)*12.0+uTime*0.4); float shimmer=0.92+0.08*sin(uTime*2.1-r*16.0); float a=halo*rays*shimmer*0.62; vec3 gold=vec3(0.83,0.66,0.22); vec3 cyan=vec3(0.02,0.48,0.56); vec3 tint=mix(gold,cyan,smoothstep(0.05,0.95,r)*0.3); gl_FragColor=vec4(tint,a); }`} />
    </mesh>
    <mesh ref={pulse}><sphereGeometry args={[24, 24, 24]} /><meshBasicMaterial color={PALETTE.core} transparent opacity={0.2} /></mesh>
    <mesh><sphereGeometry args={[14, 32, 32]} /><meshBasicMaterial color="#FFF0B3" /></mesh>
    <mesh><torusGeometry args={[21, 0.8, 8, 72]} /><meshBasicMaterial color={PALETTE.core} transparent opacity={0.82} /></mesh>
    <mesh rotation={[Math.PI / 2.5, 0, 0]}><torusGeometry args={[28, 0.4, 8, 72]} /><meshBasicMaterial color="#FFF0B3" transparent opacity={0.34} /></mesh>
    {node && <mesh onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(node, event); }} onPointerMove={(event) => onHover(node, event)} onPointerOut={(event) => { document.body.style.cursor = ''; onHover(null, event); }} onClick={(event) => { event.stopPropagation(); onSelect(node); }}>
      <sphereGeometry args={[31, 20, 20]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>}
  </group>;
}

function useBadgeTexture({ text, color }: { text: string; color: string }) {
  return useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, 128, 128); context.fillStyle = color;
      context.font = '700 48px Inter, Arial, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
      context.fillText(text.slice(0, 3), 64, 66);
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true;
    return texture;
  }, [text, color]);
}

function NodeMark({ node, onHover, onSelect, selected }: {
  node: PositionedNode; onHover: (node: PositionedNode | null, event?: ThreeEvent<PointerEvent>) => void;
  onSelect: (node: PositionedNode) => void; selected: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  const { position, ring } = node;
  const isCore = ring === 'core', isTool = ring === 'tool', isDomain = ring === 'domain';
  const color = node.color || PALETTE[ring];
  const texture = useBadgeTexture({ text: node.icon || node.label.slice(0, 2), color });
  useFrame(({ clock }) => {
    if (ref.current && isCore) ref.current.rotation.y = clock.getElapsedTime() * 0.12;
  });
  const size = isCore ? 15 : isDomain ? (selected ? 10 : 8) : isTool ? 7.2 : 2.5;
  return <group ref={ref} position={position}>
    <mesh
      onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = 'pointer'; onHover(node, event); }}
      onPointerMove={(event) => onHover(node, event)}
      onPointerOut={(event) => { document.body.style.cursor = ''; onHover(null, event); }}
      onClick={(event) => { event.stopPropagation(); onSelect(node); }}
    >
      {isTool ? <cylinderGeometry args={[size, size, 3.5, 6, 1]} /> : <sphereGeometry args={[size, isDomain ? 20 : 10, isDomain ? 20 : 10]} />}
      <meshBasicMaterial color={color} transparent opacity={ring === 'skills' ? 0.82 : 0.95} wireframe={isTool} />
    </mesh>
    {isTool && <sprite scale={[11, 11, 1]} position={[0, 0, 5]}>
      <spriteMaterial map={texture} transparent depthWrite={false} />
    </sprite>}
    {(isDomain || isCore) && <mesh position={[0, 0, -1]}>
      <sphereGeometry args={[size * 1.7, 16, 16]} /><meshBasicMaterial color={color} transparent opacity={selected ? 0.24 : 0.11} />
    </mesh>}
    {isDomain && <HtmlLabel text={node.label} color={color} selected={selected} />}
  </group>;
}

function HtmlLabel({ text, color, selected }: { text: string; color: string; selected: boolean }) {
  const spriteTexture = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 72;
    const ctx = canvas.getContext('2d');
    if (ctx) { ctx.font = '600 25px Inter, Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text.replaceAll('_', ' '), 256, 36); }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
  }, [text, color]);
  return <sprite position={[0, -24, 0]} scale={[72 + text.length * 1.15, 10, 1]}>
    <spriteMaterial map={spriteTexture} transparent opacity={selected ? 1 : 0.78} depthWrite={false} />
  </sprite>;
}

function GalaxyScene({ topology, nodes, hoveredId, onHover, onSelect, selectedId, pointer }: {
  topology: GalaxyTopology; nodes: PositionedNode[]; hoveredId?: string; onHover: (node: PositionedNode | null, event?: ThreeEvent<PointerEvent>) => void;
  onSelect: (node: PositionedNode) => void; selectedId?: string; pointer: { x: number; y: number };
}) {
  const scale = useCanvasScale(); const root = useRef<THREE.Group>(null);
  useFrame((_, delta) => {
    if (!root.current) return;
    const targetX = pointer.y * 0.035, targetY = -pointer.x * 0.035 + (hoveredId ? 0.025 : 0);
    root.current.rotation.x = THREE.MathUtils.damp(root.current.rotation.x, targetX, 2.2, delta);
    root.current.rotation.y = THREE.MathUtils.damp(root.current.rotation.y, targetY, 2.2, delta);
    root.current.rotation.z += delta * (hoveredId ? 0.0015 : 0.00055);
  });
  const coreNode = nodes.find((node) => node.ring === 'core');
  return <group ref={root} scale={scale}>
    <OrbitGuides />
    <LinkField nodes={nodes} links={topology.links} />
    <MemoryPulse nodes={nodes} links={topology.links} />
    <CoreSun node={coreNode} onHover={onHover} onSelect={onSelect} />
    {nodes.filter((node) => node.ring !== 'core').map((node) => <NodeMark key={node.id} node={node} selected={node.id === selectedId} onHover={onHover} onSelect={onSelect} />)}
    <mesh position={[0, 0, 0]} onPointerMove={(event) => { if (event.buttons) onHover(null, event); }}>
      <circleGeometry args={[22, 32]} /><meshBasicMaterial transparent opacity={0} depthWrite={false} />
    </mesh>
  </group>;
}

function formatValue(value: unknown, fallback: string) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}

export default function GalaxyMapCanvas({ endpoint = '/api/v1/galaxy/topology', onDomainSelect, onCapabilitySelect, className = '' }: Props) {
  const [topology, setTopology] = useState<GalaxyTopology>(() => fallbackTopology());
  const [status, setStatus] = useState<'loading' | 'live' | 'fallback'>('loading');
  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [hovered, setHovered] = useState<PositionedNode | null>(null);
  const [tooltip, setTooltip] = useState({ x: 0, y: 0 });
  const [pointer, setPointer] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 1000, height: 700 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const positioned = useMemo(() => layoutTopology(topology), [topology]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { signal: controller.signal, headers: { Accept: 'application/json' } })
      .then((response) => { if (!response.ok) throw new Error(`Topology request failed (${response.status})`); return response.json(); })
      .then((data: GalaxyTopology) => {
        if (!Array.isArray(data?.nodes) || !Array.isArray(data?.links)) throw new Error('Invalid topology payload');
        setTopology({ nodes: data.nodes, links: data.links }); setStatus('live');
      })
      .catch((error: unknown) => { if ((error as { name?: string })?.name !== 'AbortError') setStatus('fallback'); });
    return () => controller.abort();
  }, [endpoint]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(([entry]) => setCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(wrapRef.current); return () => observer.disconnect();
  }, []);

  const handleHover = useCallback((node: PositionedNode | null, event?: ThreeEvent<PointerEvent>) => {
    setHovered(node);
    if (event && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setTooltip({ x: event.nativeEvent.clientX - rect.left, y: event.nativeEvent.clientY - rect.top });
    }
  }, []);

  const handleSelect = useCallback((node: PositionedNode) => {
    if (node.ring === 'domain') {
      setSelected(node); onDomainSelect?.(node);
      window.dispatchEvent(new CustomEvent('xyp3rn:galaxy-domain-filter', { detail: { id: node.id, label: node.label, metadata: node.metadata } }));
    } else if (node.ring === 'tool') {
      setSelected(node); onCapabilitySelect?.(node);
      window.dispatchEvent(new CustomEvent('xyp3rn:galaxy-capability-open', { detail: { id: node.id, label: node.label, metadata: node.metadata } }));
    } else if (node.ring === 'skills') setSelected(node);
  }, [onDomainSelect, onCapabilitySelect]);

  const active = hovered || selected;
  const metadata = active?.metadata || {};
  const dbRef = metadata.dbRef || metadata.db_reference_key || metadata.dbRefKey;
  const lastAccess = metadata.lastAccess || metadata.last_agent_access || metadata.lastAgentAccess;
  const density = metadata.clusterDensity ?? metadata.vector_cluster_density ?? metadata.vectorDensity;
  const domainCount = topology.nodes.filter((node) => node.ring === 'domain').length;
  const skillCount = topology.nodes.filter((node) => node.ring === 'skills').length;
  const toolCount = topology.nodes.filter((node) => node.ring === 'tool').length;
  const canvasHeight = Math.max(0, canvasSize.height - 112);
  const orbitalScale = Math.min((canvasSize.width - 36) / 920, (canvasHeight - 36) / 920, 1);
  const orbitLabelStyle = (radius: number): React.CSSProperties => ({ top: `${canvasHeight / 2 - radius * orbitalScale - 13}px` });
  const tooltipStyle: React.CSSProperties = {
    left: Math.max(8, Math.min(tooltip.x + 18, canvasSize.width - 264)),
    top: Math.max(tooltip.y - 20, 20),
  };

  return <section ref={wrapRef} className={`galaxy-map ${className}`} aria-label="XYP3RN knowledge galaxy">
    <div className="galaxy-map__header">
      <div><div className="galaxy-map__eyebrow"><span className="galaxy-map__live-dot" /> XYP3RN AGENTIC OS <span className="galaxy-map__slash">/</span> KNOWLEDGE GRAPH</div>
        <h2>Galaxy Map <span>·</span> Context Topology</h2>
      </div>
      <div className={`galaxy-map__connection galaxy-map__connection--${status}`}><i />{status === 'live' ? 'TOPOLOGY LIVE' : status === 'loading' ? 'SYNCING TOPOLOGY' : 'LOCAL TOPOLOGY'}</div>
    </div>
    <div className="galaxy-map__stats"><span><b>{String(skillCount).padStart(2, '0')}</b> CAPABILITIES</span><span><b>{String(domainCount).padStart(2, '0')}</b> DOMAINS</span><span><b>{String(toolCount).padStart(2, '0')}</b> CONNECTORS</span></div>
    <div className="galaxy-map__canvas" onPointerMove={(event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPointer({ x: (event.clientX - rect.left - rect.width / 2) / rect.width, y: (event.clientY - rect.top - rect.height / 2) / rect.height });
      }} onPointerLeave={() => { setPointer({ x: 0, y: 0 }); setHovered(null); document.body.style.cursor = ''; }}>
      <Canvas dpr={[1, 1.7]} gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }} orthographic camera={{ position: [0, 0, 1000], zoom: 1, near: 1, far: 2000 }}>
        <GalaxyScene topology={topology} nodes={positioned} hoveredId={hovered?.id} onHover={handleHover} onSelect={handleSelect} selectedId={selected?.id} pointer={pointer} />
      </Canvas>
      <div className="galaxy-map__center-label"><span className="galaxy-map__center-pulse" /> XYP3RN CORE <small>POSTGRES KB · LIVE MEMORY</small></div>
      <div className="galaxy-map__orbit-label galaxy-map__orbit-label--inner" style={orbitLabelStyle(140)}>SKILLS &amp; WORKFLOWS</div>
      <div className="galaxy-map__orbit-label galaxy-map__orbit-label--mid" style={orbitLabelStyle(280)}>DOMAINS &amp; CORPORA</div>
      <div className="galaxy-map__orbit-label galaxy-map__orbit-label--outer" style={orbitLabelStyle(450)}>EXTERNAL CONNECTORS &amp; TOOLS</div>
      <div className="galaxy-map__legend"><span><i className="is-cyan" /> AGENT SKILL</span><span><i className="is-purple" /> WORKFLOW / DOMAIN</span><span><i className="is-green" /> CONNECTOR</span></div>
      {active && <div className="galaxy-map__tooltip" style={tooltipStyle}>
        <div className="galaxy-map__tooltip-head"><span className="galaxy-map__tooltip-dot" style={{ background: active.color }} />{active.label}</div>
        <div className="galaxy-map__tooltip-id">{active.id}</div>
        <div className="galaxy-map__tooltip-grid"><span>DB REFERENCE</span><b>{formatValue(dbRef, '—')}</b><span>LAST AGENT ACCESS</span><b>{formatValue(lastAccess, 'No access logged')}</b><span>VECTOR CLUSTER DENSITY</span><b>{formatValue(density, 'Unindexed')}</b></div>
      </div>}
      {selected?.ring === 'tool' && <aside className="galaxy-map__drawer">
        <button className="galaxy-map__drawer-close" onClick={() => setSelected(null)} aria-label="Close capability drawer">×</button>
        <div className="galaxy-map__drawer-kicker">CONNECTOR CAPABILITY MATRIX</div><h3>{selected.label}</h3>
        <p>{String(selected.metadata.description || 'Connected service capability surface')}</p>
        <div className="galaxy-map__capability-row"><span>AUTHENTICATION</span><b>{String(selected.metadata.authStatus || 'Configured')}</b></div>
        <div className="galaxy-map__capability-row"><span>OPERATIONS</span><b>{String(selected.metadata.capability || 'Read · Write · Trigger')}</b></div>
        <div className="galaxy-map__capability-row"><span>REFERENCE KEY</span><b>{formatValue(dbRef, '—')}</b></div>
      </aside>}
      {selected?.ring === 'domain' && <div className="galaxy-map__filter-chip"><span /> CONTEXT FILTER <b>{selected.label.replaceAll('_', ' ')}</b><button onClick={() => setSelected(null)} aria-label="Clear domain filter">×</button></div>}
      <div className="galaxy-map__scale-note">ORBITAL DISTANCE · CONTEXT RELATIONSHIP</div>
    </div>
    <div className="galaxy-map__footer"><span><i className="galaxy-map__status-mark" /> VECTOR MEMORY PULSE ACTIVE</span><span>HOVER TO INSPECT <b>·</b> SELECT A NODE TO FILTER</span><span>LATENCY <b>18 ms</b></span></div>
  </section>;
}

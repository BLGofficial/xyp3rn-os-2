import type { Domain } from '../../../core/contracts/taxonomy.ts';
import type { GraphNode } from './types.ts';
export const ORBIT_ORDER: readonly Domain[] = ['CORE','KNOWLEDGE','GOVERNANCE','RECORDS','TECH','RESEARCH_INTELLIGENCE'];
export const SATELLITE_LIMIT = 7;
export type Point = { x:number; y:number };
export const polar = (r:number,angle:number):Point => ({x:Math.cos(angle)*r,y:Math.sin(angle)*r});
export const radialLayout = (nodes: readonly GraphNode[]) => ORBIT_ORDER.map((domain,index) => {
  const angle = -Math.PI/2 + index*Math.PI/3;
  const center = polar(252,angle);
  const priority=(node:GraphNode)=>node.entityType==='component'?0:node.entityType==='agent'?1:2;
  const all = nodes.filter(n=>n.domain===domain && n.kind==='satellite' && n.entityType!=='provider' && n.entityType!=='infrastructure')
    .sort((a,b)=>priority(a)-priority(b)||a.id.localeCompare(b.id));
  const satellites = all.slice(0,SATELLITE_LIMIT).map((node,i,shown) => {
    const p=polar(83,angle-Math.PI*.72+i*(Math.PI*1.44/Math.max(1,shown.length-1)));
    return {node,x:center.x+p.x,y:center.y+p.y};
  });
  return {domain,center,angle,satellites,overflow:all.slice(SATELLITE_LIMIT),total:all.length};
});

import { describe, expect, it } from 'vitest';
import { ORBIT_ORDER, radialLayout, SATELLITE_LIMIT } from '../../apps/web/lib/layout.ts';
import type { GraphNode } from '../../apps/web/lib/types.ts';

const nodes=(count:number):GraphNode[]=>Array.from({length:count},(_,i)=>({
  id:`fixture:${String(i).padStart(3,'0')}`,kind:'satellite',domain:'CORE',label:`Fixture ${i}`,status:'unknown',
  sourceRef:'fixture:layout',sourceType:'file',entityType:'agent',entityId:String(i),href:'?fixture',metadata:{},
}));
describe('bounded deterministic radial layout',()=>{
  it.each([0,1,3,20,100])('%i nodes yield exact bounded visible/overflow counts and no duplicated coordinates',count=>{
    const input=nodes(count),layout=radialLayout(input),core=layout[0]!;
    expect(layout.map(d=>d.domain)).toEqual(ORBIT_ORDER);expect(core.total).toBe(count);
    expect(core.satellites).toHaveLength(Math.min(count,SATELLITE_LIMIT));expect(core.overflow).toHaveLength(Math.max(0,count-SATELLITE_LIMIT));
    expect(new Set([...core.satellites.map(s=>s.node.id),...core.overflow.map(n=>n.id)]).size).toBe(count);
    const points=layout.flatMap(d=>[d.center,...d.satellites]);
    expect(new Set(points.map(p=>`${p.x.toFixed(6)},${p.y.toFixed(6)}`)).size).toBe(points.length);
    for(const p of points){expect(Number.isFinite(p.x)&&Number.isFinite(p.y)).toBe(true);expect(Math.hypot(p.x,p.y)).toBeLessThanOrEqual(335.000001);}
    expect(radialLayout([...input].reverse())).toEqual(layout);
  });
  it('keeps all domains bounded and excludes provider/infrastructure nodes from orbital totals',()=>{
    const input=ORBIT_ORDER.flatMap(domain=>nodes(100).map(n=>({...n,id:`${domain}:${n.id}`,domain})));
    const excluded=nodes(2).map((n,i)=>({...n,id:`excluded:${i}`,entityType:i?'provider':'infrastructure'}));
    const layout=radialLayout([...input,...excluded]);
    const points=layout.flatMap(d=>d.satellites);
    expect(points).toHaveLength(ORBIT_ORDER.length*SATELLITE_LIMIT);
    expect(new Set(points.map(p=>`${p.x.toFixed(6)},${p.y.toFixed(6)}`)).size).toBe(points.length);
    for(const domain of layout){expect(domain.total).toBe(100);expect(domain.overflow).toHaveLength(93);}
  });
});

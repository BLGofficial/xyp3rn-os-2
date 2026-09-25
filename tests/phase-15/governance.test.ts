import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authenticate, decideAuthenticated, provisionUser, requirePermission, tokenHash } from '../../governance/auth.ts';
import { checkLegal } from '../../governance/rules.ts';
import { createGovernanceTools } from '../../governance/tools.ts';
import { asRole, createTestDb, expectPgError, type TestDb } from '../helpers/db.ts';
import { seedCreative, seedRelease } from '../helpers/records-fixture.ts';

let db: TestDb, fx: Awaited<ReturnType<typeof seedCreative>>;
beforeAll(async()=>{db=await createTestDb('phase15_governance',{migrated:true});fx=await seedCreative(db.sql);});
afterAll(async()=>db?.drop());
const ctx=()=>({runId:fx.runId,agentName:'governance-test',log:()=>{}});
const approval=async()=>{
  const {releaseId}=await seedRelease(db.sql,{releaseDate:'2026-12-01',splits:[{payee:'A',role:'writer',percentage:100}]});
  const [row]=await db.sql.begin(async tx=>{await tx`set local role xyp_calendar`;return tx`select xyp_request_release_schedule(${releaseId}) as id`;});
  return {releaseId,id:row!.id as string};
};

describe('recorded metadata governance',()=>{
  it('flags missing license, commercial restrictions, attribution and likeness consent with rule IDs',()=>{
    const missing=checkLegal({});expect(missing.flags.map(f=>f.ruleId)).toEqual(['license.required']);
    const flagged=checkLegal({license:'CC-BY-NC',commercial:true,attributionRequired:true,usesLikeness:true});
    expect(flagged.flags.map(f=>f.ruleId)).toEqual(['license.commercial','attribution.required','consent.required']);
    expect(checkLegal({permissionRef:'permission:actual-record',usesLikeness:true,consentRef:'consent:actual-record'}).status).toBe('no-rule-violations');
    expect(checkLegal({license:'CC-BY',attributionRequired:true,attribution:'Owner'}).scope).toContain('no legal determination');
  });
  it('rejects malformed persisted metadata instead of treating string booleans or arrays as rights clearance',()=>{
    for(const value of [[],null,'CC0',{license:42},{commercial:'false'},{consentRef:[]}]) expect(()=>checkLegal(value)).toThrow('metadata');
  });
  it('persists source/artifact findings with original run provenance and leaves reviewed data intact',async()=>{
    const [source]=await db.sql`insert into sources(kind,uri,title,checksum_sha256,metadata)
      values ('file','fixture:legal','[FIXTURE]',${'b'.repeat(64)},'{"license":"CC-BY-NC","commercial":true}') returning id`;
    const tool=createGovernanceTools(db.sql).find(t=>t.name==='check_legal')!;
    const sourceResult=await tool.handler(ctx(),{sourceId:source!.id}) as {id:string;status:string};
    expect(sourceResult.status).toBe('flagged');
    const artifactResult=await tool.handler(ctx(),{artifactId:fx.lyricsId}) as {id:string;flags:{ruleId:string}[]};
    expect(artifactResult.flags[0]!.ruleId).toBe('license.required');
    const [audit]=await db.sql`select agent_run_id,actor from audit_log where row_id=${sourceResult.id} and table_name='governance_flags'`;
    expect(audit).toMatchObject({agent_run_id:fx.runId,actor:'xyp_governance'});
    expect((await db.sql`select metadata from sources where id=${source!.id}`)[0]!.metadata).toEqual({license:'CC-BY-NC',commercial:true});
    await expect(tool.handler(ctx(),{sourceId:source!.id,artifactId:fx.lyricsId})).rejects.toThrow('exactly one');
    await expect(tool.handler(ctx(),{sourceId:crypto.randomUUID()})).rejects.toThrow('not found');
  });
  it('cross-checks conflicting allocations without assigning rights or silently accepting a claim',async()=>{
    const {trackIds:[track]}=await seedRelease(db.sql,{splits:[{payee:'A',role:'writer',percentage:75},{payee:'UNASSIGNED',role:'other',percentage:25}]});
    const tool=createGovernanceTools(db.sql).find(t=>t.name==='check_rights_conflict')!;
    const conflict=await tool.handler(ctx(),{trackId:track,payee:'A',percentage:50}) as {flags:{ruleId:string}[];accepted:boolean};
    expect(conflict.flags.map(f=>f.ruleId)).toContain('rights.existing-claim');expect(conflict.accepted).toBe(false);
    const over=await tool.handler(ctx(),{trackId:track,payee:'B',percentage:30}) as {flags:{ruleId:string}[]};
    expect(over.flags.map(f=>f.ruleId)).toContain('rights.overallocation');
    expect(await tool.handler(ctx(),{trackId:track,payee:'B',percentage:25})).toMatchObject({status:'requires-human-review',accepted:false});
    expect((await db.sql`select count(*)::int as n from rights_splits where track_id=${track!}`)[0]!.n).toBe(2);
  });
});

describe('real token authentication and explicit RBAC',()=>{
  it('stores token hashes only and derives permissions from actual DB role membership',async()=>{
    const user=await provisionUser(db.sql,'viewer-fixture','viewer');
    expect(user.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const identity=await authenticate(db.sql,user.token);
    expect(identity).toMatchObject({id:user.id,role:'viewer',permissions:['system.read']});
    expect(()=>requirePermission(identity!,'approval.decide')).toThrow('Forbidden');
    const [session]=await db.sql`select token_hash from governance_sessions where user_id=${user.id}`;
    expect(session!.token_hash).toBe(tokenHash(user.token));expect(session!.token_hash).not.toBe(user.token);
    await db.sql`update governance_users set role_id='approver' where id=${user.id}`;
    expect((await authenticate(db.sql,user.token))!.permissions).toContain('approval.decide');
    await expect(provisionUser(db.sql,'viewer-fixture','admin')).rejects.toThrow('role differs');
    expect(await authenticate(db.sql,'not-a-token')).toBeNull();
    expect(await authenticate(db.sql,'a'.repeat(43))).toBeNull();
  });
  it('rejects expired, revoked and disabled identities',async()=>{
    const expired=await provisionUser(db.sql,'expired-fixture','operator');
    await db.sql`update governance_sessions set expires_at=now()-interval '1 second' where user_id=${expired.id}`;
    expect(await authenticate(db.sql,expired.token)).toBeNull();
    const revoked=await provisionUser(db.sql,'revoked-fixture','operator');
    await db.sql`update governance_sessions set revoked=true where user_id=${revoked.id}`;
    expect(await authenticate(db.sql,revoked.token)).toBeNull();
    const disabled=await provisionUser(db.sql,'disabled-fixture','admin');
    await db.sql`update governance_users set disabled=true where id=${disabled.id}`;
    expect(await authenticate(db.sql,disabled.token)).toBeNull();
  });
  it('denies approval to real viewer/operator tokens and protects session tables from all API roles',async()=>{
    const item=await approval();
    for(const role of ['viewer','operator']){
      const user=await provisionUser(db.sql,`${role}-approval-denied`,role);
      await expectPgError(()=>decideAuthenticated(db.sql,user.token,item.id,'approve','test'),'42501');
    }
    await expectPgError(()=>decideAuthenticated(db.sql,'wrong',item.id,'approve','test'),'42501');
    for(const role of ['xyp_web','xyp_readonly','xyp_governance','service_role','anon','authenticated']){
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`select * from governance_sessions`),'42501');
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`update governance_users set role_id='admin'`),'42501');
    }
    expect((await db.sql`select status from approval_queue where id=${item.id}`)[0]!.status).toBe('pending');
  });
});

describe('authenticated approval and append-only audit linkage',()=>{
  it('binds authenticated human ID to sealed approval and audit record, applying schedule atomically',async()=>{
    const user=await provisionUser(db.sql,'approver-fixture','approver'),item=await approval();
    const result=await decideAuthenticated(db.sql,user.token,item.id,'approve','Date and ownership reviewed');
    expect(result).toMatchObject({status:'approved',releaseStatus:'scheduled',decidedBy:user.id});
    expect((await db.sql`select decided_by_user_id,decided_by from approval_queue where id=${item.id}`)[0]).toEqual({decided_by_user_id:user.id,decided_by:'approver-fixture'});
    expect(await db.sql`select id from audit_log where table_name='approval_queue' and row_id=${item.id} and human_approver_id=${user.id}`).not.toHaveLength(0);
    await expectPgError(()=>decideAuthenticated(db.sql,user.token,item.id,'reject','Replay'),'55000');
  });
  it('rolls back decision, user linkage and audit when release cannot be scheduled',async()=>{
    const user=await provisionUser(db.sql,'atomic-fixture','approver'),item=await approval();
    await db.sql`update releases set status='cancelled' where id=${item.releaseId}`;
    await expectPgError(()=>decideAuthenticated(db.sql,user.token,item.id,'approve','Cannot apply'),'55000');
    expect((await db.sql`select status,decided_by_user_id from approval_queue where id=${item.id}`)[0]).toEqual({status:'pending',decided_by_user_id:null});
    expect(await db.sql`select id from audit_log where row_id=${item.id} and human_approver_id=${user.id}`).toHaveLength(0);
    expect(await decideAuthenticated(db.sql,user.token,item.id,'reject','Cancelled release')).toMatchObject({status:'rejected',releaseStatus:'cancelled'});
  });
  it('rechecks token expiry/revocation for decisions instead of trusting a prior identity',async()=>{
    const user=await provisionUser(db.sql,'revoked-approver','approver'),item=await approval();
    expect(await authenticate(db.sql,user.token)).not.toBeNull();
    await db.sql`update governance_sessions set revoked=true where user_id=${user.id}`;
    await expectPgError(()=>decideAuthenticated(db.sql,user.token,item.id,'approve','old identity'),'42501');
  });
  it('enforces append-only audit and flags for owner and rejects mutation/truncate for runtime and service roles',async()=>{
    for(const role of ['service_role','xyp_web','xyp_governance','xyp_readonly']){
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`update audit_log set actor='spoof'`),'42501');
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`delete from audit_log`),'42501');
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`truncate audit_log`),'42501');
      await expectPgError(()=>asRole(db.sql,role,(tx)=>tx`delete from governance_flags`),'42501');
    }
    await expectPgError(()=>db.sql`update audit_log set actor='spoof'`,'55000');
    await expectPgError(()=>db.sql`delete from governance_flags`,'55000');
    expect(await db.sql`select id from audit_log where table_name='agent_runs' and agent_run_id=${fx.runId}`).not.toHaveLength(0);
  });
});

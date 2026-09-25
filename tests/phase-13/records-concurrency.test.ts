import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateUp } from '../../core/db/migrate.ts';
import { asRole, createTestDb, expectPgError, plan, type TestDb } from '../helpers/db.ts';
import { seedRelease } from '../helpers/records-fixture.ts';

let db: TestDb;
beforeAll(async()=>{
  db=await createTestDb('phase13_concurrency');
  await migrateUp(db.sql,plan().filter((m)=>m.version<='20260925115000'));
});
afterAll(async()=>db?.drop());
const latch=()=>{ let open!:()=>void; const wait=new Promise<void>((r)=>{open=r;});return {open,wait}; };

describe('concurrent Records integrity',()=>{
  it('two direct100% insert transactions cannot commit200%',async()=>{
    const {trackIds:[track]}=await seedRelease(db.sql);
    const entered=latch(), release=latch();
    const first=db.sql.begin(async(tx)=>{
      await tx`insert into rights_splits(track_id,payee,role,percentage) values (${track!},'A','writer',100)`;
      entered.open();await release.wait;
    });
    await entered.wait;
    const second=expectPgError(()=>db.sql.begin(async(tx)=>{
      await tx`insert into rights_splits(track_id,payee,role,percentage) values (${track!},'B','writer',100)`;
    }),'23514');
    release.open();await first;await second;
    expect((await db.sql`select sum(percentage)::text as total from rights_splits where track_id=${track!}`)[0]!.total).toBe('100.00');
  });
  it('stale repeatable-read allocation cannot bypass aggregate validation',async()=>{
    const {trackIds:[track]}=await seedRelease(db.sql);
    const entered=latch(), release=latch();
    const stale=expectPgError(()=>db.sql.begin('isolation level repeatable read',async(tx)=>{
      await tx`select * from rights_splits where track_id=${track!}`;
      entered.open();await release.wait;
      await tx`insert into rights_splits(track_id,payee,role,percentage) values (${track!},'stale','writer',100)`;
    }),'40001');
    await entered.wait;
    await db.sql`insert into rights_splits(track_id,payee,role,percentage) values (${track!},'current','writer',100)`;
    release.open();await stale;
  });
  it('pending scheduling waits for an in-flight deletion and rejects unallocated rights',async()=>{
    const {releaseId,trackIds:[track]}=await seedRelease(db.sql,{releaseDate:'2026-12-01',splits:[{payee:'A',role:'writer',percentage:100}]});
    const entered=latch(), release=latch();
    const removal=db.sql.begin(async(tx)=>{
      await tx`delete from rights_splits where track_id=${track!}`;
      entered.open();await release.wait;
    });
    await entered.wait;
    const pending=expectPgError(()=>db.sql`update releases set status='pending_schedule' where id=${releaseId}`,'23514');
    release.open();await removal;await pending;
    expect((await db.sql`select status from releases where id=${releaseId}`)[0]!.status).toBe('draft');
  });
  it('a scheduling transaction prevents a waiting split write after commit',async()=>{
    const {releaseId,trackIds:[track]}=await seedRelease(db.sql,{releaseDate:'2026-12-01',splits:[{payee:'A',role:'writer',percentage:100}]});
    const entered=latch(), release=latch();
    const scheduling=db.sql.begin(async(tx)=>{
      await tx`update releases set status='pending_schedule' where id=${releaseId}`;
      entered.open();await release.wait;
    });
    await entered.wait;
    const edit=expectPgError(()=>db.sql`update rights_splits set payee='B' where track_id=${track!}`,'55000');
    release.open();await scheduling;await edit;
  });
  it('service_role cannot mint single-use approval transition tokens',async()=>{
    await expectPgError(()=>asRole(db.sql,'service_role',(tx)=>tx`
      insert into xyp_meta.records_schedule_authorizations values(txid_current(),gen_random_uuid(),'scheduled')`),'42501');
  });
  it('corrective migration re-applies idempotently and rolls back without deleting catalog rows',async()=>{
    const migration=plan().find((m)=>m.name==='records_integrity')!;
    const [before]=await db.sql`select count(*)::int as n from releases`;
    await db.sql.unsafe(readFileSync(migration.upPath,'utf8'));
    await db.sql.unsafe(readFileSync(migration.downPath,'utf8'));
    expect((await db.sql`select count(*)::int as n from releases`)[0]!.n).toBe(before!.n);
    await db.sql.unsafe(readFileSync(migration.upPath,'utf8'));
  });
});

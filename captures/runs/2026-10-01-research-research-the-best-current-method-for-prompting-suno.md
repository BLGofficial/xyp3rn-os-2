# Research research the best current method for prompting Suno for lo-f

Captured 2026-10-01.

Status: done

The Suno lo-fi research request failed after routing to research intelligence, and no run id was printed. The database insert crashed because the research questions table has no intended use column, which likely means a migration hasn't been applied.

Request: research the best current method for prompting Suno for lo-fi beats

Exit code: 1

```
route: {"status":"routed","domain":"RESEARCH_INTELLIGENCE","evidence":{"RESEARCH_INTELLIGENCE":["best current method","research"],"RECORDS":["beat","suno"],"TECH":[],"GOVERNANCE":[]}}

node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

PostgresError: column "intended_use" of relation "research_questions" does not exist
    at ErrorResponse (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:815:30)
    at handle (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:489:6)
    at Socket.data (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:324:9)
    at Socket.emit (node:events:508:20)
    at addChunk (node:internal/streams/readable:564:12)
    at readableAddChunkPushByteMode (node:internal/streams/readable:515:3)
    at Readable.push (node:internal/streams/readable:395:5)
    at TCP.onStreamRead (node:internal/stream_base_commons:189:23)
    at cachedError (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/query.js:170:23)
    at new Query (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/query.js:36:24)
    at sql (file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/index.js:112:11)
    at file:///C:/Users/blago/Desktop/oss2/xyp3rn-os-2-engine/research-intelligence/entrypoint.ts:72:43 {
  severity_local: 'ERROR',
  severity: 'ERROR',
  code: '42703',
  position: '62',
  file: 'parse_target.c',
  line: '1066',
  routine: 'checkInsertTargets'
}

Node.js v25.4.0
```

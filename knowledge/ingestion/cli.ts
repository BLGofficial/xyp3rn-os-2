import { parseArgs } from 'node:util';
import { connect } from '../../core/db/client.ts';
import type { SourceInput } from '../source-registry/acquire.ts';
import type { SourceOrigin } from '../quality/rubric.ts';
import { ingestSource } from './ingest.ts';

// Usage:
//   node knowledge/ingestion/cli.ts --file <path>  --origin first_party|third_party
//   node knowledge/ingestion/cli.ts --url <url>    --origin ...
//   node knowledge/ingestion/cli.ts --manual <text> --title <title> --origin ...
// Since 6D only --origin first_party is admitted (Promotion Gate, first-party admission); third_party
// is recorded as an error run — third-party material enters as research evidence instead.
// Exits 1 when the run ends in error (the run row still records why).

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    url: { type: 'string' },
    manual: { type: 'string' },
    title: { type: 'string' },
    origin: { type: 'string' },
  },
});

const origin = values.origin;
if (origin !== 'first_party' && origin !== 'third_party') {
  console.error('--origin first_party|third_party is required (reliability scoring depends on it)');
  process.exit(2);
}

const input: SourceInput | undefined = values.file
  ? { kind: 'file', path: values.file, origin: origin as SourceOrigin }
  : values.url
    ? { kind: 'url', url: values.url, origin: origin as SourceOrigin }
    : values.manual !== undefined && values.title
      ? { kind: 'manual', text: values.manual, title: values.title, origin: origin as SourceOrigin }
      : undefined;
if (!input) {
  console.error('one of --file, --url, or --manual with --title is required');
  process.exit(2);
}

const sql = connect(undefined, { max: 2 });
try {
  const result = await ingestSource(sql, input);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'error') process.exitCode = 1;
} finally {
  await sql.end();
}

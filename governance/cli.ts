import { writeFileSync } from 'node:fs';
import { connect } from '../core/db/client.ts';
import { provisionUser } from './auth.ts';
const [command, name, role, output] = process.argv.slice(2);
if (command !== 'user' || !name || !role || !output) throw new Error('Usage: node governance/cli.ts user <name> <viewer|operator|approver|admin> <token-file>');
const sql = connect();
try { const user = await provisionUser(sql, name, role); writeFileSync(output, user.token, { mode: 0o600, flag: 'wx' }); console.log(`Created 8-hour login token for ${name}; saved to ${output}.`); } finally { await sql.end(); }

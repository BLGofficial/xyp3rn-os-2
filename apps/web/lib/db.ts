import { connect } from '../../../core/db/client.ts';
export const sql=connect(undefined,{max:4,connect_timeout:3,idle_timeout:20});

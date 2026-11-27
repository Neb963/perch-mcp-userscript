import { issuedAt, maxFutureOperationMs, maxNewOperationAgeMs } from '../../../packages/contracts/src/operations-v2.js';
import { ApiError, canonical } from './common.js';
import type { SqlRecords } from './sql.js';

export interface OperationKeyRow { operationId: string; digest: string }
interface ExpiringRow extends OperationKeyRow { scope: string; key: string }
const table = 'operation_key_v2';
export function keyScope(connectorId: string, grantId: string, target: string): string {
  return canonical([connectorId, grantId, target]);
}
export class OperationKeys {
  constructor(private db: SqlRecords) {
    db.query(`CREATE TABLE IF NOT EXISTS ${table} (
      scope TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL,
      operationId TEXT NOT NULL, retainUntil INTEGER NOT NULL,
      PRIMARY KEY (scope, key)) WITHOUT ROWID`);
    db.query(`CREATE INDEX IF NOT EXISTS operation_key_due_v2 ON ${table}(retainUntil, scope, key)`);
  }
  get(scope: string, key: string): OperationKeyRow | undefined {
    issuedAt(key);
    return this.db.query<{ operationId: string; digest: string }>(
      `SELECT operationId, digest FROM ${table} WHERE scope=? AND key=?`, scope, key)[0];
  }
  add(scope: string, key: string, operationDigest: string, operationId: string, at: number): void {
    if (!this.db.inTransaction) throw new Error('Operation key must commit with admission.');
    const timestamp = issuedAt(key);
    if (timestamp < at - maxNewOperationAgeMs || timestamp > at + maxFutureOperationMs)
      throw new ApiError('OPERATION_KEY_EXPIRED', 'Unseen operationKey is outside the admission window.', 409);
    this.db.query(`INSERT INTO ${table}(scope,key,digest,operationId,retainUntil) VALUES(?,?,?,?,?)`,
      scope, key, operationDigest, operationId, at + 7 * 86_400_000);
  }
  nextDue(): number | undefined {
    return this.db.query<{retainUntil: number}>(
      `SELECT retainUntil FROM ${table} ORDER BY retainUntil LIMIT 1`)[0]?.retainUntil;
  }
  maintain(now: number, retained: (operationId: string) => boolean): void {
    const rows = this.db.query<ExpiringRow & Record<string, string>>(
      `SELECT scope,key,operationId,digest FROM ${table} WHERE retainUntil<=? ORDER BY retainUntil LIMIT 32`, now);
    for (const row of rows) {
      if (retained(row.operationId))
        this.db.query(`UPDATE ${table} SET retainUntil=? WHERE scope=? AND key=?`, now + 86_400_000, row.scope, row.key);
      else this.db.query(`DELETE FROM ${table} WHERE scope=? AND key=?`, row.scope, row.key);
    }
  }
}

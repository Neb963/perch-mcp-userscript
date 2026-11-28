import { createHash } from 'node:crypto';
import { SqlRecords } from './sql.js';
import { OperationIndex } from './operation-index.js';
import type { BudgetOperation, BudgetVector } from './admission-budget.js';
import { ApiError, canonical } from './common.js';
import { blocksNewLease, blocksNewMutation, isTerminalViewportEffect } from '../../../packages/contracts/src/effect-policy.js';

export interface StoredOperation {
  phase: string; tool: string; sequence: number; createdAt: number; deadlineMs: number;
  terminalAt?: number; terminalNotified?: boolean; resolution?: unknown; result?: unknown;
  terminalErrorCode?: string; terminalResultDigest?: string; dispatchAttempt?: {id:string;reconcileAt:number}; args?: unknown;
}
export type CanonicalMode = 'legacy' | 'prepare' | 'native';
type Stage = 'BACKFILL' | 'VERIFY' | 'VERIFY_NATIVE' | 'READY' | 'NATIVE' | 'BLOCKED';
type Migration = { stage: string; cursor: string; generation: number; resumeStage:string|null; verification:string };
type Key = { key: string };
type NativeRow = Record<string, string | number | null | ArrayBuffer>;
const TYPED = {
  sequence: 'sequence', createdAt: 'created', deadlineMs: 'deadline', terminalAt: 'terminal',
  phase: 'phase', tool: 'tool', workspaceId: 'workspace', epoch: 'epoch',
  bindingRevision: 'binding', tabInstanceId: 'tab', argsDigest: 'digest',
  agentId: 'agent', traceId: 'trace', terminalNotified: 'notified', mutating: 'mutating',
} as const;
const NUMBERS = new Set(['sequence','createdAt','deadlineMs','terminalAt','epoch','bindingRevision']);
const BOOLEANS = new Set(['terminalNotified','mutating']);
const PHASES = ['ADMITTED','DISPATCHED','RUNNING','SUCCEEDED','REJECTED','UNKNOWN','PARTIAL','CANCELLED'];
const TERMINAL = ['SUCCEEDED','REJECTED','UNKNOWN','PARTIAL','CANCELLED'];
const PAYLOADS = ['args','result'] as const;
const INLINE_READ_ARGS_MAX_BYTES=512;
/** No native source or mutation arguments share the metadata row. Only
 * small nonmutating read selectors are eligible, with byte-sized and
 * schema-checked representation. The exact bytes remain canonical. */
function inlineReadArgs(value:StoredOperation):boolean {
  if(value.tool!=='read'||(value as {mutating?:unknown}).mutating!==false||
     !object(value.args))return false;
  const encoded=JSON.stringify(value.args);
  return typeof encoded==='string' &&
    new TextEncoder().encode(encoded).byteLength<=INLINE_READ_ARGS_MAX_BYTES;
}
const TABLE = 'operation_native_v2';
const RECOVERY = '(pending=1 OR hold=1 OR leaseBlock=1)';
const WEEK = 7 * 86400000;
const RESULT_MS = 600000;
const EMPTY_VERIFICATION={total:0,eligible:0,resultSize:0,activeCount:0,pendingCount:0,holdCount:0,leaseCount:0,lastTerminal:0};
type Verification=typeof EMPTY_VERIFICATION;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value,key);
function object(value:unknown): value is Record<string,unknown> { return !!value && typeof value==='object' && !Array.isArray(value); }
export function operationReceiptDigest(value:unknown):string {return createHash('sha256').update(canonical(value)).digest('hex');}
function corrupt(): never { throw new Error('SQLITE_RECORD_CORRUPT'); }
function parsed(value:unknown): unknown { if(typeof value!=='string')return corrupt();try{return JSON.parse(value);}catch{return corrupt();} }
function validate(value:unknown): asserts value is StoredOperation {
  if(!object(value)||!PHASES.includes(String(value.phase))||typeof value.tool!=='string'||
      !['sequence','createdAt','deadlineMs'].every(k=>typeof value[k]==='number'&&Number.isSafeInteger(value[k]))||
      (value.terminalAt!==undefined&&(typeof value.terminalAt!=='number'||!Number.isSafeInteger(value.terminalAt))))corrupt();
  const terminal=TERMINAL.includes(String(value.phase));
  if(terminal?(typeof value.terminalAt!=='number'||value.terminalAt<=0):value.terminalAt!==undefined)corrupt();
  if(value.terminalNotified&&!terminal)corrupt();
  for(const [field] of Object.entries(TYPED)) {
    if(!own(value,field)||value[field]===undefined||value[field]===null)continue;
    if(NUMBERS.has(field)? typeof value[field]!=='number'||!Number.isSafeInteger(value[field]) :
       BOOLEANS.has(field)? typeof value[field]!=='boolean' : typeof value[field]!=='string')corrupt();
  }
}
function shape(value:StoredOperation): Record<string,string|number|null> {
  validate(value);
  const input: Record<string,unknown> = {...value};
  const row: Record<string,string|number|null> = {};
  const presence:string[]=[];
  for(const [field,column] of Object.entries(TYPED)) {
    const v=input[field];
    row[column] = v===undefined||v===null? null : BOOLEANS.has(field)? Number(v) : v as string|number;
    if(own(input,field)&&v!==undefined)presence.push(field);
    delete input[field];
  }
  const inlineArgs=inlineReadArgs(value);
  if(!inlineArgs)delete input.args;
  delete input.result;
  row.context=JSON.stringify(input);row.presence=JSON.stringify(presence);
  row.hasArgs=Number(value.args!==undefined&&!inlineArgs);
  row.hasResult=Number(value.result!==undefined);
  const terminal=value.terminalAt??0;
  const active=terminal?0:1;
  const pending=terminal&&!value.terminalNotified?1:0;
  const retention=terminal&&value.terminalNotified&&
    (!['UNKNOWN','PARTIAL'].includes(value.phase)||value.resolution||isTerminalViewportEffect(value))?value.createdAt+WEEK:null;
  const error=(value.result as {error?:{code?:unknown}}|undefined)?.error?.code;
  const normalize=terminal&&!value.terminalErrorCode&&typeof error==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error);
  const deadlines:number[]=[];
  if(active&&value.dispatchAttempt) {if(typeof value.dispatchAttempt.id!=='string'||!Number.isSafeInteger(value.dispatchAttempt.reconcileAt))corrupt();deadlines.push(value.dispatchAttempt.reconcileAt);}
  if(active)deadlines.push(value.deadlineMs);
  if(terminal&&value.result!==undefined)deadlines.push(terminal+RESULT_MS);
  if(normalize)deadlines.push(0);
  if(retention!==null)deadlines.push(retention);
  return {...row,active,pending,hold:Number(blocksNewMutation(value)),leaseBlock:Number(blocksNewLease(value)||(active&&!!value.dispatchAttempt)),
    retention,due:deadlines.length?Math.min(...deadlines):null,
    argSize:JSON.stringify(value.args??{}).length,resultSize:JSON.stringify(value.result??null).length};
}
function decode<T extends StoredOperation>(row:NativeRow):T {
  const context=parsed(row.context), presence=parsed(row.presence);
  if(!object(context)||Object.keys(TYPED).some(k=>own(context,k))||!Array.isArray(presence)||new Set(presence).size!==presence.length||presence.some(k=>typeof k!=='string'||!own(TYPED,k)))corrupt();
  const value:Record<string,unknown>={...context};
  for(const [field,column]of Object.entries(TYPED)) {
    if(!presence.includes(field))continue;
    const v=row[column];
    value[field]=v===null?null:BOOLEANS.has(field)?v===1:v;
  }
  for(const kind of PAYLOADS) {
    const has=row[kind==='args'?'hasArgs':'hasResult'];
    const payload=row[kind+'Value'];
    if(has!==0&&has!==1)corrupt();
    if(has===1){
      if(payload===null||payload===undefined||own(context,kind))corrupt();
      value[kind]=parsed(payload);
    } else if(payload!==null&&payload!==undefined)corrupt();
    if(kind==='args'&&has===0&&own(context,'args')&&!inlineReadArgs(value as StoredOperation))
      corrupt();
    if(kind==='result'&&own(context,'result'))corrupt();
  }
  validate(value);
  return value as T;
}
/** Canonical operation rows. Legacy records remain authoritative until a verified atomic marker. */
export class OperationStore<T extends StoredOperation> {
  private stage:Stage|undefined;
  private legacyIndex?:OperationIndex<T>;
  private initialized=false;
  constructor(private db:SqlRecords,private mode:CanonicalMode='legacy') {
    if(!['legacy','prepare','native'].includes(mode))throw new Error('INVALID_CANONICAL_STORAGE_MODE');
    const exists=db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_migration_v2'").length>0;
    if(exists) {
      const state=this.migration();
      if(!state||!['BACKFILL','VERIFY','VERIFY_NATIVE','READY','NATIVE','BLOCKED'].includes(state.stage)||state.generation!==2)
        throw new Error('SQLITE_SCHEMA_INCOMPATIBLE');
      if(state.stage==='NATIVE'&&db.get<number>('schema')!==2)throw new Error('SQLITE_SCHEMA_INCOMPATIBLE');
      this.stage=state.stage as Stage;this.initialized=true;
    } else if(mode!=='legacy')this.prepare();
    // Initialize legacy projection outside admission transactions. A later
    // rejected admission must not roll back DDL behind a cached index object.
    if(!this.native) {
      const empty=db.query("SELECT key FROM records WHERE key>=? AND key<? LIMIT 1",'operation/','operation/\uffff').length===0;
      const ready=mode==='legacy'||empty||(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_index_state_v1'").length>0&&db.query("SELECT id FROM operation_index_state_v1 WHERE id=1").length>0);
      if(ready)this.legacyIndex=new OperationIndex<T>(db);
    }
  }
  get native():boolean {return this.stage==='NATIVE';}
  get blocked():boolean {return this.stage==='BLOCKED';}
  get journalReady():boolean {return this.native||this.legacyIndex!==undefined;}
  get migrating():boolean {return this.initialized&&!this.native&&!this.blocked&&this.mode!=='legacy'&&(this.stage!=='READY'||this.mode==='native');}
  private legacy():OperationIndex<T> {if(!this.legacyIndex)throw new ApiError('GATEWAY_DEGRADED','Legacy operation index is unavailable while bounded storage migration prepares its authority; preserve pending browser replies and retry after migration.',503);return this.legacyIndex;}
  private migration():Migration|undefined {return this.db.query<Migration>("SELECT stage,cursor,generation,resumeStage,verification FROM operation_migration_v2 WHERE id=1")[0];}
  progress():Record<string,unknown> {const state=this.initialized?this.migration():undefined;return state?{...state,authority:state.stage==='NATIVE'?'native':'legacy'}:{stage:'LEGACY',authority:'legacy'};}
  refreshMigrationState():void {if(this.initialized){const state=this.migration();if(!state||!['BACKFILL','VERIFY','VERIFY_NATIVE','READY','NATIVE','BLOCKED'].includes(state.stage)||state.generation!==2)throw new Error('SQLITE_SCHEMA_INCOMPATIBLE');this.stage=state.stage as Stage;}}
  blockMigration():void {if(!this.initialized||this.native||this.blocked)return;const state=this.migration();this.db.query("UPDATE operation_migration_v2 SET stage='BLOCKED',resumeStage=? WHERE id=1",state?.stage??'BACKFILL');this.stage='BLOCKED';}
  private prepare():void {
    this.db.transaction(()=>{
      this.db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
        key TEXT PRIMARY KEY,receiptDigest TEXT,sequence INTEGER NOT NULL,created INTEGER NOT NULL,deadline INTEGER NOT NULL,terminal INTEGER,
        phase TEXT NOT NULL CHECK(phase IN ('ADMITTED','DISPATCHED','RUNNING','SUCCEEDED','REJECTED','UNKNOWN','PARTIAL','CANCELLED')),
        tool TEXT NOT NULL,workspace TEXT,epoch INTEGER,binding INTEGER,tab TEXT,digest TEXT,agent TEXT,trace TEXT,
        notified INTEGER CHECK(notified IS NULL OR notified IN (0,1)),mutating INTEGER CHECK(mutating IS NULL OR mutating IN (0,1)),
        context TEXT NOT NULL,presence TEXT NOT NULL,hasArgs INTEGER NOT NULL CHECK(hasArgs IN (0,1)),hasResult INTEGER NOT NULL CHECK(hasResult IN (0,1)),active INTEGER NOT NULL CHECK(active IN (0,1)),pending INTEGER NOT NULL CHECK(pending IN (0,1)),hold INTEGER NOT NULL CHECK(hold IN (0,1)),
        leaseBlock INTEGER NOT NULL CHECK(leaseBlock IN (0,1)),retention INTEGER,due INTEGER,argSize INTEGER NOT NULL CHECK(argSize>=0),resultSize INTEGER NOT NULL CHECK(resultSize>=0)) WITHOUT ROWID`);
      for(const kind of PAYLOADS)this.db.query(`CREATE TABLE IF NOT EXISTS operation_${kind}_v2 (key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID`);
      this.db.query('CREATE TABLE IF NOT EXISTS operation_native_stats_v2 (id INTEGER PRIMARY KEY,total INTEGER NOT NULL,eligible INTEGER NOT NULL,resultSize INTEGER NOT NULL,activeCount INTEGER NOT NULL,pendingCount INTEGER NOT NULL,holdCount INTEGER NOT NULL,leaseCount INTEGER NOT NULL,lastTerminal INTEGER NOT NULL)');
      this.db.query('INSERT OR IGNORE INTO operation_native_stats_v2 VALUES(1,0,0,0,0,0,0,0,0)');
      this.db.query('CREATE TABLE IF NOT EXISTS operation_migration_dirty_v2 (key TEXT PRIMARY KEY) WITHOUT ROWID');
      this.db.query('CREATE TABLE IF NOT EXISTS operation_migration_v2 (id INTEGER PRIMARY KEY,stage TEXT NOT NULL,cursor TEXT NOT NULL,generation INTEGER NOT NULL,resumeStage TEXT,verification TEXT NOT NULL)');
      this.db.query("INSERT OR IGNORE INTO operation_migration_v2 VALUES(1,'BACKFILL','',2,NULL,?)",JSON.stringify(EMPTY_VERIFICATION));
      this.db.query(`CREATE INDEX IF NOT EXISTS operation_native_active_v2 ON ${TABLE}(active,sequence) WHERE active=1`);
      this.db.query(`CREATE INDEX IF NOT EXISTS operation_native_recovery_v2 ON ${TABLE}(created) WHERE ${RECOVERY}`);
      this.db.query(`CREATE INDEX IF NOT EXISTS operation_native_due_v2 ON ${TABLE}(due) WHERE due IS NOT NULL`);
      // Active operations have terminal=NULL. Keep them out of the terminal
      // ordering index so admitting/dispatching an operation cannot rewrite
      // that B-tree before a genuine terminal transition. Existing old-index
      // databases remain compatible; IF NOT EXISTS never replaces them.
      this.db.query(`CREATE INDEX IF NOT EXISTS operation_native_terminal_v2 ON ${TABLE}(terminal DESC) WHERE terminal IS NOT NULL`);
      this.db.query(`CREATE INDEX IF NOT EXISTS operation_native_retention_v2 ON ${TABLE}(retention) WHERE retention IS NOT NULL`);
      for(const [event,row]of [['INSERT','NEW'],['DELETE','OLD']]as const) {
        this.db.query(`CREATE TRIGGER IF NOT EXISTS operation_migration_${event.toLowerCase()}_v2 AFTER ${event} ON records WHEN ${row}.key LIKE 'operation/%' BEGIN INSERT INTO operation_migration_dirty_v2 VALUES(${row}.key) ON CONFLICT(key) DO NOTHING; END`);
        this.db.query(`CREATE TRIGGER IF NOT EXISTS operation_native_fence_${event.toLowerCase()}_v2 BEFORE ${event} ON records WHEN ${row}.key LIKE 'operation/%' AND (SELECT stage FROM operation_migration_v2 WHERE id=1)='NATIVE' BEGIN SELECT RAISE(ABORT,'INCOMPATIBLE_OPERATION_WRITER'); END`);
      }
      this.db.query("CREATE TRIGGER IF NOT EXISTS operation_migration_update_v2 AFTER UPDATE ON records BEGIN INSERT INTO operation_migration_dirty_v2 SELECT OLD.key WHERE OLD.key LIKE 'operation/%' ON CONFLICT(key) DO NOTHING; INSERT INTO operation_migration_dirty_v2 SELECT NEW.key WHERE NEW.key LIKE 'operation/%' ON CONFLICT(key) DO NOTHING; END");
      this.db.query("CREATE TRIGGER IF NOT EXISTS operation_native_fence_update_v2 BEFORE UPDATE ON records WHEN (OLD.key LIKE 'operation/%' OR NEW.key LIKE 'operation/%') AND (SELECT stage FROM operation_migration_v2 WHERE id=1)='NATIVE' BEGIN SELECT RAISE(ABORT,'INCOMPATIBLE_OPERATION_WRITER'); END");
      this.db.query(`CREATE TRIGGER IF NOT EXISTS operation_native_stats_insert_v2 AFTER INSERT ON ${TABLE} BEGIN UPDATE operation_native_stats_v2 SET total=total+1,eligible=eligible+(NEW.retention IS NOT NULL),resultSize=resultSize+NEW.resultSize,activeCount=activeCount+NEW.active,pendingCount=pendingCount+NEW.pending,holdCount=holdCount+NEW.hold,leaseCount=leaseCount+NEW.leaseBlock,lastTerminal=MAX(lastTerminal,COALESCE(NEW.terminal,0)) WHERE id=1; END`);
      this.db.query(`CREATE TRIGGER IF NOT EXISTS operation_native_stats_delete_v2 AFTER DELETE ON ${TABLE} BEGIN UPDATE operation_native_stats_v2 SET total=total-1,eligible=eligible-(OLD.retention IS NOT NULL),resultSize=resultSize-OLD.resultSize,activeCount=activeCount-OLD.active,pendingCount=pendingCount-OLD.pending,holdCount=holdCount-OLD.hold,leaseCount=leaseCount-OLD.leaseBlock,lastTerminal=COALESCE((SELECT terminal FROM ${TABLE} WHERE terminal IS NOT NULL ORDER BY terminal DESC LIMIT 1),0) WHERE id=1; END`);
      this.db.query(`CREATE TRIGGER IF NOT EXISTS operation_native_stats_update_v2 AFTER UPDATE ON ${TABLE} WHEN OLD.resultSize<>NEW.resultSize OR (OLD.retention IS NULL)<>(NEW.retention IS NULL) OR OLD.active<>NEW.active OR OLD.pending<>NEW.pending OR OLD.hold<>NEW.hold OR OLD.leaseBlock<>NEW.leaseBlock OR OLD.terminal IS NOT NEW.terminal BEGIN UPDATE operation_native_stats_v2 SET eligible=eligible+(NEW.retention IS NOT NULL)-(OLD.retention IS NOT NULL),resultSize=resultSize+NEW.resultSize-OLD.resultSize,activeCount=activeCount+NEW.active-OLD.active,pendingCount=pendingCount+NEW.pending-OLD.pending,holdCount=holdCount+NEW.hold-OLD.hold,leaseCount=leaseCount+NEW.leaseBlock-OLD.leaseBlock,lastTerminal=COALESCE((SELECT terminal FROM ${TABLE} WHERE terminal IS NOT NULL ORDER BY terminal DESC LIMIT 1),0) WHERE id=1; END`);
    });
    this.initialized=true;this.stage='BACKFILL';
  }
  private legacyPartsPresent(key:string):boolean {
    // Legacy writers used <=32k UTF-16 units per part. Preflight a bounded
    // metadata page before loading bytes; corrupt/oversized records remain intact.
    // 4 MiB exceeds args + retained reply + late observation accepted by the
    // 512 KiB HTTP boundary, including legacy metadata; it raises no wire limit.
    const parts=this.db.query<{part:number;chars:number;bytes:number}>("SELECT part,length(value) AS chars,length(CAST(value AS BLOB)) AS bytes FROM records WHERE key=? ORDER BY part LIMIT 134",key);
    if(!parts.length)return false;
    if(parts.length>133||parts.some((p,n)=>p.part!==n||p.chars>32000)||parts.reduce((n,p)=>n+p.bytes,0)>4*1024*1024)corrupt();
    return true;
  }
  private readLegacy(key:string):T|undefined {
    if(!this.legacyPartsPresent(key))return undefined;
    const value=this.db.get<T>(key);validate(value);
    const record=value as StoredOperation&{operationId?:unknown};
    if(record.operationId!==undefined&&key!=="operation/"+record.operationId)corrupt();
    return value;
  }
  private verifyNative(key:string,legacy:T):Record<string,string|number|null> {
    const row=this.db.query<NativeRow>(`SELECT o.*,a.value AS argsValue,r.value AS resultValue FROM ${TABLE} o LEFT JOIN operation_args_v2 a USING(key) LEFT JOIN operation_result_v2 r USING(key) WHERE o.key=?`,key)[0];
    if(!row||canonical(legacy)!==canonical(decode<T>(row)))corrupt();
    const expected=shape(legacy);
    expected.receiptDigest=legacy.terminalResultDigest??(legacy.terminalAt&&legacy.result!==undefined?operationReceiptDigest(legacy.result):null);
    if(Object.entries(expected).some(([column,v])=>row[column]!==v))corrupt();
    return expected;
  }
  private verifyStats(expected:Verification):void {
    const actual=this.db.query<Verification>('SELECT total,eligible,resultSize,activeCount,pendingCount,holdCount,leaseCount,lastTerminal FROM operation_native_stats_v2 WHERE id=1')[0];
    if(!actual||Object.entries(expected).some(([column,v])=>actual[column as keyof Verification]!==v))corrupt();
  }
  private readNative(key:string):T|undefined {
    const row=this.db.query<NativeRow>(`SELECT o.*,a.value AS argsValue,r.value AS resultValue FROM ${TABLE} o LEFT JOIN operation_args_v2 a USING(key) LEFT JOIN operation_result_v2 r USING(key) WHERE o.key=?`,key)[0];
    return row?decode<T>(row):undefined;
  }
  get(key:string):T|undefined {return this.native?this.readNative(key):this.initialized?this.readLegacy(key):this.db.get<T>(key);}
  receiptDigest(key:string):string|undefined {return this.native?this.db.query<{receiptDigest:string|null}>(`SELECT receiptDigest FROM ${TABLE} WHERE key=?`,key)[0]?.receiptDigest??undefined:undefined;}
  put(key:string,value:T):void {if(this.native)this.db.transaction(()=>this.writeNative(key,value,true));else this.db.put(key,value);}
  delete(key:string):void {if(this.native)this.db.transaction(()=>this.deleteNative(key));else this.db.delete(key);}
  private deleteNative(key:string):void {
    for(const kind of PAYLOADS)this.db.query(`DELETE FROM operation_${kind}_v2 WHERE key=?`,key);
    this.db.query(`DELETE FROM ${TABLE} WHERE key=?`,key);
  }
  private writeNative(key:string,value:T,guard=false):void {
    const next=shape(value);
    const record=value as StoredOperation&{operationId?:unknown};
    if(record.operationId!==undefined&&key!=='operation/'+record.operationId)corrupt();
    const previous=this.db.query<NativeRow>(`SELECT * FROM ${TABLE} WHERE key=?`,key)[0];
    next.receiptDigest=value.terminalResultDigest??(value.terminalAt&&value.result!==undefined?operationReceiptDigest(value.result):(guard&&typeof previous?.receiptDigest==='string'?previous.receiptDigest:null));
    if(guard&&previous) {
      // A stale asynchronous caller cannot rewrite a terminal phase or scope.
      const from=String(previous.phase),to=value.phase;
      const allowed=from==='ADMITTED'?['ADMITTED','DISPATCHED','REJECTED','CANCELLED','UNKNOWN']:
        from==='DISPATCHED'?['DISPATCHED','RUNNING',...TERMINAL]:from==='RUNNING'?['RUNNING',...TERMINAL]:[from];
      if(previous.terminal!==null) {
        if(next.terminal!==previous.terminal||Number(previous.notified)===1&&Number(next.notified)!==1)throw new Error('SQLITE_OPERATION_CONFLICT');
        if(value.result!==undefined&&typeof previous.receiptDigest==='string'&&operationReceiptDigest(value.result)!==previous.receiptDigest)throw new Error('SQLITE_OPERATION_CONFLICT');
      }
      if(value.result!==undefined&&value.terminalResultDigest&&value.terminalResultDigest!==operationReceiptDigest(value.result))throw new Error('SQLITE_OPERATION_CONFLICT');
      if(!allowed.includes(to)||['workspace','epoch','binding','tab','digest','agent','trace','sequence','created','deadline','tool'].some(k=>previous[k]!==next[k]))throw new Error('SQLITE_OPERATION_CONFLICT');
    }
    if(!previous) {
      const columns=['key',...Object.keys(next)];
      this.db.query(`INSERT INTO ${TABLE} (${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`,key,...Object.values(next));
    } else {
      const changed=Object.entries(next).filter(([column,v])=>previous[column]!==v);
      if(changed.length)this.db.query(`UPDATE ${TABLE} SET ${changed.map(([column])=>column+'=?').join(',')} WHERE key=?`,...changed.map(([,v])=>v),key);
    }
    for(const kind of PAYLOADS) {
      // A new small read selector is already preserved in context. Avoid
      // writing an extra argument row; migrate older external rows only when
      // necessary. No result, mutation or oversized argument is ever inline.
      const external=kind==='args'?next.hasArgs===1:next.hasResult===1;
      if(external)this.db.query(`INSERT INTO operation_${kind}_v2 VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value`,key,JSON.stringify(value[kind]));
      else if(previous?.[kind==='args'?'hasArgs':'hasResult']===1)
        this.db.query(`DELETE FROM operation_${kind}_v2 WHERE key=?`,key);
    }
  }
  /** One transaction, at most 16 logical records and 1 MiB JSON plus one accepted record. */
  prepareStep(limit=16):Record<string,unknown> {
    if(!this.migrating)return this.progress();
    if(!Number.isSafeInteger(limit)||limit<1||limit>16)throw new Error('INVALID_MIGRATION_LIMIT');
    let completed:Stage|undefined;
    try {this.db.transaction(()=>{
      const state=this.migration();if(!state)throw new Error('SQLITE_SCHEMA_INCOMPATIBLE');
      let stage=state.stage as Stage,cursor=state.cursor;
      const rawVerification=parsed(state.verification);
      if(!object(rawVerification)||Object.keys(EMPTY_VERIFICATION).some(k=>!Number.isSafeInteger(rawVerification[k])||Number(rawVerification[k])<0))corrupt();
      let verification=rawVerification as Verification;
      const dirty=this.db.query<Key>('SELECT key FROM operation_migration_dirty_v2 ORDER BY key LIMIT ?',limit);
      let work=0,bytes=0;
      for(const {key}of dirty) {
        const value=this.readLegacy(key);
        const size=value===undefined?0:new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if(work&&bytes+size>1024*1024)break;
        if(value===undefined){this.deleteNative(key);if(this.readNative(key)!==undefined)corrupt();}
        else{validate(value);this.writeNative(key,value);this.verifyNative(key,value);}
        this.db.query('DELETE FROM operation_migration_dirty_v2 WHERE key=?',key);
        work++;bytes+=size;
      }
      if(work){
        if(stage==='VERIFY_NATIVE'||stage==='READY')this.db.query("UPDATE operation_migration_v2 SET stage='VERIFY_NATIVE',cursor='',verification=? WHERE id=1",JSON.stringify(EMPTY_VERIFICATION));
        return;
      }
      if(stage==='READY') {
        if(this.mode==='native') {
          this.verifyStats(verification);
          // All copies and both verification traversals are complete, and no
          // legacy mutation can interleave with this durable authority switch.
          this.db.put('schema',2);
          this.db.query("UPDATE operation_migration_v2 SET stage='NATIVE',cursor='' WHERE id=1");
          completed='NATIVE';
        }
        return;
      }
      const rows=stage==='VERIFY_NATIVE'?
        this.db.query<Key>(`SELECT key FROM ${TABLE} WHERE key>? ORDER BY key LIMIT ?`,cursor,limit):
        this.db.query<Key>("SELECT DISTINCT key FROM records WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?",'operation/','operation/\uffff',cursor,limit);
      for(const {key}of rows) {
        const legacy=this.readLegacy(key);
        if(legacy===undefined)corrupt();
        const size=new TextEncoder().encode(JSON.stringify(legacy)).byteLength;
        if(work&&bytes+size>1024*1024)break;
        validate(legacy);
        if(stage==='BACKFILL')this.writeNative(key,legacy);
        else {const expected=this.verifyNative(key,legacy);
          if(stage==='VERIFY_NATIVE') {
            verification={total:verification.total+1,eligible:verification.eligible+Number(expected.retention!==null),resultSize:verification.resultSize+Number(expected.resultSize),
              activeCount:verification.activeCount+Number(expected.active),pendingCount:verification.pendingCount+Number(expected.pending),holdCount:verification.holdCount+Number(expected.hold),leaseCount:verification.leaseCount+Number(expected.leaseBlock),
              lastTerminal:Math.max(verification.lastTerminal,Number(expected.terminal??0))};
          }
        }
        cursor=key;work++;bytes+=size;
      }
      if(!rows.length){
        if(stage==='VERIFY_NATIVE')this.verifyStats(verification);
        stage=stage==='BACKFILL'?'VERIFY':stage==='VERIFY'?'VERIFY_NATIVE':'READY';cursor='';
        if(stage==='VERIFY_NATIVE')verification={...EMPTY_VERIFICATION};
      }
      this.db.query('UPDATE operation_migration_v2 SET stage=?,cursor=?,verification=? WHERE id=1',stage,cursor,JSON.stringify(verification));
      completed=stage;
    });
    } catch(error) {
      if(error instanceof Error&&error.message==='SQLITE_RECORD_CORRUPT') {
        this.blockMigration();
      }
      throw error;
    }
    if(completed)this.stage=completed;else this.refreshMigrationState();
    return this.progress();
  }
  resumeMigration():Record<string,unknown> {
    if(!this.blocked)return this.progress();
    const state=this.migration();
    if(!state||!['BACKFILL','VERIFY','VERIFY_NATIVE','READY'].includes(state.resumeStage??''))throw new Error('SQLITE_SCHEMA_INCOMPATIBLE');
    this.db.query('UPDATE operation_migration_v2 SET stage=?,resumeStage=NULL WHERE id=1',state.resumeStage);
    this.stage=state.resumeStage as Stage;
    return this.progress();
  }
  private keys(sql:string,...args:number[]):Key[] {return this.db.query<Key>(sql,...args);}
  private load(rows:Key[]):T[] {return rows.map(({key})=>{const op=this.get(key);if(!op)corrupt();return op;});}
  retainedOperationSummary():{retainedOperations:number;retainedResultBytes:number} {
    if(this.native) {
      const row=this.db.query<{total:number;resultSize:number}>('SELECT total,resultSize FROM operation_native_stats_v2 WHERE id=1')[0];
      if(!row||!Number.isSafeInteger(row.total)||row.total<0||!Number.isSafeInteger(row.resultSize)||row.resultSize<0)corrupt();
      return {retainedOperations:row.total,retainedResultBytes:row.resultSize*4};
    }
    const stats=this.legacy().stats(),obligations=this.legacy().obligationKeys();
    return {retainedOperations:stats.eligible+obligations.length,retainedResultBytes:stats.resultSize*4};
  }
  /** A rollover reads bounded obligation metadata, never retained result bodies. */
  budgetObligations():BudgetOperation[] {
    let keys:Key[];
    if(this.native) {
      const stats=this.db.query<{activeCount:number;pendingCount:number;holdCount:number}>('SELECT activeCount,pendingCount,holdCount FROM operation_native_stats_v2 WHERE id=1')[0];
      if(!stats||Object.values(stats).some(v=>!Number.isSafeInteger(v)||v<0)||stats.activeCount>8||stats.pendingCount>128||stats.holdCount>128)corrupt();
      const active=this.keys(`SELECT key FROM ${TABLE} WHERE active=1 ORDER BY sequence LIMIT 9`);
      const pending=this.keys(`SELECT key FROM ${TABLE} WHERE ${RECOVERY} AND pending=1 ORDER BY created LIMIT 129`);
      const held=this.keys(`SELECT key FROM ${TABLE} WHERE ${RECOVERY} AND hold=1 ORDER BY created LIMIT 129`);
      keys=[...new Map([...active,...pending,...held].map(row=>[row.key,row])).values()];
    }else keys=this.legacy().obligationKeys();
    return keys.map(({key})=>{
      let row:{tool:string;args:string|null;reservation:string|null}|undefined;
      if(this.native)row=this.db.query<{tool:string;args:string|null;reservation:string|null}>(`SELECT o.tool,COALESCE(a.value,json_extract(o.context,'$.args')) AS args,json_extract(o.context,'$.budgetReservation') AS reservation FROM ${TABLE} o LEFT JOIN operation_args_v2 a USING(key) WHERE o.key=?`,key)[0];
      else {
        if(!this.legacyPartsPresent(key))corrupt();
        row=this.db.query<{tool:string;args:string|null;reservation:string|null}>("SELECT json_extract(value,'$.tool') AS tool,json_extract(value,'$.args') AS args,json_extract(value,'$.budgetReservation') AS reservation FROM (SELECT group_concat(value,'') AS value FROM (SELECT value FROM records WHERE key=? ORDER BY part))",key)[0];
      }
      if(!row||typeof row.tool!=='string')corrupt();
      const result:BudgetOperation={tool:row.tool};
      if(row.args!==null){const args=parsed(row.args);if(!object(args))corrupt();result.args=args;}
      if(row.reservation!==null)result.budgetReservation=parsed(row.reservation) as BudgetVector;
      return result;
    });
  }
  activeStats():{argSize:number}[] {return this.native?this.db.query<{argSize:number}>(`SELECT argSize FROM ${TABLE} WHERE active=1 ORDER BY sequence LIMIT 9`):this.legacy().activeStats();}
  running():boolean {return this.native?this.keys(`SELECT key FROM ${TABLE} WHERE active=1 AND phase IN ('DISPATCHED','RUNNING') ORDER BY sequence LIMIT 1`).length>0:this.legacy().running();}
  workAvailable():boolean{return this.native?this.keys(`SELECT key FROM ${TABLE} WHERE active=1 AND phase='ADMITTED' ORDER BY sequence LIMIT 1`).length>0:this.legacy().admittedExists();}
  nextAdmitted():T|undefined {return this.native?this.load(this.keys(`SELECT key FROM ${TABLE} WHERE active=1 AND phase='ADMITTED' ORDER BY sequence LIMIT 1`))[0]:this.legacy().nextAdmitted();}
  pendingKeys():Key[] {return this.native?this.keys(`SELECT key FROM ${TABLE} WHERE ${RECOVERY} AND pending=1 ORDER BY created LIMIT 32`):this.legacy().pendingKeys();}
  private count(column:'pendingCount'|'holdCount'|'leaseCount'):number {const row=this.db.query<{count:number}>(`SELECT ${column} AS count FROM operation_native_stats_v2 WHERE id=1`)[0];if(!row||!Number.isSafeInteger(row.count)||row.count<0)corrupt();return row.count;}
  pendingExists():boolean{return this.native?this.count('pendingCount')>0:this.legacy().pendingExists();}
  pendingFull():boolean{return this.native?this.count('pendingCount')>=128:this.legacy().pendingFull();}
  holds():boolean{return this.native?this.count('holdCount')>0:this.legacy().holds();}
  holdsFull():boolean{return this.native?this.count('holdCount')>=128:this.legacy().holdsFull();}
  /** One canonical capacity snapshot for synchronous admission. Native counts
   * share one durable SQLite row; there is no await between the capacity check
   * and the atomic admission commit. Legacy keeps its original index methods. */
  admissionCaps():{pendingFull:boolean;holdsFull:boolean;holds:boolean} {
    if(!this.native) {
      const old=this.legacy();
      return {pendingFull:old.pendingFull(),holdsFull:old.holdsFull(),holds:old.holds()};
    }
    const row=this.db.query<{pendingCount:number;holdCount:number}>(
      'SELECT pendingCount,holdCount FROM operation_native_stats_v2 WHERE id=1')[0];
    if(!row || !Number.isSafeInteger(row.pendingCount) || row.pendingCount<0 ||
        !Number.isSafeInteger(row.holdCount) || row.holdCount<0)corrupt();
    return {pendingFull:row.pendingCount>=128,holdsFull:row.holdCount>=128,holds:row.holdCount>0};
  }
  leaseBlocked():boolean{return this.native?this.count('leaseCount')>0:this.legacy().leaseBlocked();}
  leaseBlockers():T[]{return this.native?this.load(this.keys(`SELECT key FROM ${TABLE} WHERE ${RECOVERY} AND leaseBlock=1 ORDER BY created LIMIT 128`)):this.legacy().leaseBlockers();}
  due(now:number):T[]{return this.native?this.load(this.keys(`SELECT key FROM ${TABLE} WHERE active=1 AND due<=? ORDER BY sequence LIMIT 9`,now)).concat(this.load(this.keys(`SELECT key FROM ${TABLE} WHERE active=0 AND due IS NOT NULL AND due<=? ORDER BY due LIMIT 128`,now))):this.legacy().due(now);}
  nextDue():number|undefined{return this.native?this.db.query<{due:number}>(`SELECT due FROM ${TABLE} WHERE due IS NOT NULL ORDER BY due LIMIT 1`)[0]?.due:this.legacy().nextDue();}
  lastActivityAt():number{return this.native?this.db.query<{lastTerminal:number}>('SELECT lastTerminal FROM operation_native_stats_v2 WHERE id=1')[0]!.lastTerminal:this.legacy().lastActivityAt();}
  stats():{eligible:number;resultSize:number}{return this.native?this.db.query<{eligible:number;resultSize:number}>('SELECT eligible,resultSize FROM operation_native_stats_v2 WHERE id=1')[0]!:this.legacy().stats();}
  excessRetention():Key[]{if(!this.native)return this.legacy().excessRetention();const excess=Math.max(0,this.stats().eligible-1000);return excess?this.keys(`SELECT key FROM ${TABLE} WHERE retention IS NOT NULL ORDER BY retention LIMIT ?`,Math.min(excess,128)):[];}
}

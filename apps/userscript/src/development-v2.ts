import { browserToolSchemas, developmentToolArgs, type BatchArgumentsV2, type BrowserToolArgs,
  type BrowserToolV2, batchEvidenceReserve, batchResultBudget, hasEffectV2, pathMatchesRules, preflightDevelopmentBatch, requiredPermissionsV2 } from '../../../packages/contracts/src/development-v2.js';
import { ToolError } from '../../../packages/contracts/src/errors.js';
import type { BrowserEnvelopeV2, SegmentRequest } from '../../../packages/contracts/src/operations-v2.js';
import { filesystemV2Schemas, type FilesystemToolV2 } from '../../../packages/contracts/src/filesystem-v2.js';
import { ExecutionError, type ComputeWorkerClient } from './compute.js';
import { FilesystemV2, type FilesystemCallScope } from './filesystem-v2.js';
import { BrowserError, bytesToBase64, canonicalPath, digest, equalBytes } from './native-types.js';
import type { VirtualFileSystem } from './vfs.js';
import { fetchPublic, validatePublicFetchUrl } from './public-fetch.js';
import { readPublicGenerator } from './public-generator.js';

export interface DevelopmentContext {
  envelope: BrowserEnvelopeV2;
  vfs: VirtualFileSystem;
  signal: AbortSignal;
  assertCurrent: () => Promise<void>;
  permit(kind: SegmentRequest['kind'], digest: string): Promise<void>;
  recordStep(step: Omit<BatchStep, 'result'>): Promise<void>;
  additional(name: BrowserToolV2, args: Record<string, unknown>, scope: FilesystemCallScope): Promise<unknown>;
}
const utf8 = new TextEncoder();
const native = (path: string) => !path.startsWith('scratch/') && !path.startsWith('imports/');
const effectError = (code: string, message: string, effect: 'NONE' | 'PARTIAL' | 'UNKNOWN') => new ExecutionError(code,message,effect);

async function scopedCompute(args: BrowserToolArgs<'execute_js'>, context: DevelopmentContext,
  engine: ComputeWorkerClient) {
  const readRules = args.access.read ?? [], writeRules = args.access.write ?? [];
  if (writeRules.some(path => path.startsWith('imports/')))
    throw new BrowserError('PATH_DENIED','Imports are read-only.');
  const includesNative = [...readRules, ...writeRules].some(native);
  if (readRules.length || writeRules.length || args.modules?.length)
    await context.permit('read-view', await digest(JSON.stringify([context.envelope.target, readRules, writeRules])));
  const localView = await context.vfs.localView();
  const pre = includesNative ? await context.vfs.snapshot() : null;
  const list = [...new Set([...Object.keys(pre?.files ?? {}), ...localView.files.map(file=>file.path)])].sort();
  const reads = new Map<string, Uint8Array>();
  const maxBytes = args.access.maxBytes ?? 16 * 1024 * 1024;
  const read = async (path: string) => {
    await context.assertCurrent();
    canonicalPath(path);
    if (!pathMatchesRules(path, readRules)) throw new BrowserError('SCOPE_DENIED','Guest read is outside declared access.');
    if (++readCount > (args.access.maxReads ?? 256)) throw new BrowserError('LIMIT_EXCEEDED','Guest read count exceeded.');
    let value = reads.get(path);
    if (!value) {
      value = native(path) ? pre?.files[path] : await localView.read(path);
      if (!value) throw new BrowserError('FILE_NOT_FOUND','Guest file does not exist.');
      loadedBytes += value.length;
      if (loadedBytes > maxBytes) throw new BrowserError('LIMIT_EXCEEDED','Guest read-view byte budget exceeded.');
      reads.set(path,value);
    }
    return value.slice();
  };
  let readCount = 0, loadedBytes = 0;
  const revision = pre?.revision ?? localView.revision.value;
  const modules: Record<string, string> = Object.create(null);
  let moduleBytes = 0;
  for (const module of args.modules ?? []) {
    if (Object.hasOwn(modules, module.specifier)) throw new BrowserError('INVALID_INPUT','Duplicate pinned module.');
    const bytes = await read(module.path);
    moduleBytes += bytes.length;
    if (bytes.length > 262_144 || moduleBytes > 524_288) throw new BrowserError('LIMIT_EXCEEDED','Pinned modules exceed their byte budget.');
    if (await digest(bytes) !== module.sha256) throw new BrowserError('STALE_REVISION','Pinned module digest changed.');
    modules[module.specifier] = new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  return engine.execute({
    js: args.js, modules, signal: context.signal, maxStagedBytes: maxBytes,
    timeoutMs: Math.min(args.timeoutMs ?? 30_000, context.envelope.deadlineMs - Date.now()),
    files: {
      revision: async () => revision,
      read,
      list: async () => {
        await context.assertCurrent();
        if (++readCount > (args.access.maxReads ?? 256)) throw new BrowserError('LIMIT_EXCEEDED','Guest read count exceeded.');
        return list.filter(path=>pathMatchesRules(path,readRules));
      },
      writeBatch: async (writes, expectedRevision) => {
        await context.assertCurrent();
        if (expectedRevision !== revision || !writes.length || writes.length > (args.access.maxWrites ?? 64))
          throw effectError('LIMIT_EXCEEDED','Guest write set is outside its declared bounds.','NONE');
        for (const entry of writes)
          if (!pathMatchesRules(canonicalPath(entry.path),writeRules)) throw effectError('SCOPE_DENIED','Guest write is outside declared access.','NONE');
        const writesHash = await digest(JSON.stringify(await Promise.all(writes.map(async entry=>[
          entry.path, entry.bytes ? await digest(entry.bytes) : null,
        ]))));
        const authorize = async () => {
          try { await context.permit('source-publication', writesHash); }
          catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'REVOKED';
            throw effectError(code, 'Staged write publication was denied or unavailable.', 'NONE');
          }
        };
        if (writes.some(entry=>native(entry.path))) {
          const observed = await context.vfs.snapshot();
          if (!pre || observed.revision !== pre.revision)
            throw effectError('STALE_REVISION','Source changed during guest computation.','NONE');
          await authorize();
          const result = await context.vfs.writeBatch(writes, pre.revision, context.envelope.operationId, context.assertCurrent);
          if (result.status!=='SUCCEEDED') throw effectError('EFFECT_UNKNOWN','Guest publication requires reconciliation.',result.status);
          return {revision: result.revision};
        }
        await authorize();
        const result = await context.vfs.writeLocalBatch(writes, localView.revision.value, context.envelope.operationId, context.assertCurrent);
        return {revision: result.value};
      },
    },
  });
}
async function retrieve(args: BrowserToolArgs<'fetch_url'>, context: DevelopmentContext, fs: FilesystemV2,
  scope: FilesystemCallScope, fetchImpl?: typeof fetch) {
  const local = await context.vfs.localView();
  const hosts = await context.vfs.store.get<string[]>('perch:fetch-approved-hosts') ?? [];
  const paths = new Set<string>();
  const post = args.requests[0]?.method === 'POST';
  for (const request of args.requests) {
    validatePublicFetchUrl(request.url, hosts);
    if (paths.has(request.path.toLowerCase())) throw new BrowserError('PATH_DENIED','Retrieval destination collides.');
    paths.add(request.path.toLowerCase());
    const metadata = local.files.find(file=>file.path === request.path);
    if (request.ifAbsent ? metadata : metadata?.sha256 !== request.ifSha256)
      throw new BrowserError('STALE_REVISION','Retrieval destination precondition failed.');
  }
  const effect = await digest(JSON.stringify(args.requests));
  await context.permit(post ? 'public-post' : 'public-get', effect);
  let transferred = 0;
  const writes = [], receipts = [];
  try {
    for (const request of args.requests) {
      await context.assertCurrent();
      const time = Math.min(args.timeoutMs ?? 30_000, context.envelope.deadlineMs - Date.now());
      if (time < 1 || transferred >= 16 * 1024 * 1024)
        throw new BrowserError('LIMIT_EXCEEDED','Retrieval budget exhausted.');
      const response = await fetchPublic(request.url, {
        approvedHosts: hosts, allowPost: post, method: request.method, fetchImpl,
        ...(request.method === 'POST' ? {body:request.body} : {}), timeoutMs:time,
        maxBytes:16 * 1024 * 1024 - transferred, signal:context.signal,
      });
      transferred += response.bytes.length;
      writes.push({path:request.path, encoding:'base64' as const, content:bytesToBase64(response.bytes),
        ifAbsent:request.ifAbsent, ifSha256:request.ifSha256});
      receipts.push({path:request.path,status:response.status,bytes:response.bytes.length,
        mime:response.contentType.slice(0,128),sha256:await digest(response.bytes)});
    }
    const result = await fs.publishWrites({files:writes,expectedLocalRevision:local.revision.value},scope);
    return {publication:result,receipts};
  } catch (error) {
    if (post && receipts.length)
      throw effectError('PARTIAL_EFFECT','Public POST completed but private destination publication did not verify.','PARTIAL');
    throw error;
  }
}
async function importPublic(args: BrowserToolArgs<'fetch_generator'>, context: DevelopmentContext, fetchImpl?: typeof fetch) {
  const names = args.generators.map(row=>row.slug);
  if (new Set(names).size !== names.length) throw new BrowserError('INVALID_INPUT','Duplicate public generator.');
  const revisions = [], imports: Record<string,Uint8Array> = Object.create(null);
  let transferred = 0;
  const local = await context.vfs.localView();
  await context.permit('public-get', await digest(JSON.stringify(args.generators)));
  for (const generator of args.generators) {
    await context.assertCurrent();
    const first = await readPublicGenerator(generator.slug,fetchImpl,context.signal);
    const second = await readPublicGenerator(generator.slug,fetchImpl,context.signal);
    if (first.completeness !== 'complete' || second.completeness !== 'complete' || first.revision !== second.revision)
      throw new BrowserError('STALE_REVISION','Complete public source could not be independently read back.');
    const paths = generator.paths ?? Object.keys(first.files);
    for (const path of paths) {
      if (!Object.hasOwn(first.files,path) || !equalBytes(first.files[path]!,second.files[path]!))
        throw new BrowserError('STALE_REVISION','Selected public import source changed.');
      const bytes = first.files[path]!;
      transferred += bytes.length;
      if (transferred > 16 * 1024 * 1024) throw new BrowserError('LIMIT_EXCEEDED','Public import exceeds its total byte budget.');
      imports['imports/' + generator.slug + '/' + path] = bytes;
    }
    revisions.push({slug:generator.slug,generatorId:first.generatorId,revision:first.revision,paths});
  }
  await context.permit('source-publication', await digest(JSON.stringify(revisions)));
  const revision = await context.vfs.publishImportedFiles(names, imports, local.revision.value,
    context.envelope.operationId, context.assertCurrent);
  return {imports:revisions,localRevision:revision};
}

export async function executeDevelopment(context: DevelopmentContext, engine?: ComputeWorkerClient, fetchImpl?: typeof fetch) {
  const operation = context.envelope;
  if (operation.tool === 'workspace_status_verified') {
    if (!operation.permissions.includes('READ_SOURCE') || Object.keys(operation.args).length !== 0)
      throw new BrowserError('SCOPE_DENIED','Verified Workspace source requires READ_SOURCE.');
    await context.assertCurrent();
    return context.additional('generator_info',{verifySource:true},
      {target:operation.target,grantId:operation.grantId,operationId:operation.operationId,
        assertCurrent:context.assertCurrent,authorizePublication:async()=>{
          throw new BrowserError('SCOPE_DENIED','Verified Workspace status cannot publish.');
        }});
  }
  if (!Object.hasOwn(developmentToolArgs,operation.tool)) throw new BrowserError('INVALID_INPUT','Unknown v2 execution tool.');
  const tool = operation.tool as keyof typeof developmentToolArgs;
  const validated = developmentToolArgs[tool].safeParse(operation.args);
  if (!validated.success) throw new BrowserError('INVALID_INPUT','Invalid v2 browser tool arguments.');
  const args = validated.data as Record<string,unknown>;
  if (operation.transferRecoveryOnly && (tool !== 'write' || (args.mode !== 'commit' && args.mode !== 'abort')))
    throw new BrowserError('SCOPE_DENIED', 'Transfer recovery may only inspect a scoped commit or abort handle.');
  if (!requiredPermissionsV2(tool,args).every(permission=>operation.permissions.some(grant=>grant===permission)))
    throw new BrowserError('SCOPE_DENIED','Operation exceeds its immutable permission ceiling.');
  if (tool === 'batch') {
    const batch = validated.data as BatchArgumentsV2;
    const approvedHosts = batch.actions.some(step => step.tool === 'fetch_url')
      ? await context.vfs.store.get<string[]>('perch:fetch-approved-hosts') ?? []
      : undefined;
    try {
      preflightDevelopmentBatch(batch, approvedHosts);
    } catch (error) {
      if (error instanceof ToolError) throw new BrowserError(error.code, error.message, error.recovery);
      throw error;
    }
  }
  const fs = new FilesystemV2(context.vfs);
  const scope: FilesystemCallScope = {
    target:operation.target,grantId:operation.grantId,operationId:operation.operationId,
    operationKey:operation.operationKey,
    transferRecoveryOnly: operation.transferRecoveryOnly,
    assertCurrent:context.assertCurrent,
    authorizePublication: input=>context.permit('source-publication',input.digest),
  };
  const run = async (name: BrowserToolV2, args: Record<string,unknown>) => {
    await context.assertCurrent();
    if (Object.hasOwn(filesystemV2Schemas,name)) return fs.run(name as FilesystemToolV2,args,scope);
    if (name === 'execute_js') {
      if (!engine) throw new BrowserError('UNSUPPORTED_INTERFACE','Isolated compute worker unavailable.');
      return scopedCompute(browserToolSchemas.execute_js.parse(args),context,engine);
    }
    if (name === 'fetch_url') return retrieve(browserToolSchemas.fetch_url.parse(args),context,fs,scope,fetchImpl);
    if (name === 'fetch_generator') return importPublic(browserToolSchemas.fetch_generator.parse(args),context,fetchImpl);
    return context.additional(name,args,scope);
  };
  if (tool !== 'batch') return run(tool,args);
  return executeBatch(args as unknown as BatchArgumentsV2, context, fs, scope, run);
}

type BatchAction = BatchArgumentsV2['actions'][number];
type MutationAction = Extract<BatchAction, {tool: 'write' | 'delete' | 'rename'}>;
type StepStatus = 'RUNNING' | 'STAGED' | 'SUCCEEDED' | 'REJECTED' | 'CANCELLED' |
  'UNKNOWN' | 'PARTIAL' | 'DISCARDED' | 'SKIPPED';
type StepEffect = 'NONE' | 'KNOWN' | 'UNKNOWN' | 'PARTIAL';

interface BatchStep {
  index: number;
  stepId: string;
  id?: string;
  tool: BrowserToolV2;
  status: StepStatus;
  effectState: StepEffect;
  code?: string;
  paths?: {path: string; outcome: 'STAGED' | 'COMMITTED' | 'UNCERTAIN' | 'DISCARDED' | 'SKIPPED'}[];
  revision?: string;
  result?: unknown;
}

function isMutation(action: BatchAction): action is MutationAction {
  return action.tool === 'write' || action.tool === 'delete' || action.tool === 'rename';
}

function stepFailure(error: unknown, effectCapable = false): Pick<BatchStep, 'status' | 'effectState' | 'code'> {
  const typed = error instanceof BrowserError || error instanceof ExecutionError;
  const code = typed ? error.code : 'PROVIDER_REJECTED';
  if (error instanceof ExecutionError && error.effectState === 'PARTIAL') {
    return {status: 'PARTIAL', effectState: 'PARTIAL', code};
  }
  if (error instanceof ExecutionError && error.effectState === 'UNKNOWN' ||
      code === 'EFFECT_UNKNOWN' || !typed && effectCapable) {
    return {status: 'UNKNOWN', effectState: 'UNKNOWN', code};
  }
  return {status: code === 'CANCELLED' ? 'CANCELLED' : 'REJECTED', effectState: 'NONE', code};
}

function compactRead(result: Awaited<ReturnType<FilesystemV2['read']>>) {
  return {...result, files: result.files.map(file => {
    if (!('content' in file) || !file.content) return file;
    const {content: _content, ...metadata} = file;
    return {...metadata, returnedBytes: 0, resultAvailability: 'CONTINUATION_REQUIRED',
      next: {unit: 'bytes', offset: file.offset, length: file.returnedBytes,
        ifSha256: file.sha256}};
  })};
}

async function executeBatch(batch: BatchArgumentsV2, context: DevelopmentContext, fs: FilesystemV2,
    scope: FilesystemCallScope, run: (tool: BrowserToolV2, args: Record<string, unknown>) => Promise<unknown>) {
  const actions = batch.actions;
  const steps: BatchStep[] = [];
  let known = false;
  let uncertain = false;
  let available = batchResultBudget - batchEvidenceReserve(batch);
  const base = (index: number, status: StepStatus, effectState: StepEffect): BatchStep => ({
    index, stepId: context.envelope.operationId + ':' + index, id: actions[index]!.id,
    tool: actions[index]!.tool, status, effectState,
  });
  const persist = async (step: Omit<BatchStep, 'result'>) => {
    try {
      await context.recordStep(step);
    } catch (error) {
      if (known || uncertain || step.effectState !== 'NONE') {
        throw effectError('EFFECT_UNKNOWN', 'Batch ledger acknowledgement was unavailable after an effect.',
          known || step.effectState === 'KNOWN' || step.effectState === 'PARTIAL' ? 'PARTIAL' : 'UNKNOWN');
      }
      throw error;
    }
  };
  const append = async (step: BatchStep) => {
    const {result: _result, ...evidence} = step;
    await persist(evidence);
    known ||= step.effectState === 'KNOWN' || step.effectState === 'PARTIAL';
    uncertain ||= step.effectState === 'UNKNOWN';
    steps.push(step);
  };
  const stop = async (failure: Pick<BatchStep, 'status' | 'effectState' | 'code'>, next: number, groupStart?: number) => {
    for (let index = next; index < actions.length; index++) await append(base(index, 'SKIPPED', 'NONE'));
    const status = known ? 'PARTIAL' : uncertain ? 'UNKNOWN' : failure.status;
    const effectState = known ? 'PARTIAL' : uncertain ? 'UNKNOWN' : failure.effectState;
    return {status, effectState, steps, skipped: actions.length - next,
      ...(groupStart === undefined ? {} : {publicationError: {...failure, groupStart}})};
  };
  const boundedResult = (tool: BrowserToolV2, result: unknown) => {
    try {
      const size = utf8.encode(JSON.stringify(result)).byteLength;
      if (size <= available) {
        available -= size;
        return result;
      }
      if (tool === 'read') return compactRead(result as Awaited<ReturnType<FilesystemV2['read']>>);
    } catch { /* Keep the terminal effect separate from projection. */ }
    return {resultAvailability: 'TOO_LARGE'};
  };

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]!;
    if (isMutation(action)) {
      const begin = index;
      const group = [action];
      for (let scan = index + 1; scan < actions.length; scan++) {
        const candidate = actions[scan]!;
        if (!isMutation(candidate)) break;
        group.push(candidate);
      }
      // The same staged publication path gives even one mutation exact
      // per-path evidence while preserving batch stop-on-error semantics.
      const publication = await fs.publishCoherent(group, scope, async (offset, paths) => {
        await context.recordStep({...base(begin + offset, 'STAGED', 'NONE'),
          paths: paths.map(path => ({path, outcome: 'STAGED'}))});
      });
      if (publication.kind === 'staging-failed') {
        for (const [offset, paths] of publication.stagedPaths.entries()) {
          await append({...base(begin + offset, 'DISCARDED', 'NONE'),
            paths: paths.map(path => ({path, outcome: 'DISCARDED'}))});
        }
        const failure = stepFailure(publication.error);
        const failedIndex = begin + publication.failedOffset;
        await append({...base(failedIndex, failure.status, failure.effectState), code: failure.code});
        return stop(failure, failedIndex + 1);
      }
      const owners = new Map<string, number>();
      for (const [offset, paths] of publication.stagedPaths.entries()) {
        for (const path of paths) owners.set(path, offset);
      }
      const final = new Set(publication.finalPaths);
      const result = publication.kind === 'published' ? publication.result : undefined;
      const fault = publication.kind === 'publication-failed' ? stepFailure(publication.error, true) : undefined;
      const committed = new Set(result?.committed ?? []);
      const uncertain = new Set(result && 'uncertainPaths' in result && result.uncertainPaths
        ? result.uncertainPaths : fault?.effectState === 'UNKNOWN' ? publication.finalPaths : []);
      const resultCode: string | undefined = result && 'error' in result ? result.error?.code : fault?.code;
      const revision = result && 'revision' in result ? result.revision : undefined;
      for (const [offset, paths] of publication.stagedPaths.entries()) {
        const outcomes: NonNullable<BatchStep['paths']> = paths.map(path => ({
          path,
          outcome: !final.has(path) || owners.get(path) !== offset ? 'DISCARDED'
            : committed.has(path) ? 'COMMITTED' : uncertain.has(path) ? 'UNCERTAIN' : 'SKIPPED',
        }));
        const hasCommit = outcomes.some(path => path.outcome === 'COMMITTED');
        const hasUncertainty = outcomes.some(path => path.outcome === 'UNCERTAIN');
        const hasSkipped = outcomes.some(path => path.outcome === 'SKIPPED');
        const status = hasCommit
          ? hasUncertainty || hasSkipped ? 'PARTIAL' : 'SUCCEEDED'
          : hasUncertainty ? 'UNKNOWN' : hasSkipped ? 'SKIPPED' : 'DISCARDED';
        const effect = status === 'PARTIAL' ? 'PARTIAL' : hasCommit ? 'KNOWN' : hasUncertainty ? 'UNKNOWN' : 'NONE';
        await append({...base(begin + offset, status, effect), paths: outcomes, revision,
          ...(status === 'UNKNOWN' || status === 'PARTIAL' || status === 'SKIPPED' ? {code: resultCode} : {})});
      }
      index += group.length - 1;
      if (fault) return stop(fault, index + 1, begin);
      if (result?.status === 'PARTIAL' || result?.status === 'UNKNOWN') {
        return stop({status: result.status, effectState: result.status, code: resultCode}, index + 1, begin);
      }
      continue;
    }
    const mayEffect = hasEffectV2(action.tool, action.args);
    await persist(base(index, 'RUNNING', 'NONE'));
    let result: unknown;
    try {
      result = await run(action.tool, action.args);
    } catch (error) {
      const failure = stepFailure(error, mayEffect);
      await append({...base(index, failure.status, failure.effectState), code: failure.code});
      return stop(failure, index + 1);
    }
    const reported = result as {status?: unknown} | null;
    if (reported?.status === 'UNKNOWN' || reported?.status === 'PARTIAL') {
      const failure = {status: reported.status, effectState: reported.status} as const;
      await append({...base(index, failure.status, failure.effectState), result: boundedResult(action.tool, result)});
      return stop(failure, index + 1);
    }
    await append({...base(index, 'SUCCEEDED', mayEffect ? 'KNOWN' : 'NONE'),
      result: boundedResult(action.tool, result)});
  }
  return {status: 'SUCCEEDED', effectState: known ? 'KNOWN' : 'NONE', steps};
}

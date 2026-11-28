import { browserToolSchemas, developmentToolArgs, type BatchArgumentsV2, type BrowserToolArgs,
  type BrowserToolV2, batchEvidenceReserve, batchResultBudget, hasEffectV2, preflightDevelopmentBatch, requiredPermissionsV2 } from '../../../packages/contracts/src/development-v2.js';
import { ToolError } from '../../../packages/contracts/src/errors.js';
import { assertNoFilePathConflicts, pathMatchesRules } from '../../../packages/contracts/src/paths.js';
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
  const readRules = args.access.read ?? [];
  const writeRules = args.access.write ?? [];
  const pins = args.modules ?? [];
  const viewRules = [...new Set([...readRules, ...writeRules, ...pins.map(pin => pin.path)])];
  const nativeRules = viewRules.filter(native);
  const maxBytes = args.access.maxBytes ?? 16 * 1024 * 1024;
  const maxReads = args.access.maxReads ?? 256;
  const maxWrites = args.access.maxWrites ?? 64;
  if (viewRules.length)
    await context.permit('read-view', await digest(JSON.stringify([context.envelope.target, args.access, pins])));
  await context.assertCurrent();
  const localView = await context.vfs.localView();
  // Directory access grants visibility, not a request to hydrate every native
  // asset. Enumerate metadata only, then read explicitly requested bytes.
  const hasNativeAssets = nativeRules.some(rule => rule.startsWith('src/'));
  const nativeManifest = hasNativeAssets
    ? await context.vfs.adapter.listSourceMetadata()
    : [{path:'main.pjs'}, {path:'index.html'}];
  const nativePaths = nativeManifest.map(row => row.path)
    .filter(path => pathMatchesRules(path, nativeRules)).sort();
  // The declared native view is bounded before the guest starts. Request an
  // exact path/subdirectory rather than an unbounded src/ grant when the
  // generator has more entries than the operation's read budget.
  if (nativePaths.length > maxReads)
    throw new ExecutionError('LIMIT_EXCEEDED', 'Native source view exceeds its selected file limit.');
  const nativePathSet = new Set(nativePaths);
  const nativeView = new Map<string, Uint8Array | null>();
  const readablePaths = nativePaths.filter(path => pathMatchesRules(path, readRules))
    .concat(localView.files.map(file => file.path)).filter(path => pathMatchesRules(path, readRules)).sort();
  const localCache = new Map<string, Uint8Array>();
  let loadedBytes = 0;
  let readCount = 0;
  const localFiles = new Map(localView.files.map(row => [row.path, row]));
  const checkRead = async () => {
    await context.assertCurrent();
    if (++readCount > maxReads) throw new ExecutionError('LIMIT_EXCEEDED', 'Guest read count exceeded.');
  };
  const assertNativeUnchanged = (current: Map<string, Uint8Array | null>) => {
    if (nativeView.size !== current.size || [...nativeView].some(([path, before]) => {
      const after = current.get(path);
      return before === null ? after !== null : !after || !equalBytes(before, after);
    })) throw new ExecutionError('STALE_REVISION', 'Selected native source changed during guest computation.');
  };
  const readNativeObserved = () => nativeView.size
    ? context.vfs.adapter.readSourceView([...nativeView.keys()], [], nativeView.size, maxBytes)
    : Promise.resolve(new Map<string, Uint8Array | null>());
  const assertNativeManifestUnchanged = async () => {
    if (!hasNativeAssets) return;
    const current = (await context.vfs.adapter.listSourceMetadata()).map(row => row.path)
      .filter(path => pathMatchesRules(path, nativeRules)).sort();
    if (JSON.stringify(current) !== JSON.stringify(nativePaths))
      throw new ExecutionError('STALE_REVISION', 'Native source paths changed during guest computation.');
  };
  const read = async (path: string) => {
    await checkRead();
    if (native(path)) {
      if (!nativePathSet.has(path)) throw new ExecutionError('FILE_NOT_FOUND', 'Guest file does not exist.');
      const cached = nativeView.get(path);
      if (cached) return cached.slice();
      // Re-read earlier selected files inside the same bracketed native view.
      // A new read cannot silently combine bytes from two known revisions.
      const current = await context.vfs.adapter.readSourceView(
        [...nativeView.keys(), path], [], Math.min(maxReads, nativeView.size + 1), maxBytes);
      for (const [prior, expected] of nativeView) {
        const observed = current.get(prior);
        if (!expected || !observed || !equalBytes(expected, observed))
          throw new ExecutionError('STALE_REVISION', 'Selected native source changed during guest computation.');
      }
      const bytes = current.get(path);
      if (!bytes) throw new ExecutionError('STALE_REVISION', 'Native source disappeared during guest computation.');
      if (loadedBytes + bytes.length > maxBytes)
        throw new ExecutionError('LIMIT_EXCEEDED', 'Guest read-view byte budget exceeded.');
      await assertNativeManifestUnchanged();
      await context.assertCurrent();
      loadedBytes += bytes.length;
      nativeView.set(path, bytes.slice());
      return bytes.slice();
    }
    const existing = localCache.get(path);
    if (existing) return existing.slice();
    const info = localFiles.get(path);
    if (!info) throw new ExecutionError('FILE_NOT_FOUND', 'Guest file does not exist.');
    if (loadedBytes + info.bytes > maxBytes)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Guest read-view byte budget exceeded.');
    const bytes = await localView.read(path);
    await context.assertCurrent();
    loadedBytes += bytes.length;
    if (loadedBytes > maxBytes)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Guest read-view byte budget exceeded.');
    localCache.set(path, bytes);
    return bytes.slice();
  };
  // Write declarations require a native before-image even when the guest never
  // reads the path. Otherwise an operator edit made while the guest runs could
  // be silently incorporated into the publication precondition.
  // An explicitly tightened byte budget is a request for a pre-execution
  // size proof. Native manifests may omit file sizes, so load only this
  // declared bounded view before starting the guest; without an explicit
  // smaller budget, read-only file bytes remain lazy.
  const preflightNativePaths = nativePaths.filter(path =>
    pathMatchesRules(path, writeRules) ||
    args.access.maxBytes !== undefined && pathMatchesRules(path, readRules));
  if (preflightNativePaths.length) {
    const baseline = await context.vfs.adapter.readSourceView(
      preflightNativePaths, [], preflightNativePaths.length, maxBytes);
    for (const path of preflightNativePaths) {
      const bytes = baseline.get(path);
      if (!bytes) throw new ExecutionError('STALE_REVISION', 'Declared native source disappeared.');
      loadedBytes += bytes.length;
      if (loadedBytes > maxBytes)
        throw new ExecutionError('LIMIT_EXCEEDED', 'Selected source exceeded its byte limit.');
      nativeView.set(path, bytes.slice());
    }
    await assertNativeManifestUnchanged();
    await context.assertCurrent();
  }
  // This token is an operation-local *selected view* identity, not a complete
  // verified native SourceRevision. Publication independently verifies native
  // state and the exact staged write set after the compute guest completes.
  const version = 'view:' + await digest(JSON.stringify([
    context.envelope.target, localView.revision.value, nativePaths]));
  const modules: Record<string, string> = Object.create(null);
  let moduleBytes = 0;
  for (const pin of pins) {
    const bytes = await read(pin.path);
    moduleBytes += bytes.length;
    if (bytes.length > 262_144 || moduleBytes > 524_288)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Pinned modules exceed their byte budget.');
    if (await digest(bytes) !== pin.sha256)
      throw new ExecutionError('STALE_REVISION', 'Pinned module digest changed.');
    try { modules[pin.specifier] = new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { throw new ExecutionError('INVALID_INPUT', 'Pinned module is not valid UTF-8.'); }
  }
  const timeoutMs = Math.min(args.timeoutMs ?? 30_000, context.envelope.deadlineMs - Date.now());
  if (timeoutMs < 1) throw new ExecutionError('TIMEOUT', 'Operation expired before computation.');
  await context.assertCurrent();
  return engine.execute({
    js: args.js, modules, signal: context.signal, maxStagedBytes: maxBytes, timeoutMs,
    fileAccess: {read: readRules, write: writeRules, maxReads: maxReads - pins.length, maxWrites},
    files: {
      revision: async () => version,
      read: async path => {
        if (!pathMatchesRules(canonicalPath(path), readRules))
          throw new ExecutionError('SCOPE_DENIED', 'Guest read is outside declared access.');
        return read(path);
      },
      list: async () => {
        await checkRead();
        return readablePaths.slice();
      },
      writeBatch: async (writes, expectedRevision) => {
        await context.assertCurrent();
        if (expectedRevision !== version || !writes.length || writes.length > maxWrites)
          throw new ExecutionError('LIMIT_EXCEEDED', 'Guest write set is outside its declared bounds.');
        try { assertNoFilePathConflicts(writes.map(entry => entry.path)); }
        catch (error) {
          if (error instanceof ToolError) throw new ExecutionError(error.code, error.message);
          throw error;
        }
        if (writes.some(entry => !pathMatchesRules(entry.path, writeRules)))
          throw new ExecutionError('SCOPE_DENIED', 'Guest write is outside declared access.');
        const before = writes.some(entry => native(entry.path)) ? await context.vfs.snapshot() : null;
        if (before) {
          await assertNativeManifestUnchanged();
          const observed = new Map<string, Uint8Array | null>(
            [...nativeView.keys()].map(path => [path, before.files[path] ?? null]));
          assertNativeUnchanged(observed);
        } else if (nativeRules.length) {
          await assertNativeManifestUnchanged();
          assertNativeUnchanged(await readNativeObserved());
        }
        if ((await context.vfs.localView()).revision.value !== localView.revision.value)
          throw new ExecutionError('STALE_REVISION', 'Private source changed during guest computation.');
        const writeSet = await Promise.all(writes.map(async entry =>
          [entry.path, entry.bytes === null ? null : await digest(entry.bytes)]));
        const publication = await digest(JSON.stringify([version, before?.nativeRevision ?? null, localView.revision.value, writeSet]));
        try { await context.permit('source-publication', publication); }
        catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'REVOKED';
          throw new ExecutionError(code, 'Staged write publication was denied or unavailable.');
        }
        if (before) {
          const result = await context.vfs.writeBatch(writes, before.revision, context.envelope.operationId, context.assertCurrent);
          if (result.status !== 'SUCCEEDED')
            throw new ExecutionError(result.error?.code ?? 'EFFECT_UNKNOWN', 'Guest publication requires reconciliation.', result.status);
          return {revision: result.revision};
        }
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
    const remaining = Math.min(args.timeoutMs ?? 30_000, context.envelope.deadlineMs-Date.now());
    if (remaining < 1) throw new BrowserError('TIMEOUT','Public source verification exceeded its deadline.');
    const controller=new AbortController();
    const abort=()=>controller.abort();
    context.signal.addEventListener('abort',abort,{once:true});
    if(context.signal.aborted) controller.abort();
    const timer=setTimeout(abort,remaining);
    let first: Awaited<ReturnType<typeof readPublicGenerator>>;
    let second: Awaited<ReturnType<typeof readPublicGenerator>>;
    try {
      first=await readPublicGenerator(generator.slug,fetchImpl,controller.signal);
      await context.assertCurrent();
      second=await readPublicGenerator(generator.slug,fetchImpl,controller.signal);
    } catch(error) {
      if(controller.signal.aborted && !context.signal.aborted)
        throw new BrowserError('TIMEOUT','Public source verification exceeded its deadline.');
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort',abort);
    }
    if (first.completeness !== 'complete' || second.completeness !== 'complete' || first.revision !== second.revision)
      throw new BrowserError('STALE_REVISION','Complete public source could not be independently read back.');
    const paths = [...(generator.paths ?? Object.keys(first.files))].sort();
    if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length)
      throw new BrowserError('INVALID_INPUT', 'Public import selectors collide or repeat.');
    const proofs: Array<{path:string;bytes:number;sha256:string}> = [];
    for (const path of paths) {
      if (path === 'perch-receipt.json' || path.startsWith('perch-receipt.json/') ||
          path === 'perch-revisions' || path.startsWith('perch-revisions/'))
        throw new BrowserError('PATH_DENIED','Selected source path collides with the reserved import metadata namespace.');
      if (!Object.hasOwn(first.files,path) || !equalBytes(first.files[path]!,second.files[path]!))
        throw new BrowserError('STALE_REVISION','Selected public import source changed.');
      const bytes = first.files[path]!;
      transferred += bytes.length;
      if (transferred > 16 * 1024 * 1024) throw new BrowserError('LIMIT_EXCEEDED','Public import exceeds its total byte budget.');
      imports['imports/' + generator.slug + '/' + path] = bytes;
      proofs.push({path,bytes:bytes.length,sha256:await digest(bytes)});
    }
    // The canonical current import remains compatible with earlier agents.
    // Every verified snapshot also has a content-addressed immutable address.
    // Manifest bytes and source bytes publish under one durable local pointer.
    const sourcePaths=Object.keys(first.files);
    const materialization=paths.length === sourcePaths.length &&
      sourcePaths.every(path=>paths.includes(path)) ? 'complete' : 'selected';
    const core={schemaVersion:2,slug:generator.slug,generatorId:first.generatorId,
      revision:first.revision,completeness:first.completeness,materialization,files:proofs};
    const snapshotId=await digest(JSON.stringify(core));
    const versionPrefix='imports/' + generator.slug + '/perch-revisions/' + snapshotId + '/';
    const manifestPath=versionPrefix + 'manifest.json';
    const receipt={...core,snapshotId,manifestPath,sourcePrefix:versionPrefix + 'files/'};
    const proofBytes=new TextEncoder().encode(JSON.stringify(receipt));
    transferred+=proofBytes.length;
    if(transferred>16*1024*1024) throw new BrowserError('LIMIT_EXCEEDED','Import receipt exceeds total byte budget.');
    imports['imports/' + generator.slug + '/perch-receipt.json']=proofBytes;
    imports[manifestPath]=proofBytes;
    for(const path of paths) imports[versionPrefix + 'files/' + path]=first.files[path]!.slice();
    revisions.push({...receipt,paths});
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

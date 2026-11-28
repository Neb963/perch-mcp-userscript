import { newQuickJSWASMModuleFromVariant, type QuickJSHandle, type QuickJSDeferredPromise } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import { moduleSpecifierPattern } from '../../../packages/contracts/src/compute.js';
import { pathMatchesRules } from '../../../packages/contracts/src/paths.js';
import { BrowserError } from './native-types.js';

export interface ComputeWrite { path: string; bytes: Uint8Array | null }
export interface ComputeFileBroker {
  revision(): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  list(): Promise<string[]>;
  writeBatch(writes: ComputeWrite[], expectedRevision: string): Promise<{ revision: string }>;
}
export interface ComputeToolBroker {
  call(name: string, args: Record<string, unknown>, context: { signal: AbortSignal; deadline: number }): Promise<unknown>;
}
interface ComputeFileAccess {
  readonly read: readonly string[];
  readonly write: readonly string[];
  readonly maxReads: number;
  readonly maxWrites: number;
}
export interface ComputeOptions {
  js: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  files: ComputeFileBroker;
  fileAccess?: ComputeFileAccess;
  tools?: ComputeToolBroker;
  /** Only already inspected, version-pinned modules. No ambient module networking. */
  modules?: Readonly<Record<string, string>>;
  memoryLimitBytes?: number;
  maxStagedBytes?: number;
}
export interface ComputeEffect { kind: 'files' | 'tool'; paths?: string[]; tool?: string; revision?: string; outcome: 'verified' | 'unknown' }
export interface ComputeResult { result: unknown; consoleOutput: string[]; filesWritten: string[]; effects: ComputeEffect[] }
export class ExecutionError extends Error {
  constructor(public readonly code: string, message: string, public readonly effectState: 'NONE' | 'PARTIAL' | 'UNKNOWN' = 'NONE', public readonly effects: ComputeEffect[] = []) { super(message); this.name = 'ExecutionError'; }
}
const MAX_MESSAGE_BYTES = 262_144;
const V2_OUTPUT_BYTES = 192 * 1024;
const MAX_BROKER_CALLS = 1000;
const CHILD_TOOLS = new Set(['page_eval', 'page_refresh', 'fetch_url', 'generate_image', 'upload_file', 'set_viewport_size', 'read', 'write', 'edit', 'patch', 'glob', 'grep', 'list_files', 'rename_file', 'delete_file', 'save_b64_file', 'read_b64_file']);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
function path(value: unknown, write = false): string {
  if (typeof value !== 'string' || value.length > 1024 || !/^(main\.pjs|index\.html|(?:src|scratch|imports)\/[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(value) || value.split('/').some(x => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(x) || x === '.' || x === '..')) throw new ExecutionError('PATH_DENIED', 'Use a canonical Workspace path.');
  if (write && value.startsWith('imports/')) throw new ExecutionError('PATH_DENIED', 'Imported source is read-only.');
  return value;
}
function json(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) return 'null';
  if (textEncoder.encode(result).byteLength > MAX_MESSAGE_BYTES) throw new ExecutionError('LIMIT_EXCEEDED', 'Compute message exceeds 256 KiB.');
  return result;
}
function knownNoEffect(error: unknown): boolean {
  const e = error as { code?: unknown; effectState?: unknown } | null;
  if (e?.effectState !== undefined) return e.effectState === 'NONE';
  return ['STALE_REVISION', 'SCOPE_DENIED', 'PATH_DENIED', 'INVALID_INPUT', 'LIMIT_EXCEEDED', 'TAB_BUSY', 'BINDING_MISMATCH', 'STALE_EPOCH', 'TAB_OFFLINE', 'UNSUPPORTED_INTERFACE'].includes(String(e?.code));
}
function safeError(error: unknown, effectCapable = false): {
  code: string; message: string; effectState: ExecutionError['effectState'];
} {
  if (error instanceof ExecutionError)
    return {code:error.code, message:error.message.slice(0, 500), effectState:error.effectState};
  const code = error instanceof BrowserError ? error.code : 'PROVIDER_REJECTED';
  const effectState = code === 'PARTIAL_EFFECT' ? 'PARTIAL' : code === 'EFFECT_UNKNOWN' ||
    effectCapable && !knownNoEffect(error) ? 'UNKNOWN' : 'NONE';
  return {code, message:'The bounded Workspace broker rejected this operation.', effectState};
}
function bytes(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_BYTES || value.some(x => !Number.isInteger(x) || x < 0 || x > 255)) throw new ExecutionError('INVALID_INPUT', 'File bytes must be an array of integers from 0 to 255.');
  return Uint8Array.from(value as number[]);
}
const bootstrap = `
(() => {
  const nativeBroker = __perchBroker, nativeLog = __perchLog;
  const invoke = async (kind, name, args) => {
    const reply = JSON.parse(await nativeBroker(JSON.stringify({kind,name,args})));
    if (!reply.ok) { const error = new Error(reply.error.message); error.code=reply.error.code; throw error; }
    return reply.value;
  };
  globalThis.fs = Object.freeze({
    readTextFile: p => invoke('fs','readTextFile',[p]), readFile: async p => new Uint8Array(await invoke('fs','readFile',[p])),
    writeTextFile: (p,t) => invoke('fs','writeTextFile',[p,t]), writeFile: (p,b) => invoke('fs','writeFile',[p,Array.from(b)]),
    list: p => invoke('fs','list',[p]), deleteFile: p => invoke('fs','deleteFile',[p]), stat: p => invoke('fs','stat',[p]),
    rename: (a,b) => invoke('fs','rename',[a,b]), delete: p => invoke('fs','delete',[p])
  });
  globalThis.tools = Object.freeze(Object.fromEntries(${JSON.stringify([...CHILD_TOOLS])}.map(name => [name, args => invoke('tool',name,[args])])));
  globalThis.console = Object.freeze(Object.fromEntries(['log','info','warn','error','debug'].map(level => [level,(...args)=>nativeLog(JSON.stringify({level,args}))])));
  delete globalThis.__perchBroker; delete globalThis.__perchLog;
})();`;

/** Engine entry. Production callers run this inside the bundled dedicated Worker. */
export async function executeCompute(options: ComputeOptions): Promise<ComputeResult> {
  const timeout = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600_000 || typeof options.js !== 'string' || textEncoder.encode(options.js).byteLength > MAX_MESSAGE_BYTES) throw new ExecutionError('INVALID_INPUT', 'Compute source or timeout exceeds the documented limit.');
  const memoryLimit = options.memoryLimitBytes ?? 32 * 1024 * 1024;
  if (!Number.isInteger(memoryLimit) || memoryLimit < 1_048_576 || memoryLimit > 64 * 1024 * 1024) throw new ExecutionError('INVALID_INPUT', 'Compute memory must be 1–64 MiB.');
  const maxStaged = options.maxStagedBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxStaged) || maxStaged < 1 || maxStaged > 16 * 1024 * 1024) throw new ExecutionError('INVALID_INPUT', 'Compute staging budget must be 1 byte–16 MiB.');
  const modules = options.modules ?? {};
  const access = options.fileAccess;
  let reads = 0;
  if (Object.keys(modules).length > 32 || Object.entries(modules).some(([id, source]) => !moduleSpecifierPattern.test(id) || typeof source !== 'string' || textEncoder.encode(source).byteLength > MAX_MESSAGE_BYTES)) throw new ExecutionError('INVALID_INPUT', 'Compute modules must be explicit, version-pinned, and bounded.');
  const initialRevision = await options.files.revision();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const deadline = Date.now() + timeout;
  const effects: ComputeEffect[] = [];
  const written = new Set<string>();
  const staged = new Map<string, Uint8Array | null>();
  const logs: string[] = [];
  let logBytes = 0;
  let closed = false;
  let calls = 0;
  let activeTool: string | undefined;
  let uncertain = false;
  let baseRevision = initialRevision;
  function assertActive() {
    if (uncertain) throw new ExecutionError('EFFECT_UNKNOWN', 'A child effect requires reconciliation before further computation.', 'UNKNOWN', effects);
    if (controller.signal.aborted) throw new ExecutionError('CANCELLED', 'Compute was cancelled.');
    if (Date.now() >= deadline) throw new ExecutionError('TIMEOUT', 'Compute deadline expired.');
  }
  async function flush() {
    assertActive();
    if (!staged.size) return;
    const writes = [...staged].map(([p, b]) => ({ path: p, bytes: b }));
    let receipt: { revision: string };
    try { receipt = await options.files.writeBatch(writes, baseRevision); }
    catch (error) { if (!knownNoEffect(error)) { uncertain = true; effects.push({ kind: 'files', paths: writes.map(w => w.path), outcome: 'unknown' }); } throw error; }
    baseRevision = receipt.revision;
    effects.push({ kind: 'files', paths: writes.map(w => w.path), revision: receipt.revision, outcome: 'verified' });
    writes.forEach(w => written.add(w.path));
    staged.clear();
  }
  function stage(p: string, value: Uint8Array | null) {
    if (access && !pathMatchesRules(p, access.write))
      throw new ExecutionError('SCOPE_DENIED', 'Guest write is outside declared access.');
    const maxFiles = access?.maxWrites ?? 500;
    let total = value?.byteLength ?? 0;
    for (const [other, b] of staged) if (other !== p) total += b?.byteLength ?? 0;
    if (total > maxStaged || staged.size >= maxFiles && !staged.has(p)) throw new ExecutionError('LIMIT_EXCEEDED', 'Compute staging exceeds its byte or file limit.');
    staged.set(p, value);
  }
  function countRead() {
    if (access && ++reads > access.maxReads)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Guest read count exceeded.');
  }
  async function read(p: string): Promise<Uint8Array> {
    countRead();
    if (access && !pathMatchesRules(p, access.read))
      throw new ExecutionError('SCOPE_DENIED', 'Guest read is outside declared access.');
    if (staged.has(p)) { const b = staged.get(p); if (b === null) throw new ExecutionError('INVALID_INPUT', 'File does not exist.'); return b!.slice(); }
    const b = await options.files.read(p);
    if (b.byteLength > MAX_MESSAGE_BYTES) throw new ExecutionError('LIMIT_EXCEEDED', 'Use paged file tools for files larger than 256 KiB.');
    return b;
  }
  async function broker(raw: string): Promise<string> {
    assertActive();
    if (++calls > MAX_BROKER_CALLS || textEncoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) throw new ExecutionError('LIMIT_EXCEEDED', 'Compute broker call budget exceeded.');
    const request = JSON.parse(raw) as { kind?: unknown; name?: unknown; args?: unknown };
    if (!Array.isArray(request.args) || typeof request.name !== 'string') throw new ExecutionError('INVALID_INPUT', 'Malformed compute broker request.');
    const args = request.args;
    if (request.kind === 'tool') {
      if (!CHILD_TOOLS.has(request.name) || !options.tools || args.length !== 1 || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) throw new ExecutionError('SCOPE_DENIED', 'This child tool is not available to compute.');
      await flush();
      assertActive();
      activeTool = request.name;
      try {
        const result = await options.tools.call(request.name, args[0] as Record<string, unknown>, { signal: controller.signal, deadline });
        if (result && typeof result === 'object' && 'status' in result && ['REJECTED', 'PARTIAL', 'UNKNOWN', 'CANCELLED'].includes(String(result.status))) {
          const status = String(result.status);
          if (status === 'UNKNOWN' || status === 'PARTIAL') { uncertain = true; effects.push({ kind: 'tool', tool: request.name, outcome: 'unknown' }); }
          throw new ExecutionError(status === 'UNKNOWN' ? 'EFFECT_UNKNOWN' : status === 'PARTIAL' ? 'PARTIAL_EFFECT' : 'PROVIDER_REJECTED', 'A child tool failed; inspect its operation before retrying.', status === 'UNKNOWN' ? 'UNKNOWN' : status === 'PARTIAL' ? 'PARTIAL' : 'NONE');
        }
        effects.push({ kind: 'tool', tool: request.name, outcome: 'verified' });
        baseRevision = await options.files.revision();
        return json({ ok: true, value: result });
      } catch (error) {
        if (!knownNoEffect(error)) { uncertain = true; if (!effects.some(e => e.kind === 'tool' && e.tool === request.name && e.outcome === 'unknown')) effects.push({ kind: 'tool', tool: request.name, outcome: 'unknown' }); }
        throw error;
      } finally { activeTool = undefined; }
    }
    if (request.kind !== 'fs') throw new ExecutionError('SCOPE_DENIED', 'Unknown compute broker capability.');
    let value: unknown;
    const p = request.name === 'list' && (args[0] === undefined || args[0] === null || args[0] === '') ? '' : request.name === 'list' && typeof args[0] === 'string' && ['src', 'scratch', 'imports'].includes(args[0]) ? args[0] : path(args[0], ['writeTextFile', 'writeFile', 'rename', 'delete', 'deleteFile'].includes(request.name));
    switch (request.name) {
      case 'readTextFile': value = textDecoder.decode(await read(p)); break;
      case 'readFile': value = Array.from(await read(p)); break;
      case 'writeTextFile': if (typeof args[1] !== 'string') throw new ExecutionError('INVALID_INPUT', 'Text file content must be a string.'); stage(p, textEncoder.encode(args[1])); value = { path: p, staged: true }; break;
      case 'writeFile': stage(p, bytes(args[1])); value = { path: p, staged: true }; break;
      case 'deleteFile': case 'delete': stage(p, null); value = { path: p, staged: true }; break;
      case 'rename': { const target = path(args[1], true); if (target === p) throw new ExecutionError('INVALID_INPUT', 'Rename requires two different paths.'); if ((staged.has(target) ? staged.get(target) !== null : (await options.files.list()).includes(target))) throw new ExecutionError('INVALID_INPUT', 'Rename target already exists.'); const content = await read(p); const prior = new Map(staged); try { stage(target, content); stage(p, null); } catch (error) { staged.clear(); for (const entry of prior) staged.set(...entry); throw error; } value = { path: target, staged: true }; break; }
      case 'stat': { const content = await read(p); value = { path: p, size: content.byteLength }; break; }
      case 'list': { countRead(); const all = new Set(await options.files.list()); for (const [s, b] of staged) { if (!access || pathMatchesRules(s, access.read)) b === null ? all.delete(s) : all.add(s); } value = [...all].filter(s => !p || s === p || s.startsWith(p + '/')).sort(); break; }
      default: throw new ExecutionError('SCOPE_DENIED', 'Unknown compute file capability.');
    }
    return json({ ok: true, value });
  }
  const QuickJS = await (modulePromise ??= newQuickJSWASMModuleFromVariant(variant));
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimit);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() >= deadline);
  runtime.setModuleLoader(name => {
    if (!Object.hasOwn(modules, name)) throw new Error('Module is not in the approved pinned dependency set.');
    return modules[name]!;
  });
  const vm = runtime.newContext();
  const deferred = new Set<QuickJSDeferredPromise>();
  let pending = 0;
  let serial: Promise<void> = Promise.resolve();
  let wake: (() => void) | undefined;
  function notify() { wake?.(); wake = undefined; }
  const hostBroker = vm.newFunction('__perchBroker', rawHandle => {
    const raw = vm.getString(rawHandle);
    const promise = vm.newPromise();
    deferred.add(promise);
    pending++;
    serial = serial.then(async () => {
      let reply: string;
      try { if (closed) throw new ExecutionError('CANCELLED', 'Compute has ended.'); reply = await broker(raw); }
      catch (error) { reply = json({ ok: false, error: safeError(error) }); }
      if (!closed) { const handle = vm.newString(reply); promise.resolve(handle); handle.dispose(); }
      pending--;
      notify();
    });
    return promise.handle;
  });
  vm.setProp(vm.global, '__perchBroker', hostBroker); hostBroker.dispose();
  const hostLog = vm.newFunction('__perchLog', value => {
    const raw = vm.getString(value);
    logBytes += textEncoder.encode(raw).byteLength;
    if (logBytes > 65_536) return { error: vm.newError('Console output exceeds 64 KiB.') };
    logs.push(raw.slice(0, 8192));
    return vm.undefined;
  });
  vm.setProp(vm.global, '__perchLog', hostLog); hostLog.dispose();
  let resultHandle: QuickJSHandle | undefined;
  try {
    assertActive();
    const initialized = vm.evalCode(bootstrap, 'perch-bootstrap.js');
    if (initialized.error) { initialized.error.dispose(); throw new ExecutionError('UNSUPPORTED_INTERFACE', 'Compute environment could not initialize.'); }
    initialized.value.dispose();
    const evaluated = vm.evalCode(`(async () => { const value = await (async () => {\n${options.js}\n})(); return JSON.stringify({value}); })()`, 'workspace-compute.js');
    if (evaluated.error) { const message = vm.dump(evaluated.error); evaluated.error.dispose(); throw new ExecutionError(Date.now() >= deadline ? 'TIMEOUT' : 'INVALID_INPUT', String((message as { message?: unknown })?.message ?? 'Compute failed.').slice(0, 500)); }
    resultHandle = evaluated.value;
    let result: unknown;
    for (;;) {
      assertActive();
      const jobs = runtime.executePendingJobs(100);
      if (jobs.error) { const message = vm.dump(jobs.error); jobs.error.dispose(); throw new ExecutionError(Date.now() >= deadline ? 'TIMEOUT' : 'PROVIDER_REJECTED', String((message as { message?: unknown })?.message ?? 'Compute failed.').slice(0, 500)); }
      const state = vm.getPromiseState(resultHandle);
      if (state.type === 'rejected') { const error = vm.dump(state.error) as { message?: unknown; code?: unknown }; state.error.dispose(); throw new ExecutionError(typeof error.code === 'string' ? error.code : Date.now() >= deadline ? 'TIMEOUT' : 'PROVIDER_REJECTED', String(error.message ?? 'Compute rejected.').slice(0, 500)); }
      if (state.type === 'fulfilled') {
        const raw = vm.getString(state.value); state.value.dispose();
        if (textEncoder.encode(raw).byteLength > MAX_MESSAGE_BYTES) throw new ExecutionError('LIMIT_EXCEEDED', 'Compute result exceeds 256 KiB.');
        result = (JSON.parse(raw) as { value?: unknown }).value ?? null;
        if (!pending) break;
      }
      await new Promise<void>(resolve => { const timer = setTimeout(() => { if (wake === wrapped) wake = undefined; resolve(); }, Math.min(10, Math.max(1, deadline - Date.now()))); const wrapped = () => { clearTimeout(timer); resolve(); }; wake = wrapped; });
    }
    if (access && textEncoder.encode(JSON.stringify({result, consoleOutput:logs})).byteLength > V2_OUTPUT_BYTES)
      throw new ExecutionError('LIMIT_EXCEEDED', 'Compute result and console exceed their shared 192 KiB payload budget.');
    await flush();
    return { result, consoleOutput: logs, filesWritten: [...written].sort(), effects };
  } catch (error) {
    controller.abort();
    const info = error instanceof ExecutionError ? error : new ExecutionError('PROVIDER_REJECTED', 'Compute could not complete.');
    if (activeTool) effects.push({ kind: 'tool', tool: activeTool, outcome: 'unknown' });
    const state = info.effectState !== 'NONE' ? info.effectState
      : effects.some(e => e.outcome === 'unknown') ? 'UNKNOWN' : effects.length ? 'PARTIAL' : 'NONE';
    throw new ExecutionError(info.code, info.message, state, effects);
  } finally {
    closed = true;
    options.signal?.removeEventListener('abort', onAbort);
    resultHandle?.dispose();
    for (const promise of deferred) promise.dispose();
    vm.dispose(); runtime.dispose();
  }
}

interface ComputeWorkerEndpoint { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null }
interface WorkerPending { resolve(value: unknown): void; reject(error: unknown): void }
/** Called only from the fixed, bundled Worker entry; the guest has no postMessage API. */
export function runComputeWorker(endpoint: ComputeWorkerEndpoint): void {
  let started = false;
  let nextId = 0;
  const pending = new Map<number, WorkerPending>();
  const request = (kind: string, name: string, args: unknown[]): Promise<unknown> => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); endpoint.postMessage({ type: 'broker', id, kind, name, args });
  });
  endpoint.onmessage = event => {
    const message = event.data as Record<string, unknown>;
    if (message.type === 'reply') {
      const entry = pending.get(Number(message.id));
      if (!entry) return;
      pending.delete(Number(message.id));
      message.ok ? entry.resolve(message.value) : entry.reject(new ExecutionError(String(message.code ?? 'PROVIDER_REJECTED'), String(message.message ?? 'Broker rejected.'),
        message.effectState as ExecutionError['effectState'] | undefined));
      return;
    }
    if (message.type !== 'start' || started) return;
    started = true;
    const files: ComputeFileBroker = {
      revision: () => request('fs', 'revision', []) as Promise<string>,
      read: async p => new Uint8Array(await request('fs', 'read', [p]) as number[]),
      list: () => request('fs', 'list', []) as Promise<string[]>,
      writeBatch: (writes, revision) => request('fs', 'writeBatch', [writes.map(w => ({ path: w.path, bytes: w.bytes === null ? null : Array.from(w.bytes) })), revision]) as Promise<{ revision: string }>,
    };
    const tools: ComputeToolBroker = { call: (name, args) => request('tool', name, [args]) };
    executeCompute({ js: String(message.js), timeoutMs: Number(message.timeoutMs), files,
      ...(message.allowTools === true ? {tools} : {}),
      fileAccess: message.fileAccess as ComputeFileAccess | undefined, modules: message.modules as Record<string, string> | undefined, memoryLimitBytes: Number(message.memoryLimitBytes), maxStagedBytes: Number(message.maxStagedBytes) })
      .then(result => endpoint.postMessage({ type: 'result', result }))
      .catch(error => endpoint.postMessage({ type: 'error', code: error instanceof ExecutionError ? error.code : 'PROVIDER_REJECTED', message: error instanceof ExecutionError ? error.message : 'Compute failed.', effectState: error instanceof ExecutionError ? error.effectState : 'NONE', effects: error instanceof ExecutionError ? error.effects : [] }));
  };
}

interface ComputeWorkerLike extends ComputeWorkerEndpoint { terminate(): void; onerror: ((event: ErrorEvent) => void) | null }
export interface ComputeWorkerClient { execute(options: ComputeOptions): Promise<ComputeResult> }
/** New dedicated Worker per call. Browser CSP refusal is an explicit unsupported result. */
export function createComputeWorkerClient(source: string, createWorker?: (source: string) => ComputeWorkerLike): ComputeWorkerClient {
  return { execute: options => new Promise((resolve, reject) => {
    let worker: ComputeWorkerLike;
    const effects: ComputeEffect[] = [];
    const active = new Set<string>();
    const controller = new AbortController();
    let done = false;
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    const finish = (error?: ExecutionError, value?: ComputeResult) => {
      if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const stop = (code: string, message: string) => {
      const all = [...effects, ...[...active].map(tool => ({ kind: 'tool' as const, tool, outcome: 'unknown' as const }))];
      finish(new ExecutionError(code, message, active.size ? 'UNKNOWN' : effects.length ? 'PARTIAL' : 'NONE', all));
    };
    const abort = () => stop('CANCELLED', 'Compute Worker was cancelled; dispatched child effects require reconciliation.');
    const timer = setTimeout(() => stop('TIMEOUT', 'Compute Worker exceeded its deadline; dispatched child effects require reconciliation.'), options.timeoutMs ?? 120_000);
    try {
      if (createWorker) worker = createWorker(source);
      else { const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' })); try { worker = new Worker(url) as unknown as ComputeWorkerLike; } finally { URL.revokeObjectURL(url); } }
    } catch {
      clearTimeout(timer); reject(new ExecutionError('UNSUPPORTED_INTERFACE', 'The browser blocked the isolated compute Worker. Keep native editing active; inspect CSP and manager support.')); return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    worker.onerror = () => stop('UNSUPPORTED_INTERFACE', 'The isolated compute Worker failed.');
    worker.onmessage = event => {
      if (done) return;
      const message = event.data as Record<string, unknown>;
      if (message.type === 'result') { finish(undefined, message.result as unknown as ComputeResult); return; }
      if (message.type === 'error') { finish(new ExecutionError(String(message.code), String(message.message), message.effectState as ExecutionError['effectState'], message.effects as ComputeEffect[])); return; }
      if (message.type !== 'broker' || !Number.isSafeInteger(message.id) || typeof message.name !== 'string' || !Array.isArray(message.args)) { stop('INVALID_INPUT', 'Compute Worker sent a malformed broker request.'); return; }
      const id = Number(message.id), name = message.name, args = message.args;
      const key = `${message.kind}:${name}:${id}`;
      const effectCapable = message.kind === 'tool' || message.kind === 'fs' && name === 'writeBatch';
      if (effectCapable) active.add(key);
      Promise.resolve().then(async () => {
        let value: unknown;
        if (message.kind === 'fs') {
          switch (name) {
            case 'revision': value = await options.files.revision(); break;
            case 'read': value = Array.from(await options.files.read(path(args[0]))); break;
            case 'list': value = await options.files.list(); break;
            case 'writeBatch': {
              if (!Array.isArray(args[0]) || args[0].length > 500 || typeof args[1] !== 'string') throw new ExecutionError('INVALID_INPUT', 'Invalid compute write batch.');
              const writes = args[0].map((item: { path?: unknown; bytes?: unknown }) => ({ path: path(item.path, true), bytes: item.bytes === null ? null : bytes(item.bytes) }));
              value = await options.files.writeBatch(writes, args[1]);
              effects.push({ kind: 'files', paths: writes.map(w => w.path), outcome: 'verified', revision: (value as { revision: string }).revision });
              break;
            }
            default: throw new ExecutionError('SCOPE_DENIED', 'Compute Worker requested an unknown file capability.');
          }
        } else {
          if (message.kind !== 'tool' || !CHILD_TOOLS.has(name) || !options.tools || !args[0] || typeof args[0] !== 'object' || Array.isArray(args[0])) throw new ExecutionError('SCOPE_DENIED', 'Compute child tool denied.');
          value = await options.tools.call(name, args[0] as Record<string, unknown>, { signal: controller.signal, deadline });
          effects.push({ kind: 'tool', tool: name, outcome: 'verified' });
        }
        if (!done) worker.postMessage({ type: 'reply', id, ok: true, value });
      }).catch(error => { if (!done) worker.postMessage({ type: 'reply', id, ok: false, ...safeError(error, effectCapable) }); }).finally(() => active.delete(key));
    };
    worker.postMessage({ type: 'start', js: options.js, timeoutMs: options.timeoutMs ?? 120_000, modules: options.modules ?? {}, allowTools: !!options.tools, fileAccess: options.fileAccess, memoryLimitBytes: options.memoryLimitBytes ?? 32 * 1024 * 1024, maxStagedBytes: options.maxStagedBytes ?? 2 * 1024 * 1024 });
  }) };
}

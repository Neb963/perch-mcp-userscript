import { BrowserError, canonicalPath, copyArrayBuffer, equalBytes, equalIdentity, snapshotRevision, utf8, type CapabilityReport, type FileWrite, type MutationResult, type NativeIdentity, type NativeSnapshot } from './native-types.js';
interface TextEditor { state?: {readOnly?:unknown}; getValue(): unknown; setValue(value: string): unknown; isClean?(): unknown }
interface SrcState { ready(): unknown; idle?(): unknown; list(): unknown; readFile(path: string): unknown; writeFile(path: string, bytes: unknown): unknown; deleteFile(path: string): unknown; getDraftId(): unknown; isDirty?(): unknown; hasPending?(): unknown }
interface NativePage { userOwnsThisGenerator?:unknown; userCanSaveThisGenerator?:unknown; generatorPublicId?:unknown; app?: { data?: { generator?: { id?: unknown; name?: unknown; publicId?: unknown } }; saveGenerator?: () => unknown; userOwnsThisGenerator?: unknown; userCanSaveThisGenerator?: unknown }; modelTextEditor?: TextEditor; outputTemplateEditor?: TextEditor; srcState?: SrcState; currentInterfaceMode?: unknown; __editorReady?: unknown; __draftChoiceSettled?: unknown; perchanceSaveState?: unknown; __generatorIdentityTransition?: unknown; __draftHandoffClosed?:unknown; editorCollabInitialSyncIsPending?:unknown; __collabRoomFailed?:unknown; yjsProvider?:unknown; aiAgentActivityState?:()=>unknown; __aiGeneratorGuard?:{blocked?:()=>unknown}; editor?: { handleReloadButtonClick?: () => unknown }; editorUndoManagers?: Record<string, { undo?: () => unknown; redo?: () => unknown }> }
export interface AdapterOptions { cloneInto?: (value: unknown) => unknown; externalWritesVerified?: boolean; maxSnapshotBytes?: number }
export interface SaveContext {
  operationId: string;
  permission: boolean;
  previousSavedSnapshot: NativeSnapshot;
  readSavedSnapshot(): Promise<NativeSnapshot>;
  /** Durable dispatch fence, persisted before invoking native Save. */
  onDispatch?(): Promise<void>;
  receipt?: { status: string };
}
function identityString(value: unknown, field: string): string { if (typeof value === 'string' && value.length <= 512) return value; if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value); throw new BrowserError('UNSUPPORTED_INTERFACE', `Native ${field} is not a losslessly serializable identifier.`); }
/** Read only an explicit native ownership/access predicate. Async predicate
 * results must settle to an actual boolean within a bounded deadline. */
async function nativeBoolean(owner: object | undefined, key: string): Promise<boolean | null> {
  if (!owner) return null;
  try {
    const value: unknown = Reflect.get(owner, key);
    const observed: unknown = typeof value === 'function' ? Reflect.apply(value, owner, []) : value;
    if (typeof observed === 'boolean') return observed;
    if (typeof value !== 'function' || !observed ||
        typeof (observed as {then?:unknown}).then !== 'function') return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); });
      return await Promise.race([Promise.resolve(observed).then(result =>
        typeof result === 'boolean' ? result : null, () => null), bounded]);
    } finally { clearTimeout(timer); }
  } catch { return null; }
}
function boundedString(value: unknown): string { if (typeof value !== 'string' || value.length > 4 * 1024 * 1024) throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native editor returned invalid text.'); return value; }
async function nativeBytes(value: unknown): Promise<Uint8Array> {
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  const exact = copyArrayBuffer(value);
  if (exact !== null) return exact;
  if (typeof value === 'string') return utf8.encode(value);
  if (value && typeof value === 'object' && 'arrayBuffer' in value && typeof value.arrayBuffer === 'function') {
    const buffer: unknown = await value.arrayBuffer();
    const copied = copyArrayBuffer(buffer);
    if (copied !== null) return copied;
  }
  throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native file result is not exact bytes.');
}
/** Fixed native method adapter. It neither evaluates code nor exports callbacks to the page. */
export class NativeAdapter {
  private page: NativePage;
  private boundIdentity?: NativeIdentity;
  constructor(page: unknown, readonly options: AdapterOptions = {}) { this.page = page as NativePage; }
  async identity(): Promise<NativeIdentity> {
    const generator = this.page.app?.data?.generator; const src = this.page.srcState;
    if (!generator || !src || typeof src.getDraftId !== 'function') throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native generator/draft identity is unavailable.');
    const draft = await src.getDraftId(); if (typeof draft !== 'string') throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native Draft ID is not a string.');
    const identity: NativeIdentity = { generatorId: identityString(generator.id, 'Generator ID'), slug: identityString(generator.name, 'Slug'), draftId: draft };
    if (generator.publicId !== undefined) identity.publicId = identityString(generator.publicId, 'Public ID');
    if (!identity.generatorId || !identity.slug) throw new BrowserError('BINDING_MISMATCH', 'Unsaved/provisional generator identity cannot inherit template ownership.');
    return identity;
  }
  /**
   * Only project public, explicitly recognized editor metadata. A writable
   * CodeMirror buffer is not proof of generator ownership or Save permission.
   * Unknown listing/ownership must remain unknown, never default to false.
   */
  async generatorMetadata(): Promise<{
    ownership: { known: boolean; owned: boolean | null };
    editAccess: { known: boolean; allowed: boolean | null };
    listing: { known: boolean; value: 'listed' | 'unlisted' | null };
    publicId: { known: boolean; value: string | null; provenance: string };
    savedBaseRevision: { known: false; value: null; reason: string };
  }> {
    const app = this.page.app;
    const [owned,allowed] = await Promise.all([
      this.ownership(),
      this.canSave(),
    ]);
    const generator = app?.data?.generator as Record<string, unknown> | undefined;
    const listingCandidates: ('listed'|'unlisted')[] = [];
    if (generator?.listing === 'listed' || generator?.listing === 'unlisted')
      listingCandidates.push(generator.listing);
    if (typeof generator?.isListed === 'boolean')
      listingCandidates.push(generator.isListed ? 'listed' : 'unlisted');
    if (typeof generator?.isPrivate === 'boolean')
      listingCandidates.push(generator.isPrivate ? 'unlisted' : 'listed');
    // Conflicting native fields mean unknown rather than silently preferring one.
    const listed = listingCandidates.length && listingCandidates.every(v => v === listingCandidates[0])
      ? listingCandidates[0]! : null;
    // Prefer the saved Generator object's publicId; fall back to the native
    // editor's generatorPublicId only when both representations do not conflict.
    const fromGenerator=generator?.publicId;
    const fromEditor=this.page.generatorPublicId;
    const valid=(value:unknown):value is string=>
      typeof value==='string' && /^[a-z0-9]{16,64}$/.test(value);
    const nativePublicId=valid(fromGenerator)?fromGenerator:
      valid(fromEditor)?fromEditor:null;
    const conflicting=valid(fromGenerator)&&valid(fromEditor)&&fromGenerator!==fromEditor;
    const publicId=conflicting?null:nativePublicId;
    return {
      ownership: { known: owned !== null, owned },
      editAccess: { known: allowed !== null, allowed },
      listing: { known: listed !== null, value: listed },
      publicId: { known: publicId!==null, value:publicId,
        provenance: publicId===null ? 'unknown-or-conflicting-native-id' :
          valid(fromGenerator)?'native-generator-data':'native-editor-public-id' },
      savedBaseRevision: { known:false, value:null,
        reason:'No complete independent saved-source readback was performed for generator_info.' },
    };
  }
  /** HAR/native source: these are page globals, not properties of app. */
  ownership(): Promise<boolean | null> { return nativeBoolean(this.page,'userOwnsThisGenerator'); }
  canSave(): Promise<boolean | null> { return nativeBoolean(this.page,'userCanSaveThisGenerator'); }
  bind(identity: NativeIdentity): void { this.boundIdentity = structuredClone(identity); }
  async assertIdentity(): Promise<NativeIdentity> { const identity = await this.identity(); if (this.boundIdentity && !equalIdentity(identity, this.boundIdentity)) throw new BrowserError('BINDING_MISMATCH', 'Generator or Draft changed; explicit rebind is required.'); return identity; }
  async probe(): Promise<CapabilityReport> {
    const blocked: string[] = []; let identity: NativeIdentity | undefined;
    try { identity = await this.identity(); } catch { blocked.push('Native generator/draft identity unavailable.'); }
    const sourceRead = !!this.page.modelTextEditor?.getValue && !!this.page.outputTemplateEditor?.getValue && !!this.page.srcState?.ready && !!this.page.srcState?.list && !!this.page.srcState?.readFile;
    const sourceWriteBlocked = this.mutationBlocks();
    const sourceWrite = sourceRead && sourceWriteBlocked.length === 0 && !!this.page.modelTextEditor?.setValue && !!this.page.outputTemplateEditor?.setValue && !!this.page.srcState?.writeFile && !!this.page.srcState?.deleteFile;
    if (!sourceRead) blocked.push('Required editor or srcState read interfaces unavailable.');
    if (this.page.__editorReady === false || this.page.__draftChoiceSettled === false) blocked.push('Native editor/draft choice has not settled.');
    if (this.page.currentInterfaceMode !== undefined && this.page.currentInterfaceMode !== 'edit') blocked.push('Open the native editor before attaching.');
    if (this.page.perchanceSaveState === 'saving') blocked.push('Native Save is in progress.');
    const report: CapabilityReport = { adapterVersion: 1, ready: sourceRead && blocked.length === 0, sourceRead, sourceWrite, sourceWriteBlocked, nativeSave: typeof this.page.app?.saveGenerator === 'function', preview: !!this.page.editor?.handleReloadButtonClick, dirty: this.dirty(), blocked, liveExternalWritesEnabled: this.options.externalWritesVerified === true };
    if (identity) report.identity = identity; return report;
  }
  /** Pure native status reads only. Never wakes, resumes or controls a native Helper session. */
  private mutationBlocks(): string[] {
    const reasons: string[] = [];
    if (this.page.currentInterfaceMode !== 'edit' || this.page.__editorReady !== true || this.page.__draftChoiceSettled !== true) reasons.push('Native editor/draft readiness is not positively established.');
    if (this.page.__generatorIdentityTransition || this.page.__draftHandoffClosed) reasons.push('Native identity or draft handoff is in progress.');
    if (this.page.editorCollabInitialSyncIsPending === true || this.page.__collabRoomFailed === true || this.page.yjsProvider) reasons.push('Native collaboration is pending, failed, or active; collaborative remote writes are unsupported.');
    for (const editor of [this.page.modelTextEditor, this.page.outputTemplateEditor]) {
      if (typeof editor?.state?.readOnly !== 'boolean') reasons.push('Native editor read-only status interface unavailable.');
      else if (editor.state.readOnly) reasons.push('Native editor is read-only.');
    }
    if (typeof this.page.aiAgentActivityState !== 'function' || typeof this.page.__aiGeneratorGuard?.blocked !== 'function') reasons.push('Verified native Helper/cross-tab status interface unavailable.');
    else try {
      const raw = this.page.aiAgentActivityState(); const activity = raw && typeof raw === 'object' ? raw as Record<string,unknown> : undefined;
      const crossTabBlocked = this.page.__aiGeneratorGuard.blocked();
      if (!activity || typeof activity.active !== 'boolean' || typeof activity.unknown !== 'boolean' || typeof activity.reason !== 'string' || typeof crossTabBlocked !== 'boolean') reasons.push('Native Helper/cross-tab status returned an unsupported shape.');
      else if (activity.active || activity.unknown || activity.reason !== '' || crossTabBlocked) reasons.push('Native Helper or cross-tab mutation state is active, unresolved, or read-only.');
    } catch { reasons.push('Native mutation status could not be read safely.'); }
    if (this.page.perchanceSaveState === 'saving') reasons.push('Native Save is in progress.');
    return [...new Set(reasons)];
  }
  assertMutationReady(): void { const reasons = this.mutationBlocks(); if (reasons.length) throw new BrowserError(reasons.some(reason=>/unavailable|unsupported shape|could not be read|positively established/.test(reason)) ? 'UNSUPPORTED_INTERFACE' : 'TAB_BUSY', reasons.join(' '), 'Wait for native activity/draft choice to settle or inspect the read-only probe; normal editor use remains available.'); }
  private dirty(): boolean { return this.page.perchanceSaveState === 'unsaved' || this.page.srcState?.isDirty?.() === true || this.page.modelTextEditor?.isClean?.() === false || this.page.outputTemplateEditor?.isClean?.() === false; }
  async snapshot(): Promise<NativeSnapshot> {
    const report = await this.probe(); if (!report.ready || !report.identity) throw new BrowserError('TAB_BUSY', report.blocked.join(' ') || 'Native editor not ready.');
    const identity = await this.assertIdentity(); const src = this.page.srcState!; await src.ready(); if (src.idle) await src.idle();
    const files: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    files['main.pjs'] = utf8.encode(boundedString(this.page.modelTextEditor!.getValue())); files['index.html'] = utf8.encode(boundedString(this.page.outputTemplateEditor!.getValue()));
    const listing = await src.list(); let paths: string[];
    if (Array.isArray(listing)) paths = listing.map(row => typeof row === 'string' ? row : row && typeof row === 'object' && typeof row.path === 'string' ? row.path : (() => { throw new BrowserError('UNSUPPORTED_INTERFACE', 'Unrecognized native src manifest row.'); })());
    else if (listing && typeof listing === 'object') paths = Object.keys(listing); else throw new BrowserError('UNSUPPORTED_INTERFACE', 'Unrecognized native src manifest.');
    if (paths.length > 1000) throw new BrowserError('LIMIT_EXCEEDED', 'Native source manifest exceeds 1000 files.'); let total = files['main.pjs'].length + files['index.html'].length;
    const seen = new Set<string>();
    for (const relativePath of paths.sort()) { const path = canonicalPath(`src/${relativePath}`); if (seen.has(path.toLowerCase())) throw new BrowserError('PATH_DENIED', 'Native source paths collide by case.'); seen.add(path.toLowerCase()); const bytes = await nativeBytes(await src.readFile(relativePath)); total += bytes.length; if (total > (this.options.maxSnapshotBytes ?? 64 * 1024 * 1024)) throw new BrowserError('QUOTA_EXCEEDED', 'Native source exceeds configured local snapshot budget.'); files[path] = bytes; }
    const afterListing = await src.list();
    if (JSON.stringify(listing) !== JSON.stringify(afterListing)) throw new BrowserError('STALE_REVISION', 'Native src manifest changed during snapshot.');
    for (const relativePath of paths) if (!equalBytes(files[`src/${relativePath}`]!, await nativeBytes(await src.readFile(relativePath)))) throw new BrowserError('STALE_REVISION', 'Native src bytes changed during snapshot.');
    const afterIdentity = await this.assertIdentity(); if (!equalIdentity(identity, afterIdentity)) throw new BrowserError('BINDING_MISMATCH', 'Identity changed while reading source.');
    // Re-read panels after asynchronous src reads; never return a knowingly mixed panel revision.
    if (!equalBytes(files['main.pjs'], utf8.encode(boundedString(this.page.modelTextEditor!.getValue()))) || !equalBytes(files['index.html'], utf8.encode(boundedString(this.page.outputTemplateEditor!.getValue())))) throw new BrowserError('STALE_REVISION', 'Editor changed during source snapshot.');
    return { identity, files, revision: await snapshotRevision(identity, files), dirty: this.dirty(), saveState: typeof this.page.perchanceSaveState === 'string' ? this.page.perchanceSaveState : 'unknown' };
  }
  getSnapshot(): Promise<NativeSnapshot> { return this.snapshot(); }
  async applyFiles(writes: FileWrite[], expectedRevision: string): Promise<MutationResult> {
    const report = await this.probe(); if (!report.ready) throw new BrowserError('TAB_BUSY', 'Native source write interfaces not ready.'); this.assertMutationReady(); if (!report.sourceWrite) throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native source setter interfaces unavailable.');
    let expected = await this.snapshot(); if (expected.revision !== expectedRevision) throw new BrowserError('STALE_REVISION', 'Source changed before native mutation.');
    const names = new Set<string>(); for (const write of writes) { canonicalPath(write.path); if (write.path.startsWith('scratch/') || write.path.startsWith('imports/')) throw new BrowserError('PATH_DENIED', 'Not a native source path.'); if (names.has(write.path.toLowerCase())) throw new BrowserError('PATH_DENIED', 'Duplicate/colliding write path.'); names.add(write.path.toLowerCase()); if ((write.path === 'main.pjs' || write.path === 'index.html') && write.bytes === null) throw new BrowserError('PATH_DENIED', 'Native panels cannot be deleted.'); }
    const committed: string[] = []; let dispatched = false;
    try {
    for (const write of writes) {
      const now = await this.snapshot(); if (now.revision !== expected.revision) return { status: committed.length ? 'PARTIAL' : 'UNKNOWN', revision: now.revision, committed, error: { code: 'STALE_REVISION', message: 'Manual/native change interrupted batch; preserved both versions.', recovery: 'Inspect checkpoint and current source. Do not replay the batch.' } };
      this.assertMutationReady();
      try {
        dispatched = true;
        if (write.path === 'main.pjs' || write.path === 'index.html') { const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(write.bytes!); const editor = write.path === 'main.pjs' ? this.page.modelTextEditor! : this.page.outputTemplateEditor!; await editor.setValue(text); }
        else if (write.bytes === null) await this.page.srcState!.deleteFile(write.path.slice(4));
        else { const copied = this.options.cloneInto ? this.options.cloneInto(write.bytes) : write.bytes.slice(); await this.page.srcState!.writeFile(write.path.slice(4), copied); }
        if (this.page.srcState!.idle) await this.page.srcState!.idle!();
      } catch { return { status: 'UNKNOWN', revision: expected.revision, committed, error: { code: 'EFFECT_UNKNOWN', message: 'Native write threw; its effect may have occurred.', recovery: 'Read source and reconcile the operation. Never automatically replay.' } }; }
      const after = await this.snapshot(); const planned = { ...expected.files }; if (write.bytes === null) delete planned[write.path]; else planned[write.path] = write.bytes;
      const desiredRevision = await snapshotRevision(expected.identity, planned);
      if (after.revision !== desiredRevision) return { status: 'PARTIAL', revision: after.revision, committed, error: { code: 'PARTIAL_EFFECT', message: 'Native readback did not match complete planned source.', recovery: 'Inspect current source and checkpoint; preserve manual changes.' } };
      committed.push(write.path); expected = after;
    }
    return { status: 'SUCCEEDED', revision: expected.revision, committed };
    } catch (error) {
      if (!dispatched) throw error;
      return {status:committed.length?'PARTIAL':'UNKNOWN',revision:expected.revision,committed,error:{code:'EFFECT_UNKNOWN',message:'Native mutation was dispatched before readiness/readback failed.',recovery:'Inspect the retained checkpoint and operation; do not replay.'}};
    }
  }
  async undoRedo(panel: 'pjs' | 'html', direction: 'undo' | 'redo', expectedRevision?: string): Promise<NativeSnapshot> { this.assertMutationReady(); const before = await this.snapshot(); if (expectedRevision && before.revision !== expectedRevision) throw new BrowserError('STALE_REVISION', 'Source changed before undo/redo.'); const manager = this.page.editorUndoManagers?.[panel]; if (!manager || typeof manager[direction] !== 'function') throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native panel undo manager unavailable.'); try { await manager[direction]!(); return await this.snapshot(); } catch { throw new BrowserError('EFFECT_UNKNOWN','Native undo/redo was dispatched; complete readback is unavailable.','Reconcile current native source before any repeat.'); } }
  async save(intendedRevision: string, context: SaveContext): Promise<MutationResult> {
    if (!context.permission) throw new BrowserError('SCOPE_DENIED', 'Save permission is disabled.');
    if (!this.options.externalWritesVerified) throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native Save requires the recorded live Firefox/disposable verification gate.');
    this.assertMutationReady();
    const intended = await this.snapshot(); if (intended.revision !== intendedRevision) throw new BrowserError('STALE_REVISION', 'Intended revision no longer matches current draft.');
    if (!equalIdentity(context.previousSavedSnapshot.identity, intended.identity)) throw new BrowserError('BINDING_MISMATCH', 'Saved base identity differs.');
    const [owned, allowed] = await Promise.all([this.ownership(),this.canSave()]);
    // Native Save can fork a copy when the editor is not the owner. A scoped
    // save_generator must never silently create or change Generator identity.
    if (owned !== true || allowed !== true)
      throw new BrowserError('SCOPE_DENIED','Native owner and Save access must both be positively verified for the bound Generator.');
    if (this.page.srcState?.hasPending?.() === true) throw new BrowserError('TAB_BUSY', 'Pending native viewer buffers require operator settlement.');
    const currentSaved = await context.readSavedSnapshot(); if (currentSaved.revision !== context.previousSavedSnapshot.revision) throw new BrowserError('NATIVE_CONFLICT', 'Provider source changed since saved base.');
    if ((await this.snapshot()).revision !== intendedRevision) throw new BrowserError('STALE_REVISION', 'Draft changed during Save preflight.');
    if (currentSaved.revision === intendedRevision) return { status: 'SUCCEEDED', revision: intendedRevision, committed: [] };
    if (typeof this.page.app?.saveGenerator !== 'function') throw new BrowserError('UNSUPPORTED_INTERFACE', 'Native Save method unavailable.');
    this.assertMutationReady();
    // This callback durably records that an external effect is about to begin.
    // A failure to persist the fence MUST prevent the native dispatch.
    await context.onDispatch?.();
    let receipt: unknown;
    try { receipt = await this.page.app.saveGenerator(); } catch { return this.unknownSave(intendedRevision); }
    const status = context.receipt?.status ?? (receipt && typeof receipt === 'object' && 'status' in receipt ? receipt.status : undefined);
    if (status === 'stale') throw new BrowserError('NATIVE_CONFLICT', 'Native Save rejected stale source.');
    if (status === 'captcha-needed' || status === 'challenge') throw new BrowserError('CHALLENGE_REQUIRED', 'Complete native verification, then reconcile.');
    // The public bytes, not the shape of a private native Save return value,
    // are the authority. Some native versions return void even after success.
    // Never claim success from status='saved' alone.
    // CDN/public stored-source readback may lag a successful native Save.
    // Retry only idempotent reads for a bounded interval; NEVER replay Save.
    const settleDeadline = Date.now() + 7000;
    for (let attempt=0; attempt<3; attempt++) {
      if (attempt) {
        if (Date.now() >= settleDeadline) break;
        await new Promise<void>(resolve => setTimeout(resolve, 200*attempt));
      }
      try {
        const saved=await context.readSavedSnapshot();
        if (saved.revision===intendedRevision &&
            equalIdentity(saved.identity,intended.identity) &&
            Object.keys(saved.files).length===Object.keys(intended.files).length &&
            Object.entries(intended.files).every(([path,bytes]) =>
              saved.files[path] && equalBytes(bytes,saved.files[path]!)))
          return {status:'SUCCEEDED',revision:intendedRevision,
            committed:Object.keys(intended.files)};
      } catch { /* Read-only lag/unavailability: retry within the same bound. */ }
    }
    return this.unknownSave(intendedRevision);
  }
  private unknownSave(revision: string): MutationResult { return { status: 'UNKNOWN', revision, committed: [], error: { code: 'EFFECT_UNKNOWN', message: 'Native Save outcome lacks an independent complete-source receipt.', recovery: 'Read-only reconciliation only; do not repeat Save.' } }; }
}

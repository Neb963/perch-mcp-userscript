import { BrowserError, digest, equalIdentity, type NativeSnapshot } from './native-types.js';
import { NativeEffectNotInvoked } from './adapter.js';
import type { DevelopmentContext } from './development-v2.js';
import { SavedSourceReader } from './lifecycle.js';

type Reader = () => Promise<NativeSnapshot>;
async function contextReader(context: DevelopmentContext): Promise<Reader> {
  const identity = await context.vfs.adapter.assertIdentity();
  const reader = new SavedSourceReader();
  return () => reader.read(identity.slug,identity);
}
export async function developmentInfo(args: Record<string,unknown>, context: DevelopmentContext, read?: Reader) {
  await context.assertCurrent();
  const adapter = context.vfs.adapter;
  const identity = await adapter.assertIdentity();
  const [owned,canSave] = await Promise.all([adapter.ownership(),adapter.canSave()]);
  const verifiedSource = args.verifySource === true ? await adapter.snapshot() : null;
  const saved = args.verifySaved === true ? await (read ?? await contextReader(context))() : null;
  await context.assertCurrent();
  if (saved && !equalIdentity(saved.identity,identity))
    throw new BrowserError('BINDING_MISMATCH','Saved identity differs from the bound native editor.');
  return {identity,ownership:{known:owned!==null,owned},access:{known:canSave!==null,canSave},
    sourceRevision:{value:verifiedSource?.revision??null,verified:!!verifiedSource},
    savedRevision:{value:saved?.revision??null,verified:!!saved},
    ...(verifiedSource ? {dirty:verifiedSource.dirty,localRevision:(await context.vfs.localView()).revision} : {})};
}
export async function saveDevelopment(args: Record<string,unknown>, context: DevelopmentContext, read?: Reader) {
  const adapter = context.vfs.adapter;
  if (!context.envelope.permissions.includes('SAVE')) throw new BrowserError('SCOPE_DENIED','Save requires explicit permission.');
  if (!adapter.options.externalWritesVerified)
    throw new BrowserError('UNSUPPORTED_INTERFACE','Native Save remains disabled pending operator acceptance.');
  await context.assertCurrent();
  const intended = await adapter.snapshot();
  if (intended.revision !== args.intendedSourceRevision)
    throw new BrowserError('STALE_REVISION','Draft differs from the intended SourceRevision.');
  const readSavedSnapshot = read ?? await contextReader(context);
  const previousSavedSnapshot = await readSavedSnapshot();
  await context.assertCurrent();
  if (!equalIdentity(previousSavedSnapshot.identity,intended.identity))
    throw new BrowserError('BINDING_MISMATCH','Saved source belongs to a different Generator or Draft.');
  if (previousSavedSnapshot.revision !== args.expectedSavedRevision)
    throw new BrowserError('STALE_REVISION','Verified saved base differs from expectedSavedRevision.');
  const holds = await context.vfs.unresolved();
  if (holds.some(entry=>entry.kind==='SAVE' || entry.paths.some(path=>path==='main.pjs'||path==='index.html'||path.startsWith('src/'))))
    throw new BrowserError('EFFECT_UNKNOWN','Reconcile the previous native effect before Save.');
  const operationId = context.envelope.operationId;
  const journalKey = context.vfs.prefix + ':journal:' + operationId;
  if (await context.vfs.store.get(journalKey))
    throw new BrowserError('EFFECT_UNKNOWN','This exact Save has retained local evidence.');
  const checkpoint = await context.vfs.checkpoint('Before native Save',true);
  const row = {id:operationId,gatewayOperationId:operationId,state:'INTENT',kind:'SAVE',
    paths:Object.keys(intended.files),baseRevision:intended.revision,checkpointId:checkpoint.id,
    createdAt:Date.now(),identity:intended.identity, plannedHash:intended.revision};
  await context.vfs.store.set(journalKey,row);
  let dispatched = false;
  try {
    const result = await adapter.save(intended.revision,{
      operationId,permission:true,previousSavedSnapshot,readSavedSnapshot,assertCurrent:context.assertCurrent,
      onDispatch: async () => {
        const inputDigest = await digest(JSON.stringify([context.envelope.target,intended.revision,previousSavedSnapshot.revision]));
        await context.permit('save',inputDigest);
        await context.assertCurrent();
        await context.vfs.store.set(journalKey,{...row,state:'DISPATCHED'});
        dispatched = true;
      },
    });
    await context.vfs.store.set(journalKey,{...row,state:result.status});
    return {...result,sourceRevision:{value:intended.revision,verified:true},
      savedRevision:{value:result.status==='SUCCEEDED'?result.revision:null,verified:result.status==='SUCCEEDED'}};
  } catch (error) {
    const noNativeEffect = error instanceof NativeEffectNotInvoked || !dispatched;
    const persisted = await context.vfs.store.set(journalKey,{...row,state:noNativeEffect?'REJECTED':'UNKNOWN'})
      .then(() => true, () => false);
    if (noNativeEffect && persisted) throw error instanceof NativeEffectNotInvoked ? error.cause : error;
    throw new BrowserError('EFFECT_UNKNOWN','Native Save could not persist a conclusive observation. Inspect independent saved source before retrying.');
  }
}

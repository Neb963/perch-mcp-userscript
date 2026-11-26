/** Transient iframe CSS effects are not generator/provider mutations. */
export interface EffectOperation { tool:string; phase:string; terminalAt?:number|null; resolution?:unknown }
/** A terminal viewport PARTIAL/UNKNOWN still retains its historical error. */
export function isTerminalViewportEffect(o:EffectOperation):boolean {
  return o.tool==='set_viewport_size' && ['UNKNOWN','PARTIAL'].includes(o.phase)
    && typeof o.terminalAt==='number' && Number.isFinite(o.terminalAt) && o.terminalAt>0;
}
/** An in-flight viewport operation still fences a new document. */
export function blocksNewLease(o:EffectOperation):boolean {
  if(o.resolution)return false;
  if(o.phase==='DISPATCHED'||o.phase==='RUNNING')return true;
  return ['UNKNOWN','PARTIAL'].includes(o.phase)&&!isTerminalViewportEffect(o);
}
export function blocksNewMutation(o:EffectOperation):boolean {
  return !o.resolution && ['UNKNOWN','PARTIAL'].includes(o.phase) && !isTerminalViewportEffect(o);
}
/** page_eval and all other mutating calls retain the conservative writer guard. */
export function requiresGeneratorReservation(tool:string,mutating:boolean):boolean {
  return mutating && tool!=='set_viewport_size';
}

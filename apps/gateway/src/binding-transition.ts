import { ApiError, fields, binding, id, type Binding } from './common.js';

const transitionPath = /^\/api\/v1\/admin\/workspaces\/([A-Za-z0-9_-]{1,128})\/(assign|rebind|transfer|unassign|detach)$/;
const proofPattern = /^[a-f0-9]{64}$/;

export type BindingAction = 'assign' | 'rebind' | 'transfer' | 'unassign' | 'detach';
export function matchBindingTransition(path: string): { workspaceId: string; action: BindingAction } | null {
  const match = transitionPath.exec(path);
  return match ? { workspaceId: match[1]!, action: match[2] as BindingAction } : null;
}

export interface TransitionInput {
  expectedRevision: unknown;
  expectedConnectorRevision?: unknown;
  expectedDestinationConnectorRevision?: unknown;
  connectorId?: string;
  binding?: Binding;
  bindingProof?: string;
  acknowledgeDirty: boolean;
  retainBinding: boolean;
}

export function parseTransitionInput(action: BindingAction, body: Record<string, unknown>): TransitionInput {
  const expected = ['expectedRevision', 'expectedConnectorRevision', 'acknowledgeDirty'];
  if (action === 'assign' || action === 'transfer') expected.push('connectorId', 'expectedDestinationConnectorRevision');
  if (action === 'transfer') expected.push('retainBinding');
  if (action === 'rebind' || (action === 'transfer' && body.retainBinding === true)) expected.push('binding', 'bindingProof');
  fields(body, expected);
  if ((body.acknowledgeDirty !== undefined && typeof body.acknowledgeDirty !== 'boolean') ||
      (body.retainBinding !== undefined && typeof body.retainBinding !== 'boolean'))
    throw new ApiError('INVALID_INPUT', 'Transition acknowledgements must be booleans.');
  let proposed: Binding | undefined;
  let proof: string | undefined;
  if (action === 'rebind' || body.retainBinding === true) {
    proposed = binding(body.binding);
    if (typeof body.bindingProof !== 'string' || !proofPattern.test(body.bindingProof))
      throw new ApiError('BINDING_MISMATCH', 'Fresh destination editor proof required.', 409);
    proof = body.bindingProof;
  }
  return {
    expectedRevision: body.expectedRevision,
    expectedConnectorRevision: body.expectedConnectorRevision,
    expectedDestinationConnectorRevision: body.expectedDestinationConnectorRevision,
    connectorId: action === 'assign' || action === 'transfer' ? id(body.connectorId, 'connectorId') : undefined,
    binding: proposed,
    bindingProof: proof,
    acknowledgeDirty: body.acknowledgeDirty === true,
    retainBinding: body.retainBinding === true,
  };
}

export const bindingOwnerKey = (generatorId: string) => 'binding-owner/v2/' + generatorId;
export const bindingProofKey = (workspaceId: string) => 'binding-proof/v2/' + workspaceId;

export interface EditorProof {
  digest: string;
  binding: Binding;
  workspaceRevision: number;
  credentialEpoch: number;
  expiresAt: number;
}
export interface WorkspaceTransition {
  id: string;
  requestHash: string;
  path: string;
  startedAt: number;
  serial: number;
  aborting?: true;
}

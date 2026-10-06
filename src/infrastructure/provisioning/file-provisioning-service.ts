import { Provisioning, type JoinRequest } from '../../edge/provisioning.js';
import { ApplicationError } from '../../modules/shared/application/contracts.js';
import type { JoinRequestResult, JoinRequestView, ProvisionedNodeView, ProvisioningService } from '../../modules/provisioning/application/provisioning-service.js';

/** Adapts the current JSON-backed provisioning workflow to its async port. */
export class FileProvisioningService implements ProvisioningService {
  constructor(private readonly provisioning: Provisioning) {}

  get enabled(): boolean {
    return this.provisioning.enabled;
  }

  authorize(token: string | null): boolean {
    return this.provisioning.authorise(token);
  }

  async request(input: unknown, from: string): Promise<JoinRequestResult> {
    const result = this.provisioning.request(asRequestInput(input), from);
    return result.status === 'pending'
      ? { status: 'pending', request: requestView(result.request) }
      : result;
  }

  async statusOf(uid: string): Promise<'registered' | 'pending' | 'unknown'> {
    return this.provisioning.statusOf(uid);
  }

  async requests(): Promise<JoinRequestView[]> {
    return this.provisioning.requests().map(requestView);
  }

  async approve(id: string, actor: string): Promise<ProvisionedNodeView> {
    try {
      const node = this.provisioning.approve(id, actor);
      return { uid: node.uid, label: node.label, floorId: null, pose: null, owns: [], rgb: false };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('unavailable', 'provisioning storage is unavailable');
    }
  }

  async deny(id: string, actor: string): Promise<JoinRequestView> {
    return requestView(this.provisioning.deny(id, actor));
  }
}

function requestView(request: JoinRequest): JoinRequestView {
  return { id: request.id, uid: request.uid, label: request.label, firmware: request.firmware,
    from: request.from, at: request.at, expiresAt: request.expiresAt };
}

function asRequestInput(input: unknown): { uid?: unknown; label?: unknown; firmware?: unknown } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};
  return input;
}

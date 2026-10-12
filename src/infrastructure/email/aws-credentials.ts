/**
 * Where the credentials for Amazon SES come from.
 *
 * On the EC2 machine: the instance's own IAM role, read from the instance
 * metadata service. Nothing is stored -- the keys are temporary, AWS rotates
 * them, and there is no secret in `.env` to leak or to forget to rotate.
 *
 * Anywhere else (a laptop, the Proxmox rollback): `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` in the environment, which win when they are set.
 */
import type { AwsCredentials } from './aws-signature.js';

export type CredentialSource = () => Promise<AwsCredentials>;

const KEY_ID = /^[A-Z0-9]{16,128}$/;

/** Static keys from the environment; null when there are none, an error when there is half a pair. */
export function environmentCredentials(env: NodeJS.ProcessEnv): CredentialSource | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim() ?? '', secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim() ?? '', sessionToken = env.AWS_SESSION_TOKEN?.trim() ?? '';
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accessKeyId || !secretAccessKey) throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together (or neither, to use the instance role)');
  if (!KEY_ID.test(accessKeyId)) throw new Error('AWS_ACCESS_KEY_ID is not an access key id');
  const credentials: AwsCredentials = { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
  return async () => credentials;
}

// A link-local address that only this machine's hypervisor answers; plain
// http is how the metadata service is spoken to.
const METADATA = 'http://169.254.169.254';
/** Asked for again this long before AWS's own expiry, so a request never signs with keys about to lapse. */
const RENEW_BEFORE_MS = 5 * 60_000;

/** The EC2 instance role's temporary keys (IMDSv2), cached until shortly before they expire. */
export function instanceRoleCredentials(fetcher: typeof fetch = fetch, now: () => number = Date.now): CredentialSource {
  let cached: { credentials: AwsCredentials; until: number } | null = null;
  let loading: Promise<AwsCredentials> | null = null;
  const unavailable = (why: string): never => { throw new Error(`no AWS credentials: ${why}`); };
  const text = async (path: string, init: RequestInit): Promise<string> => {
    let response: Response;
    try { response = await fetcher(METADATA + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(2000) }); }
    catch { return unavailable('the instance metadata service did not answer (not on EC2, or no route to it)'); }
    if (!response.ok) { try { await response.body?.cancel(); } catch { /* closed */ } return unavailable(response.status === 404 ? 'this instance has no IAM role attached' : `the instance metadata service answered ${response.status}`); }
    const body = await response.text();
    return body.length > 16_384 ? unavailable('the instance metadata service sent something that is not credentials') : body;
  };
  const load = async (): Promise<AwsCredentials> => {
    const token = (await text('/latest/api/token', { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '300' } })).trim();
    const session = { headers: { 'x-aws-ec2-metadata-token': token } };
    const role = (await text('/latest/meta-data/iam/security-credentials/', session)).split('\n')[0]?.trim() ?? '';
    if (!/^[\w+=,.@-]{1,64}$/.test(role)) return unavailable('this instance has no IAM role attached');
    let value: Record<string, unknown>;
    try { value = JSON.parse(await text(`/latest/meta-data/iam/security-credentials/${role}`, session)) as Record<string, unknown>; }
    catch (error) { if (error instanceof Error && error.message.startsWith('no AWS credentials')) throw error; return unavailable('the instance role returned no keys'); }
    const { AccessKeyId, SecretAccessKey, Token, Expiration } = value;
    const expires = typeof Expiration === 'string' ? Date.parse(Expiration) : NaN;
    if (typeof AccessKeyId !== 'string' || !KEY_ID.test(AccessKeyId) || typeof SecretAccessKey !== 'string' || !SecretAccessKey || typeof Token !== 'string' || !Token || !Number.isFinite(expires)) {
      return unavailable('the instance role returned no keys');
    }
    const credentials: AwsCredentials = { accessKeyId: AccessKeyId, secretAccessKey: SecretAccessKey, sessionToken: Token };
    cached = { credentials, until: expires - RENEW_BEFORE_MS };
    return credentials;
  };
  return async () => {
    if (cached && now() < cached.until) return cached.credentials;
    // One lookup however many messages are waiting on it.
    loading ??= load().finally(() => { loading = null; });
    return loading;
  };
}

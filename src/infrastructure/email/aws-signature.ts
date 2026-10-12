/**
 * AWS Signature Version 4, for the one request this server makes to AWS:
 * handing a message to Amazon SES.
 *
 * Written out here rather than taken from the AWS SDK because the edge runs
 * on a handful of runtime dependencies on purpose, and this is forty lines
 * of HMAC. It is checked against AWS's own published test vectors
 * (test/email-delivery.test.ts), not against itself.
 */
import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface SignableRequest {
  method: string;
  url: URL;
  /** Headers to sign and send, besides `host`, `x-amz-date` and the session token, which are added here. */
  headers: Record<string, string>;
  body: string;
}

const sha256 = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();
/** RFC 3986 encoding, which is stricter than encodeURIComponent about `!*'()`. */
const encode = (text: string): string => encodeURIComponent(text).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The headers to send, `authorization` among them. */
export function signedHeaders(request: SignableRequest, credentials: AwsCredentials, region: string, service: string, at: Date): Record<string, string> {
  const stamp = at.toISOString().replace(/[-:]|\.\d{3}/g, ''), day = stamp.slice(0, 8);
  const headers: Record<string, string> = { host: request.url.host, 'x-amz-date': stamp };
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
  // Temporary credentials (an instance role's) are only valid with their token, and it is signed like any other header.
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const path = request.url.pathname.split('/').map((segment) => encode(decodeURIComponent(segment))).join('/') || '/';
  const query = [...request.url.searchParams].map(([key, value]) => `${encode(key)}=${encode(value)}`).sort().join('&');
  const canonical = [request.method.toUpperCase(), path, query, ...names.map((name) => `${name}:${headers[name]}`), '', names.join(';'), sha256(request.body)].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const key = [day, region, service, 'aws4_request'].reduce<Buffer | string>((secret, part) => hmac(secret, part), `AWS4${credentials.secretAccessKey}`);
  const signature = hmac(key, ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n')).toString('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

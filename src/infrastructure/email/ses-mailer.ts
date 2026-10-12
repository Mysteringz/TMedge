/**
 * Email through Amazon SES (the v2 API's SendEmail), over HTTPS.
 *
 * One request per message, to one host: `email.<region>.amazonaws.com`.
 * Setting it up -- the sender identity, the DNS records, the IAM policy --
 * is in docs/EMAIL.md.
 */
import { emailAddress } from '../../modules/algo-admin/domain/account-settings.js';
import { MailError, type Mailer, type OutgoingMail } from '../../modules/algo-admin/repositories/mailer.js';
import { signedHeaders } from './aws-signature.js';
import { environmentCredentials, instanceRoleCredentials, type CredentialSource } from './aws-credentials.js';

export interface EmailConfig {
  /** The SES region the sender identity is verified in. */
  region: string;
  /** The address mail comes from: a verified identity, or an address at a verified domain. */
  from: string;
  /** The console's own address, for the links in a message. */
  consoleUrl: string | null;
  /** An SES configuration set to send through, if one is used. */
  configurationSet: string | null;
}

/** What the sender is called in an inbox. Fixed: nothing a person types becomes part of a From header. */
const SENDER_NAME = 'HKUMySeat console';

/**
 * `EMAIL_FROM` and `EMAIL_SES_REGION` turn email on; neither leaves it off,
 * which the account page says in those words. One without the other is a
 * mistake worth stopping for, like every other half-configured setting here.
 */
export function loadEmailConfig(env: NodeJS.ProcessEnv): EmailConfig | null {
  const from = env.EMAIL_FROM?.trim() ?? '', region = env.EMAIL_SES_REGION?.trim() ?? '';
  const consoleUrl = env.EMAIL_CONSOLE_URL?.trim() ?? '', configurationSet = env.EMAIL_SES_CONFIGURATION_SET?.trim() ?? '';
  if (!from && !region) {
    if (consoleUrl || configurationSet) throw new Error('EMAIL_CONSOLE_URL and EMAIL_SES_CONFIGURATION_SET do nothing without EMAIL_FROM and EMAIL_SES_REGION');
    return null;
  }
  if (!from || !region) throw new Error('EMAIL_FROM and EMAIL_SES_REGION must be set together (or neither, to leave email off)');
  if (emailAddress(from) !== from) throw new Error('EMAIL_FROM must be one plain address such as console@example.org, with no display name');
  // The region becomes part of the host that is called, so it is a region and nothing else.
  if (!/^[a-z]{2}(?:-[a-z]+){1,2}-\d$/.test(region)) throw new Error('EMAIL_SES_REGION must be an AWS region such as ap-southeast-1');
  if (configurationSet && !/^[A-Za-z0-9_-]{1,64}$/.test(configurationSet)) throw new Error('EMAIL_SES_CONFIGURATION_SET must be the name of an SES configuration set');
  let origin: string | null = null;
  if (consoleUrl) {
    let parsed: URL;
    try { parsed = new URL(consoleUrl); } catch { throw new Error('EMAIL_CONSOLE_URL must be the console\'s address, such as https://console.example.org'); }
    const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('EMAIL_CONSOLE_URL must be an https origin with no path, credentials, query or fragment');
    }
    origin = parsed.origin;
  }
  return { region, from, consoleUrl: origin, configurationSet: configurationSet || null };
}

export class SesMailer implements Mailer {
  constructor(
    private readonly config: EmailConfig,
    private readonly credentials: CredentialSource,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** As production runs it: the environment's keys if there are any, otherwise the instance role. */
  static fromEnvironment(config: EmailConfig, env: NodeJS.ProcessEnv): SesMailer {
    return new SesMailer(config, environmentCredentials(env) ?? instanceRoleCredentials());
  }

  async send(mail: OutgoingMail): Promise<void> {
    // The last check before an address leaves the machine, whatever the caller did.
    if (emailAddress(mail.to) !== mail.to) throw new MailError('refused', 'InvalidAddress');
    const url = new URL(`https://email.${this.config.region}.amazonaws.com/v2/email/outbound-emails`);
    const body = JSON.stringify({
      FromEmailAddress: `${SENDER_NAME} <${this.config.from}>`,
      Destination: { ToAddresses: [mail.to] },
      Content: { Simple: { Subject: { Data: mail.subject, Charset: 'UTF-8' }, Body: { Text: { Data: mail.text, Charset: 'UTF-8' } } } },
      ...(this.config.configurationSet ? { ConfigurationSetName: this.config.configurationSet } : {}),
    });
    let headers: Record<string, string>;
    try { headers = signedHeaders({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body }, await this.credentials(), this.config.region, 'ses', this.now()); }
    catch { throw new MailError('unavailable', 'NoCredentials'); }
    let response: Response;
    // Never followed: a redirect would carry a signed request, and a person's address, somewhere that is not SES.
    try { response = await this.fetcher(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
    catch { throw new MailError('unavailable', 'Unreachable'); }
    try { await response.body?.cancel(); } catch { /* already closed */ }
    if (response.ok) return;
    // Only the exception's name is kept. Its message can quote the address it is about.
    const type = (response.headers.get('x-amzn-errortype') ?? '').split(/[:,]/)[0]?.replace(/[^A-Za-z]/g, '').slice(0, 60) || `Http${response.status}`;
    const later = response.status >= 500 || response.status === 429 || /Throttl|TooManyRequests|LimitExceeded/.test(type);
    throw new MailError(later ? 'unavailable' : 'refused', type);
  }
}

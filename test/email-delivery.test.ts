/**
 * Email from the console: what is sent to whom and how often, and the one
 * request that hands a message to Amazon SES. A person's address is theirs,
 * so several claims here are about where it does not go.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { environmentCredentials, instanceRoleCredentials } from '../src/infrastructure/email/aws-credentials.js';
import { signedHeaders } from '../src/infrastructure/email/aws-signature.js';
import { loadEmailConfig, SesMailer } from '../src/infrastructure/email/ses-mailer.js';
import { RuntimeAccountNews } from '../src/infrastructure/algo-admin/runtime-account-news.js';
import { EMAIL_TOPICS, type EmailTopic, type Subscriber } from '../src/modules/algo-admin/domain/account-settings.js';
import { DAILY_LIMIT, emptyDelivery, HOLD_MS, MIN_GAP_MS, parseDelivery, REMEMBER_MS, type DeliveryDocument, type News, type NewsItem } from '../src/modules/algo-admin/domain/email-delivery.js';
import type { NotificationSnapshot } from '../src/modules/algo-admin/domain/operation-notification.js';
import type { AdminPrincipal } from '../src/modules/algo-admin/domain/permissions.js';
import { MailError, type Mailer, type OutgoingMail } from '../src/modules/algo-admin/repositories/mailer.js';
import type { AccountProfile } from '../src/modules/algo-admin/repositories/own-account-repository.js';
import { DeliverEmailNotifications } from '../src/modules/algo-admin/use-cases/deliver-email-notifications.js';
import { Board, emptyBoard } from '../src/modules/workspace/application/board.js';
import { emptyMail, Mailbox } from '../src/modules/workspace/application/mailbox.js';
import type { DocumentStore } from '../src/modules/workspace/repositories/document-store.js';

const MINUTE = 60_000, START = Date.UTC(2026, 9, 12, 8, 0, 0);

class MemoryStore<T> implements DocumentStore<T> {
  writes = 0;
  constructor(public document: T) {}
  read(): T { return this.document; }
  update<R>(change: (draft: T) => R): R { const draft = structuredClone(this.document), result = change(draft); this.document = draft; this.writes++; return result; }
}

class Outbox implements Mailer {
  readonly sent: OutgoingMail[] = [];
  failing: MailError | null = null;
  async send(mail: OutgoingMail): Promise<void> { if (this.failing) throw this.failing; this.sent.push(mail); }
}

const vera: AccountProfile = { name: 'vera', role: 'viewer', teamRoles: [], createdAt: 1000 };
const offline = (label = 'A2 north'): NewsItem => ({ key: `["sensor","${label}","Offline report"]`, topic: 'sensor', subject: label, event: 'Offline report', detail: 'No recent REPORT', at: START, ongoing: true, path: '/console' });
const finished = (job = 'run-7', event = 'Failed'): NewsItem => ({ key: `["training","${job}","${event}",1]`, topic: 'training', subject: job, event, at: START, ongoing: false, path: `/train?job=${job}` });

/** One subscriber, a clock, and whatever the test says is true for them now. */
function delivery(notify: EmailTopic[] = ['sensor', 'training']) {
  const world = {
    now: START, items: [] as NewsItem[], answered: [...EMAIL_TOPICS] as EmailTopic[],
    subscribers: [{ name: 'vera', createdAt: 1000, email: 'vera@example.com', notify }] as Subscriber[],
    profiles: [vera] as AccountProfile[], logs: [] as string[],
  };
  const outbox = new Outbox(), ledger = new MemoryStore<DeliveryDocument>(emptyDelivery());
  const worker = new DeliverEmailNotifications(
    { profile: (name) => world.profiles.find((profile) => profile.name === name) ?? null, current: () => world.profiles.map(({ name, createdAt }) => ({ name, createdAt })) },
    { subscribers: () => world.subscribers },
    async (): Promise<News> => ({ items: world.items, answered: world.answered }),
    ledger, outbox, 'https://console.example.org', () => world.now, (text) => world.logs.push(text),
  );
  /** Lets `minutes` pass, looking once a minute as the timer does. */
  const pass = async (minutes = 1) => { for (let i = 0; i < minutes; i++) { world.now += MINUTE; await worker.run(); } };
  return { world, outbox, ledger, worker, pass };
}

test('the request signature is AWS Signature Version 4, checked against AWS’s own published examples', () => {
  // From the AWS SigV4 test suite: "get-vanilla" and "post-vanilla". The key is AWS's documented example, not a credential.
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const at = new Date(Date.UTC(2015, 7, 30, 12, 36, 0)), url = new URL('https://example.amazonaws.com/');
  const sign = (method: string) => signedHeaders({ method, url, headers: {}, body: '' }, credentials, 'us-east-1', 'service', at).authorization;
  assert.equal(sign('GET'), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  assert.equal(sign('POST'), 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b');

  const temporary = signedHeaders({ method: 'POST', url, headers: { 'Content-Type': 'application/json' }, body: '{}' }, { ...credentials, sessionToken: 'session-token' }, 'us-east-1', 'ses', at);
  assert.equal(temporary['x-amz-security-token'], 'session-token');
  assert.match(temporary.authorization ?? '', /SignedHeaders=content-type;host;x-amz-date;x-amz-security-token,/, 'an instance role’s token is signed, not just sent');
});

test('on EC2 the keys are the instance role’s: fetched with a metadata token, never stored, renewed before they lapse', async () => {
  let now = START, issued = 0;
  const asked: string[] = [];
  const metadata: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(url.origin, 'http://169.254.169.254', 'only the metadata service is asked');
    if (url.pathname === '/latest/api/token') return new Response('metadata-token');
    assert.equal(headers.get('x-aws-ec2-metadata-token'), 'metadata-token', 'IMDSv2: no token, no answer');
    if (url.pathname === '/latest/meta-data/iam/security-credentials/') return new Response('tmedge-mail\n');
    if (url.pathname === '/latest/meta-data/iam/security-credentials/tmedge-mail') {
      issued++;
      return Response.json({ Code: 'Success', AccessKeyId: `ASIAEXAMPLEKEY000${issued}`, SecretAccessKey: `secret-${issued}`, Token: `token-${issued}`, Expiration: new Date(now + 60 * MINUTE).toISOString() });
    }
    return new Response('', { status: 404 });
  };
  const credentials = instanceRoleCredentials(metadata, () => now);
  const [first, second] = await Promise.all([credentials(), credentials()]);
  assert.deepEqual([first.accessKeyId, first.sessionToken, second.sessionToken, issued], ['ASIAEXAMPLEKEY0001', 'token-1', 'token-1', 1], 'one lookup, however many messages wait on it');
  assert.deepEqual(asked, ['PUT /latest/api/token', 'GET /latest/meta-data/iam/security-credentials/', 'GET /latest/meta-data/iam/security-credentials/tmedge-mail']);
  now += 50 * MINUTE;
  assert.equal((await credentials()).sessionToken, 'token-1', 'still good');
  now += 6 * MINUTE;
  assert.equal((await credentials()).sessionToken, 'token-2', 'four minutes from expiry is too close to sign with');

  const noRole = instanceRoleCredentials(async (input) => new Response(String(input).endsWith('/token') ? 't' : '', { status: String(input).endsWith('/token') ? 200 : 404 }));
  await assert.rejects(noRole(), /no IAM role attached/);
  await assert.rejects(instanceRoleCredentials(async () => { throw new TypeError('fetch failed'); })(), /did not answer/);
});

test('keys in the environment win over the instance role, and half a pair is a mistake', async () => {
  assert.equal(environmentCredentials({}), null, 'none set: the instance role is used');
  assert.throws(() => environmentCredentials({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00' }), /set together/);
  assert.throws(() => environmentCredentials({ AWS_SECRET_ACCESS_KEY: 'x' }), /set together/);
  assert.throws(() => environmentCredentials({ AWS_ACCESS_KEY_ID: 'not a key id', AWS_SECRET_ACCESS_KEY: 'x' }), /not an access key id/);
  assert.deepEqual(await environmentCredentials({ AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00', AWS_SECRET_ACCESS_KEY: 'example-secret' })?.(), { accessKeyId: 'AKIAEXAMPLEEXAMPLE00', secretAccessKey: 'example-secret' });
});

test('email is off unless it is fully configured, and a half-configured server refuses to start', () => {
  assert.equal(loadEmailConfig({}), null);
  assert.deepEqual(loadEmailConfig({ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'ap-southeast-1' }), { from: 'console@example.org', region: 'ap-southeast-1', consoleUrl: null, configurationSet: null });
  assert.deepEqual(loadEmailConfig({ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'us-east-1', EMAIL_CONSOLE_URL: 'https://console.example.org/', EMAIL_SES_CONFIGURATION_SET: 'tmedge' }),
    { from: 'console@example.org', region: 'us-east-1', consoleUrl: 'https://console.example.org', configurationSet: 'tmedge' });
  for (const [env, why] of [
    [{ EMAIL_FROM: 'console@example.org' }, 'a sender with no region'],
    [{ EMAIL_SES_REGION: 'us-east-1' }, 'a region with no sender'],
    [{ EMAIL_CONSOLE_URL: 'https://console.example.org' }, 'a link address with nothing to send'],
    [{ EMAIL_FROM: 'Console <console@example.org>', EMAIL_SES_REGION: 'us-east-1' }, 'a sender with a display name'],
    [{ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'us-east-1.evil.example/' }, 'a region that is not a region: it becomes the host that is called'],
    [{ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'US-EAST-1' }, 'a region in capitals'],
    [{ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'us-east-1', EMAIL_CONSOLE_URL: 'http://console.example.org' }, 'a console address without https'],
    [{ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'us-east-1', EMAIL_CONSOLE_URL: 'https://console.example.org/login?next=x' }, 'a console address with a path'],
    [{ EMAIL_FROM: 'console@example.org', EMAIL_SES_REGION: 'us-east-1', EMAIL_SES_CONFIGURATION_SET: 'a b' }, 'a configuration set that is not a name'],
  ] as const) assert.throws(() => loadEmailConfig(env), why);
});

test('a message goes to Amazon SES as one signed request, to one address, and nowhere else', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  let answer = () => Response.json({ MessageId: 'abc' });
  const mailer = new SesMailer({ from: 'console@example.org', region: 'ap-southeast-1', consoleUrl: null, configurationSet: 'tmedge' },
    async () => ({ accessKeyId: 'ASIAEXAMPLEKEY0001', secretAccessKey: 'secret', sessionToken: 'token' }),
    async (input, init) => { requests.push({ url: String(input), init: init ?? {} }); return answer(); }, () => new Date(START));
  await mailer.send({ to: 'vera@example.com', subject: 'A2 north: Offline report', text: 'Hello vera,\n' });

  assert.equal(requests.length, 1);
  const { url, init } = requests[0]!, headers = init.headers as Record<string, string>;
  assert.equal(url, 'https://email.ap-southeast-1.amazonaws.com/v2/email/outbound-emails');
  assert.deepEqual([init.method, init.redirect], ['POST', 'error'], 'a redirect is never followed: it would carry the address somewhere that is not SES');
  assert.match(headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLEKEY0001\/20261012\/ap-southeast-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(String(init.body)), {
    FromEmailAddress: 'HKUMySeat console <console@example.org>', Destination: { ToAddresses: ['vera@example.com'] }, ConfigurationSetName: 'tmedge',
    Content: { Simple: { Subject: { Data: 'A2 north: Offline report', Charset: 'UTF-8' }, Body: { Text: { Data: 'Hello vera,\n', Charset: 'UTF-8' } } } },
  });

  // SES explains a refusal by quoting the address. Only the exception's name is kept.
  const refusal = (status: number, type: string) => () => new Response(JSON.stringify({ message: 'Email address is not verified: vera@example.com' }), { status, headers: { 'x-amzn-errortype': type } });
  for (const [status, type, reason] of [[400, 'MessageRejected:http://internal.amazon.com/coral/', 'refused'], [403, 'AccessDeniedException', 'refused'], [429, 'TooManyRequestsException', 'unavailable'], [400, 'LimitExceededException', 'unavailable'], [503, '', 'unavailable']] as const) {
    answer = refusal(status, type);
    const error = await mailer.send({ to: 'vera@example.com', subject: 's', text: 't' }).then(() => null, (thrown: unknown) => thrown);
    assert.ok(error instanceof MailError);
    assert.equal(error.reason, reason, type || String(status));
    assert.ok(!`${error.message} ${error.detail} ${error.stack}`.includes('vera@'), 'the address is in no part of the error');
  }
  const sent = requests.length;
  for (const to of ['vera@example.com, boss@example.com', 'Vera <vera@example.com>', 'vera@example.com\r\nBcc: x@example.com', '']) {
    await assert.rejects(mailer.send({ to, subject: 's', text: 't' }), (error) => error instanceof MailError && error.reason === 'refused');
  }
  assert.equal(requests.length, sent, 'anything but one plain address never reaches the network');
  const offlineMailer = new SesMailer({ from: 'console@example.org', region: 'us-east-1', consoleUrl: null, configurationSet: null }, async () => { throw new Error('no AWS credentials'); }, async () => { throw new Error('must not be called'); });
  await assert.rejects(offlineMailer.send({ to: 'vera@example.com', subject: 's', text: 't' }), (error) => error instanceof MailError && error.reason === 'unavailable');
});

test('what was already true when somebody turned email on is not news; the first thing to happen afterwards is', async () => {
  const { world, outbox, pass } = delivery();
  world.items = [offline('A1'), offline('A2'), finished('run-1')];
  await pass(60);
  assert.equal(outbox.sent.length, 0, 'a week of old outcomes and every standing fault is not a first message');

  world.items = [...world.items, finished('run-7')];
  await pass();
  assert.equal(outbox.sent.length, 1);
  const mail = outbox.sent[0]!;
  assert.deepEqual([mail.to, mail.subject], ['vera@example.com', '[HKUMySeat] run-7: Failed']);
  assert.match(mail.text, /^Hello vera,\n\nTraining jobs\n- run-7: Failed, 2026-10-12 08:00 UTC\n {2}https:\/\/console\.example\.org\/train\?job=run-7\n/);
  assert.match(mail.text, /To change what is sent, or to stop it, open Account settings in the console: https:\/\/console\.example\.org\/account$/);
  assert.ok(!mail.text.includes('A1') && !mail.text.includes('run-1'), 'and it carries only the new thing');
});

test('a condition is written about once it has lasted ten minutes; one that clears sooner is never mentioned', async () => {
  const { world, outbox, pass } = delivery();
  await pass();
  world.items = [offline('A2 north')];
  await pass(HOLD_MS / MINUTE - 1);
  assert.equal(outbox.sent.length, 0, 'nine minutes offline is not yet worth an inbox');
  world.items = [];
  await pass(30);
  assert.equal(outbox.sent.length, 0, 'it came back: nothing to say');

  world.items = [offline('A2 north')];
  await pass(HOLD_MS / MINUTE + 1);
  assert.equal(outbox.sent.length, 1, 'the ten minutes are counted from when it went offline again, not from the first time');
  assert.match(outbox.sent[0]!.text, /Sensors\n- A2 north: Offline report \(No recent REPORT\)/);
});

test('the same condition on the same thing is not written about twice in a day, however often it comes and goes', async () => {
  const { world, outbox, pass } = delivery();
  await pass();
  for (let flap = 0; flap < 6; flap++) {
    world.items = [offline('A2 north')];
    await pass(40);
    world.items = [];
    await pass(20);
  }
  assert.equal(outbox.sent.length, 1, 'six hours of flapping is one message');
  await pass(REMEMBER_MS / MINUTE + 61);
  world.items = [offline('A2 north')];
  await pass(HOLD_MS / MINUTE + 1);
  assert.equal(outbox.sent.length, 2, 'a day of quiet later, it is news again');
});

test('one message carries everything that is ready, at most one in fifteen minutes and twelve a day', async () => {
  const { world, outbox, pass } = delivery();
  await pass();
  world.items = [finished('run-1'), finished('run-2', 'Completed')];
  await pass();
  assert.equal(outbox.sent.length, 1);
  assert.equal(outbox.sent[0]!.subject, '[HKUMySeat] 2 new notifications');
  assert.match(outbox.sent[0]!.text, /- run-1: Failed.*\n.*\n- run-2: Completed/);

  world.items = [...world.items, finished('run-3')];
  await pass(MIN_GAP_MS / MINUTE - 1);
  assert.equal(outbox.sent.length, 1, 'the next thing waits for the gap');
  await pass(1);
  assert.equal(outbox.sent.length, 2);

  // A new failure every minute for the rest of the day.
  for (let n = 4; n < 400; n++) { world.items = [...world.items.slice(-50), finished(`run-${n}`)]; await pass(); }
  assert.equal(outbox.sent.length, DAILY_LIMIT, 'a bad day is twelve messages, not four hundred');
  await pass(24 * 60);
  assert.equal(outbox.sent.length, DAILY_LIMIT + 1, 'what was held back goes the next day, in one message');
  assert.match(outbox.sent[DAILY_LIMIT]!.subject, /^\[HKUMySeat\] \d+ new notifications$/);
  world.items = [...world.items, finished('run-next-day')];
  await pass(MIN_GAP_MS / MINUTE);
  assert.equal(outbox.sent.length, DAILY_LIMIT + 2, 'and the day starts again');
});

test('a source that did not answer is unknown, not empty: what it said is neither forgotten nor announced', async () => {
  const { world, outbox, pass } = delivery();
  world.answered = EMAIL_TOPICS.filter((topic) => topic !== 'sensor');
  world.items = [finished('run-1')];
  await pass(5);
  world.items = [finished('run-1'), finished('run-2')];
  await pass(20);
  assert.equal(outbox.sent.length, 0, 'email does not start from half a picture');

  world.answered = [...EMAIL_TOPICS];
  world.items = [finished('run-1'), finished('run-2'), offline('A1')];
  await pass(30);
  assert.equal(outbox.sent.length, 0, 'everything there when it could first see everything is the baseline');

  world.items = [...world.items, offline('A2')];
  await pass(5);
  // The sensor source goes away for a while, in the middle of A2's ten minutes.
  world.answered = EMAIL_TOPICS.filter((topic) => topic !== 'sensor');
  world.items = world.items.filter((item) => item.topic !== 'sensor');
  await pass(30);
  world.answered = [...EMAIL_TOPICS];
  world.items = [...world.items, offline('A1'), offline('A2')];
  await pass(1);
  assert.equal(outbox.sent.length, 1, 'A2 was offline before the gap and after: its time kept counting');
  assert.ok(outbox.sent[0]!.text.includes('A2') && !outbox.sent[0]!.text.includes('A1'), 'and A1, long since known, is not announced as new');
});

test('a topic that is not ticked is not sent, and ticking it later does not send what happened meanwhile', async () => {
  const { world, outbox, pass } = delivery(['training']);
  await pass();
  world.items = [offline('A2 north'), finished('run-1')];
  await pass(30);
  assert.equal(outbox.sent.length, 1);
  assert.ok(!outbox.sent[0]!.text.includes('A2 north'));

  world.subscribers = [{ ...world.subscribers[0]!, notify: ['sensor', 'training'] }];
  await pass(30);
  assert.equal(outbox.sent.length, 1, 'the sensor was already offline when sensors were ticked');
  world.items = [...world.items, offline('B1')];
  await pass(HOLD_MS / MINUTE + 1);
  assert.equal(outbox.sent.length, 2, 'the next one is theirs');
});

test('a message that could not be sent is still news, is tried again after the gap, and the log never holds an address', async () => {
  const { world, outbox, pass } = delivery();
  await pass();
  outbox.failing = new MailError('refused', 'MessageRejected');
  world.items = [finished('run-1')];
  await pass(MIN_GAP_MS / MINUTE * 3);
  assert.equal(outbox.sent.length, 0);
  assert.deepEqual(world.logs, ['[email] a notification was not sent: refused (MessageRejected)'], 'said once, not once a minute');

  outbox.failing = null;
  await pass(MIN_GAP_MS / MINUTE);
  assert.equal(outbox.sent.length, 1, 'it went as soon as the service took it');
  await pass(60);
  assert.equal(outbox.sent.length, 1, 'once');
  assert.ok(!world.logs.join('\n').includes('vera@'));
});

test('nothing is kept about somebody who is no longer written to, and a name that comes back starts over', async () => {
  const { world, outbox, ledger, pass } = delivery();
  world.items = [finished('run-1')];
  await pass();
  assert.deepEqual(ledger.document.accounts.map((entry) => entry.name), ['vera']);
  const stored = JSON.stringify(ledger.document);
  assert.ok(!stored.includes('vera@') && !stored.includes('run-1'), 'the file says that something was sent, not what or to where');
  assert.deepEqual(parseDelivery(JSON.parse(stored)), ledger.document, 'and it is a file this console reads back');

  const writes = ledger.writes;
  await pass(30);
  assert.equal(ledger.writes, writes, 'a minute in which nothing changed writes nothing');

  // Email turned off (or the address removed): they are no longer a subscriber.
  const [subscriber] = world.subscribers;
  world.subscribers = [];
  await pass();
  assert.deepEqual(ledger.document.accounts, []);

  // The account is deleted and the name given to somebody new, who turns email on.
  world.profiles = [{ ...vera, createdAt: 2000 }];
  world.subscribers = [{ ...subscriber!, createdAt: 2000, email: 'new.vera@example.com' }];
  world.items = [finished('run-1'), finished('run-2')];
  await pass(30);
  assert.equal(outbox.sent.length, 0, 'what the last vera had or had not been told is not this one’s history');

  // A disabled account is not written to, even with its address still on file.
  world.items = [...world.items, finished('run-3')];
  world.profiles = [];
  await pass(30);
  assert.equal(outbox.sent.length, 0);
});

test('a message is plain text built from one-line fields: a label cannot add a header or a line', async () => {
  const { world, outbox, pass } = delivery();
  await pass();
  world.items = [{ ...finished('run-9'), subject: 'run-9\r\nBcc: boss@example.com\u2028', event: `Failed\n\n${'x'.repeat(400)}` }];
  await pass();
  const mail = outbox.sent[0]!;
  assert.ok(!/[\r\n\u2028]/.test(mail.subject), 'the subject is one line');
  assert.ok(mail.subject.length < 200);
  assert.ok(!mail.text.split('\n').some((row) => row.startsWith('Bcc:')), 'and the label did not start a line of its own');
});

test('a person is emailed what they could see signed in: their own role, their own unread mail, tasks given to them', async () => {
  const members = () => [{ name: 'alice', since: 0, teamRoles: [] }, { name: 'vera', since: 1000, teamRoles: [] }, { name: 'omar', since: 0, teamRoles: [] }];
  const actor = (name: string) => ({ name, since: 0, teamRoles: [], canTriage: true, isAdmin: name === 'alice' });
  let at = 5000;
  const mailbox = new Mailbox(new MemoryStore(emptyMail()), members, () => at++), board = new Board(new MemoryStore(emptyBoard()), members, () => at++);
  const asked: AdminPrincipal[] = [];
  const snapshot: NotificationSnapshot = {
    generatedAt: START, omittedCount: 0, historyLimited: true, summaries: {},
    sources: { sensor: 'available', training: 'available', firmware: 'unavailable', parameter: 'forbidden' },
    items: [
      { id: '["sensor","n1","Offline report",77]', kind: 'sensor', resourceId: 'n1', label: 'A2 north', outcome: 'Offline report', occurredAt: 77, classification: 'active', detail: 'No recent REPORT', href: '/console' },
      { id: '["firmware","rollout:r1","Rollout in progress",5]', kind: 'firmware', resourceId: 'rollout:r1', label: 'tmsense-1.8', outcome: 'Rollout in progress', occurredAt: 5, classification: 'active', href: '/updates' },
      { id: '["training","j1","Completed",9]', kind: 'training', resourceId: 'j1', label: 'run-7', outcome: 'Completed', occurredAt: 9, href: '/train?job=j1' },
    ],
  };
  const news = new RuntimeAccountNews({ execute: async (principal) => { asked.push(principal); return snapshot; } }, mailbox, board);

  const toVera = mailbox.send(actor('alice'), { to: ['vera'], subject: 'Calibration on Friday', body: 'Private words.' });
  mailbox.send(actor('alice'), { to: ['omar'], subject: 'Not for vera', body: 'x' });
  const opened = mailbox.send(actor('omar'), { to: ['vera'], subject: 'Already opened', body: 'x' });
  mailbox.mark({ ...actor('vera'), since: 1000 }, opened.id, { read: true });
  board.createTask(actor('alice'), { title: 'Mount node 12', assignee: 'vera', due: '2026-10-20' });
  board.createTask(actor('alice'), { title: 'Somebody else’s', assignee: 'omar' });
  board.createTask(actor('vera'), { title: 'A note to self', assignee: 'vera' });

  const found = await news.for(vera);
  assert.deepEqual(asked.map((principal) => [principal.name, principal.role, principal.capabilities.includes('algo.write')]), [['vera', 'viewer', false]], 'the notifications are read as a viewer reads them');
  assert.deepEqual(found.answered, ['sensor', 'training', 'parameter', 'mail', 'task'], 'firmware did not answer, and is not taken to be quiet');
  assert.deepEqual(found.items.map((item) => [item.topic, item.subject, item.event, item.ongoing]), [
    ['sensor', 'A2 north', 'Offline report', true],
    ['training', 'run-7', 'Completed', false],
    ['mail', 'From alice', 'Calibration on Friday', false],
    ['task', 'T-1 Mount node 12', 'Assigned to you, due 2026-10-20', false],
  ], 'no rollout that is merely under way, no opened mail, nobody else’s mail or tasks, no task they made themselves');
  assert.equal(found.items[0]!.key, '["sensor","n1","Offline report"]', 'a condition is the same condition however long it has lasted');
  assert.equal(found.items[2]!.key, `mail:${toVera.id}`);
  assert.ok(!JSON.stringify(found).includes('Private words'), 'the body of a message stays in the console');
});

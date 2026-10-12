# Email from the algo console

The console emails people what they asked to hear about: the same
notifications the bell shows, new team mail, tasks assigned to them. Each
person turns it on for themselves under **Account settings**
(`/account`); nobody can turn it on for somebody else.

It sends through **Amazon SES**. Until the server is configured (below)
there is no mailer at all: the API reports `emailDelivery: false` and the page
says that the address is kept and nothing is sent.

## What is sent

**One code, to confirm the address.** Typing an address proves nothing about
whose inbox it is, so nothing is sent to it but a six-digit code, and only
when its owner presses *Send confirmation code*. The code is good for 30
minutes and five tries; three codes may be asked for per quarter hour. A
changed address is unconfirmed again. This is also the test that the server's
email works: if the code arrives, everything below will.

**Notifications, as digests.** Once a minute the edge looks, for each person
with a confirmed address and at least one topic ticked, at what is true for
them now: the notification centre read under *their own* role, their own
unread mail, the tasks assigned to them. The rules
(`src/modules/algo-admin/domain/email-delivery.ts`, the only place they
live):

| Rule | Why |
|---|---|
| Nothing already true when email was turned on is news. | A first message listing a week of old outcomes and every standing fault teaches people to ignore the next one. |
| A fault that can clear by itself (a sensor offline, a parameter change waiting, an uncertain rollout) is written about once it has lasted 10 minutes. | A sensor that drops for a minute is not worth an inbox. |
| The same fault on the same thing is not written about again within 24 hours of last being seen. | Flapping is one message, not forty. |
| Work merely under way (a build, a rollout in progress) is never emailed. | It is not something that happened. |
| Everything ready goes in one message; at most one message per 15 minutes and 12 per day to a person. | A bad day stays readable, and stays inside the mail service's limits. |
| A source that did not answer is unknown, not empty. | What it last said is neither forgotten nor announced as over. |
| A topic that is not ticked is not sent, and ticking it later does not send what happened meanwhile. | |
| A message that could not be sent is still news, and is tried again after the gap; after 24 hours it is dropped. | |

Messages are plain text. A team-mail notification says who wrote and the
subject, never the body. Each one ends with how to stop it.

## What is kept, and where

Beside the account file (`ALGO_USERS_FILE`'s directory), both mode 0600:

- `account-settings.json`: the address, the ticked topics, when the address
  was confirmed, and the hash of a code that is waiting. No code is stored.
- `email-delivery.json`: per subscriber, hashes of what has already been
  said, and the day's count. It does not hold an address or what the news
  was. Whoever stops being a subscriber is removed from it on the next pass.

No address is written to a log or an error. A failed send logs one line an
hour at most, with SES's exception name and nothing else:
`[email] a notification was not sent: refused (MessageRejected)`.

## Setting it up

There are three parts: an identity in SES to send from, permission for the
server to use it, and four lines in the server's `.env`.

### 1. A sender identity in SES

SES identities belong to **one region**. Pick the region once and use it
everywhere below; the console calls `email.<region>.amazonaws.com`. It does
not have to be the region the server runs in.

1. In the SES console, in that region: *Configuration → Identities → Create
   identity → Domain*, with the domain mail should come from. Leave Easy DKIM
   on.
2. SES shows **three CNAME records**. Add them at the domain's DNS provider
   exactly as given. On Cloudflare each must be **DNS only** (grey cloud);
   a proxied CNAME never verifies. Verification usually takes minutes.
3. Add a DMARC record if the domain has none: a TXT record at `_dmarc` with
   `v=DMARC1; p=none;`. Gmail and Outlook treat mail from a domain without
   one with suspicion.
4. The sender (`EMAIL_FROM`) can then be any address at that domain. It needs
   no mailbox; replies to it go nowhere, and the messages do not ask for any.

**The sandbox.** A new SES account can only send to addresses that are
themselves verified identities, 200 messages a day. In the sandbox a
teammate's confirmation code is refused (`MessageRejected`) unless their
address was verified in SES first, and the page tells them the mail service
would not send to it. *Request production access* lifts that; AWS asks what
is sent and to whom. The honest answer: transactional notifications to the
team's own members, each of whom entered and confirmed their address, with
at most 12 messages a day per person.

### 2. Permission for the server

**On EC2, use the instance's IAM role.** No key is stored anywhere: the edge
asks the instance metadata service (IMDSv2) for the role's temporary keys and
AWS rotates them.

1. IAM → *Policies → Create policy*, JSON, with the sender address in place
   of the example:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": "ses:SendEmail",
       "Resource": "*",
       "Condition": { "StringEquals": { "ses:FromAddress": "console@example.org" } }
     }]
   }
   ```

   Sending is all it allows, and only as that one address. `Resource` is `*`
   because in the sandbox SES also checks the *recipient's* identity, which
   cannot be listed in advance.
2. IAM → *Roles → Create role → AWS service → EC2*, attach that policy. If
   the instance already has a role, attach the policy to that role instead.
3. EC2 → the instance → *Actions → Security → Modify IAM role* → choose it.
   It takes effect without a restart.

**Anywhere else** (a laptop, the Proxmox rollback machine): an IAM user with
the same policy, and its access key in `.env` as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. When both are set they are used instead of the
instance role. That key is a secret like the others in `.env`.

### 3. The server's `.env`

```
EMAIL_FROM=console@example.org        # one plain address, no display name
EMAIL_SES_REGION=ap-southeast-1       # where the identity was verified
EMAIL_CONSOLE_URL=https://console.example.org   # optional: links in messages
# EMAIL_SES_CONFIGURATION_SET=name    # optional
```

`EMAIL_FROM` and `EMAIL_SES_REGION` go together; one without the other, or a
value that is not what it should be, stops the edge at start rather than
leaving email quietly half on. The edge reads `.env` when it starts, so the
change takes effect at the next deploy or restart of `tmedge-edge`.

### 4. Check it

Sign in, open **Account settings**, save your address, press *Send
confirmation code*, and type the code in. If no code comes:

| What the page or the log says | What it means |
|---|---|
| "This server is not set up to send email yet." | `EMAIL_FROM` / `EMAIL_SES_REGION` are not in the environment the edge started with. |
| "The mail service would not send to this address." / `refused (MessageRejected)` | The account is in the sandbox and the recipient is not verified, or the sender identity is not verified in `EMAIL_SES_REGION`. |
| `refused (AccessDeniedException)` | The role's policy does not allow `ses:SendEmail` as `EMAIL_FROM` (the address must match exactly). |
| "The mail service could not be reached." / `unavailable (NoCredentials)` | No IAM role on the instance, and no keys in `.env`. |
| `unavailable (Unreachable)` | No outbound HTTPS to `email.<region>.amazonaws.com`. |

## What this does not do

- **Bounces and complaints are not read back.** SES's account-level
  suppression list (on by default) stops repeat sends to an address that
  hard-bounced; the console is not told, and still shows the address as
  confirmed. Wiring SES event notifications in is future work.
- **Students are not emailed.** This is the algo console's team only; the
  student site has no part in it.
- **No HTML, no attachments, no reply handling.**

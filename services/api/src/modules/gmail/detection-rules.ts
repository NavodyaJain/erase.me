/**
 * Detection rules that do not depend on Gmail: which domains are infrastructure rather than companies,
 * which are the user's own, and how confident a set of signals makes us. Header metadata only.
 */

export type SignalType = 'welcome' | 'receipt' | 'verify' | 'transactional' | 'list_unsubscribe' | 'newsletter';

/** Consumer mailbox providers: mail from them is a person, not a company that holds your data. */
export const MAILBOX_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'aol.com',
]);

/**
 * Email-delivery and marketing-automation infrastructure. A message sent through one of these names the
 * delivery service in the From domain, not the brand that sent it, so these are never a company (a brand may
 * still be found from Reply-To or List-Unsubscribe). Registrable domains.
 */
export const DELIVERY_DOMAINS: ReadonlySet<string> = new Set([
  'elasticemail.com',
  'elasticemail.net',
  'sendgrid.net',
  'sendgrid.com',
  'mailchimp.com',
  'mailchimpapp.net',
  'mcsv.net',
  'mcdlv.net',
  'rsgsv.net',
  'list-manage.com',
  'amazonses.com',
  'mailgun.org',
  'mailgun.com',
  'mailgun.net',
  'sparkpostmail.com',
  'sparkpost.com',
  'mandrillapp.com',
  'mailjet.com',
  'mjt.lu',
  'sendinblue.com',
  'brevo.com',
  'sendibt1.com',
  'sendibt2.com',
  'sendibt3.com',
  'sendibm1.com',
  'sendibm2.com',
  'sendibm3.com',
  'postmarkapp.com',
  'mtasv.net',
  'pm-bounces.com',
  'customeriomail.com',
  'customer.io',
  'createsend.com',
  'cmail19.com',
  'cmail20.com',
  'cmail1.com',
  'cmail2.com',
  'klaviyomail.com',
  'klaviyo.com',
  'constantcontact.com',
  'ccsend.com',
  'exacttarget.com',
  'hubspotemail.net',
  'hs-send.com',
  'intercom-mail.com',
  'mailerlite.com',
  'mlsend.com',
  'sendpulse.com',
  'pepipost.com',
  'netcoreesp.com',
  'rpmsg.com',
  'sailthru.com',
  'sgizmo.com',
  'moengage.com',
  'bnc.lt',
  'e2ma.net',
  'acemsrvc.com',
  'mailsend.co',
  'smtp2go.com',
  'zohomail.com',
  'zeptomail.com',
  'mailersend.net',
  'resend.dev',
  'beehiiv.com',
  'substack.com',
  'convertkit.com',
  'kit.com',
  'ck.page',
]);

export const isDeliveryDomain = (domain: string): boolean => DELIVERY_DOMAINS.has(domain);

/** Splits a comma, semicolon or whitespace separated list (SCAN_EXCLUDE). */
export function parseExcludeList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;\s]+/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Senders that are not companies holding the user's data: the user's own addresses, the domain of an inbox on
 * a custom domain, and a configured list (for example an employer's domains, or a full address). Entries
 * with an `@` are exact addresses; the rest are registrable domains, and also match their subdomains.
 */
export class ExcludeList {
  private readonly addresses = new Set<string>();
  private readonly domains = new Set<string>();

  /**
   * @param configured entries from SCAN_EXCLUDE
   * @param ownAddresses the user's sign-in address and every connected inbox address
   * @param registrable reduces a host to its registrable domain (injected to avoid a circular import)
   */
  constructor(
    configured: string[],
    ownAddresses: string[],
    private readonly registrable: (host: string) => string | undefined,
  ) {
    for (const entry of configured) {
      if (entry.includes('@')) this.addresses.add(entry);
      else {
        const d = registrable(entry);
        if (d) this.domains.add(d);
      }
    }
    for (const raw of ownAddresses) {
      const address = raw.toLowerCase();
      this.addresses.add(address);
      const d = registrable(address.split('@')[1] ?? '');
      // A custom-domain inbox (you@yourcompany.example) means that whole domain is the user's own.
      if (d && !MAILBOX_PROVIDERS.has(d)) this.domains.add(d);
    }
  }

  matchesAddress(address: string): boolean {
    return this.addresses.has(address.toLowerCase());
  }

  matchesDomain(domain: string): boolean {
    const d = this.registrable(domain) ?? domain;
    return this.domains.has(d);
  }
}

export type Confidence = 'high' | 'low';

const STRONG: ReadonlySet<SignalType> = new Set(['welcome', 'receipt', 'transactional']);

/**
 * How sure we are that a company holds data about the user.
 * - high: a welcome, receipt or transactional signal, or two different kinds of signal.
 * - low: a lone bulk-mail signal (list-unsubscribe or newsletter), or a lone verify prompt.
 * `list_unsubscribe` and `newsletter` are one kind of evidence (bulk mail), so together they stay low.
 */
export function confidenceFor(signals: readonly string[]): Confidence {
  const s = signals as readonly SignalType[];
  if (s.some((x) => STRONG.has(x))) return 'high';
  const kinds = new Set<string>();
  for (const x of s) kinds.add(x === 'list_unsubscribe' || x === 'newsletter' ? 'bulk' : x);
  return kinds.size >= 2 ? 'high' : 'low';
}

import { confidenceFor, isDeliveryDomain, MAILBOX_PROVIDERS, type Confidence, type ExcludeList } from './detection-rules.js';
import type { DetectedCompany } from './gmail.repository.js';

/** What a person sees for one detected company. Company-level only. Wording stays hedged: "likely" or "possible". */
export interface DetectionView {
  company: string;
  domain: string;
  firstSeen: string;
  lastSeen: string;
  /** The signals this result is based on. */
  signals: string[];
  confidence: Confidence;
  /** Needed to keep an account working (for example the account provider). No deletion request is offered. */
  mustKeep: boolean;
  category: string;
  /** The company's own account-deletion page, shown before a request by email. Never set for a must-keep company. */
  selfServeUrl: string | null;
}

const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Turns stored detections into what is shown. Rows from earlier scans are re-checked here, so a sending service
 * recorded before the delivery-domain rule, or a domain added to the exclude list later, drops out without a
 * rescan. Companies marked "not mine" are excluded everywhere (F2-AC3).
 */
export function toDetectionViews(rows: DetectedCompany[], exclude: ExcludeList): DetectionView[] {
  return rows
    .filter(
      (r) =>
        r.status !== 'not_mine' &&
        !isDeliveryDomain(r.domain) &&
        !MAILBOX_PROVIDERS.has(r.domain) &&
        !exclude.matchesDomain(r.domain),
    )
    .map((r) => ({
      company: r.company,
      domain: r.domain,
      firstSeen: day(r.firstSeen),
      lastSeen: day(r.lastSeen),
      signals: [...r.signals].sort(),
      confidence: confidenceFor(r.signals),
      mustKeep: r.mustKeep,
      category: r.category,
      selfServeUrl: r.mustKeep ? null : r.selfServeUrl,
    }))
    .sort(
      (a, b) =>
        Number(b.confidence === 'high') - Number(a.confidence === 'high') ||
        b.lastSeen.localeCompare(a.lastSeen) ||
        a.company.localeCompare(b.company),
    );
}

import { AppError, Problems } from '../../common/errors.js';
import type { AuditRepository } from '../audit/audit.repository.js';
import type { ActivityConfig } from '../gmail/activity.js';
import { ExcludeList, parseExcludeList } from '../gmail/detection-rules.js';
import { toDetectionViews, type DetectionView } from '../gmail/detections.js';
import type { GmailRepository } from '../gmail/gmail.repository.js';
import { registrableDomain } from '../gmail/signals.js';
import type { CompaniesRepository } from './companies.repository.js';

/** One detected company as the API shows it. Company-level facts only: no subjects, addresses or message text. */
export interface CompanyItem extends DetectionView {
  /** The company's open request, if the user has one that is not closed or bounced. */
  openRequest: { id: string; status: string } | null;
}

export interface CompaniesServiceDeps {
  repo: CompaniesRepository;
  gmailRepo: Pick<GmailRepository, 'listDetections' | 'listOwnAddresses'>;
  audit: AuditRepository;
  /** SCAN_EXCLUDE: domains or addresses left out of results. */
  excludeEntries: string[];
  /** ACTIVITY_RECENT_DAYS and ACTIVITY_OLD_DAYS. */
  activity: ActivityConfig;
  now?: () => Date;
}

export class CompaniesService {
  constructor(private readonly deps: CompaniesServiceDeps) {}

  /** The user's detected companies as shown to them: hidden ones (delivery services, own and employer domains) left out. */
  async list(userId: string): Promise<CompanyItem[]> {
    const [rows, own, open] = await Promise.all([
      this.deps.gmailRepo.listDetections(userId),
      this.deps.gmailRepo.listOwnAddresses(userId),
      this.deps.repo.openRequests(userId),
    ]);
    const exclude = new ExcludeList(parseExcludeList(this.deps.excludeEntries.join(' ')), own, registrableDomain);
    const now = this.deps.now?.() ?? new Date();
    return toDetectionViews(rows, exclude, { now, config: this.deps.activity }).map((v) => ({ ...v, openRequest: open.get(v.id) ?? null }));
  }

  /**
   * "Keep this" (and undo). A kept company is never offered for a request: creating one answers outcome `kept`, and a
   * request already in progress is refused at approve and send until the user clears it. A request already sent is
   * unaffected. Scoped to the signed-in user; another user's company looks missing.
   */
  async setKeep(userId: string, userCompanyId: string, kept: boolean, httpRequestId: string): Promise<CompanyItem> {
    const uc = await this.deps.repo.findUserCompany(userId, userCompanyId);
    if (!uc) throw Problems.notFound();
    if (uc.status === 'not_mine') {
      throw new AppError(409, 'company_excluded', 'Company excluded', 'You marked this company as not yours, so there is nothing to keep.');
    }
    if (uc.mustKeep || uc.riskLevel === 'must_keep') {
      throw new AppError(409, 'must_keep', 'Already kept', 'This company is needed to keep your account working, so it is already kept: no deletion request is offered for it.');
    }
    const before = (await this.list(userId)).find((c) => c.id === userCompanyId);
    if (!before) throw Problems.notFound(); // hidden from the user's list, so not theirs to change

    const changed = kept ? uc.keptAt === null : uc.keptAt !== null;
    await this.deps.repo.setKept(userId, userCompanyId, kept);
    if (changed) {
      await this.deps.audit.record({
        actorType: 'user',
        actorId: userId,
        action: kept ? 'company.keep_set' : 'company.keep_cleared',
        targetType: 'user_company',
        targetId: userCompanyId,
        requestId: httpRequestId,
      });
    }
    return { ...before, kept };
  }
}

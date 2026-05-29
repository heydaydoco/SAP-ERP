/**
 * Account determination (root CLAUDE.md §4.5).
 *
 * Maps (transaction type · material group · valuation class · …) → GL account via the
 * `account_determination` config table, editable by accounting WITHOUT code changes.
 * fi-posting calls this to resolve line accounts — posting accounts are never hard-coded.
 *
 * Interface stub; config table + resolver land in Phase 0/2.
 */
export interface AccountDeterminationKey {
  /** Posting transaction key, e.g. 'GBB' (offsetting), 'BSX' (inventory), 'VKOA' (revenue). */
  transactionKey: string;
  chartOfAccounts: string;
  /** Optional discriminators. */
  valuationClass?: string;
  materialGroup?: string;
  taxCode?: string;
  companyCode?: string;
}

export interface AccountDeterminationResolver {
  /** Resolve a GL account number for the given key, or throw if no rule matches. */
  resolve(key: AccountDeterminationKey): Promise<string>;
}

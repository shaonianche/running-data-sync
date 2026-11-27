import type { VendorStatusOptions, VendorStatusSummary } from './types.js'
import { wrapGarminLogger } from './redaction.js'
import { GARMIN_VENDOR } from './types.js'

export function resolveVendorAccount(
  vendor: string,
  account?: string | null,
  isCn = false,
): string | undefined {
  const trimmed = account?.trim()
  if (trimmed) {
    return trimmed
  }
  if (vendor === GARMIN_VENDOR) {
    return isCn ? 'garmin_cn' : 'garmin_com'
  }
  return undefined
}

/**
 * Inspect `vendor_activity_sync` status counts for a vendor/account, optionally resetting
 * failed rows back to `pending` when `retryFailed` is enabled.
 */
export async function getVendorStatus(options: VendorStatusOptions): Promise<VendorStatusSummary> {
  const vendor = options.vendor ?? GARMIN_VENDOR
  const targetAccount = resolveVendorAccount(vendor, options.account, options.isCn ?? false)
  const logger = wrapGarminLogger(options.logger, 'garmin.status')

  let retriedCount = 0
  if (options.retryFailed) {
    retriedCount = await options.store.retryFailedVendorSync(vendor, targetAccount)
    logger.info(
      `Reset ${retriedCount} failed row(s) to pending for vendor=${vendor} account=${targetAccount ?? 'all'}.`,
    )
  }

  const rows = await options.store.listVendorSyncRows({
    vendor,
    ...(targetAccount !== undefined ? { account: targetAccount } : {}),
  })

  const rawCounts = new Map<string, number>()
  for (const row of rows) {
    rawCounts.set(row.status, (rawCounts.get(row.status) ?? 0) + 1)
  }

  const counts: Record<string, number> = {}
  for (const key of Array.from(rawCounts.keys()).sort()) {
    counts[key] = rawCounts.get(key) ?? 0
  }

  const scope = targetAccount ? `vendor=${vendor} account=${targetAccount}` : `vendor=${vendor}`
  logger.info(`Vendor sync status summary (${scope}): total=${rows.length}`)

  return {
    vendor,
    account: targetAccount ?? null,
    total: rows.length,
    retriedCount,
    counts,
    rows,
  }
}

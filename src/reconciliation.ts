import type { Api } from "grammy";
import { BotDatabase } from "./database.js";
import {
  CREDIT_PACKAGES,
  PLUS_PLANS,
  PLUS_SUBSCRIPTION_PERIOD_SECONDS,
  parsePaymentPayload,
  parseSubscriptionPayload,
} from "./payments.js";

export async function reconcileStarTransactions(api: Api, db: BotDatabase): Promise<{
  credited: number;
  refunded: number;
}> {
  let credited = 0;
  let refunded = 0;
  let offset = db.getStateInt("star_transactions_offset");

  while (true) {
    const { transactions } = await api.getStarTransactions({ offset, limit: 100 });
    if (transactions.length === 0) break;
    for (const transaction of transactions) {
      const source = transaction.source;
      if (
        transaction.amount > 0
        && source?.type === "user"
        && source.transaction_type === "invoice_payment"
        && source.invoice_payload
      ) {
        const parsed = parsePaymentPayload(source.invoice_payload);
        const subscription = parseSubscriptionPayload(source.invoice_payload);
        const selected = parsed ? CREDIT_PACKAGES[parsed.packageId] : undefined;
        const selectedPlan = subscription ? PLUS_PLANS[subscription.productId] : undefined;
        const isLegacyPlusPayment = source.invoice_payload.split(":").length === 3
          && transaction.amount === 299;
        if (
          parsed
          && selected
          && parsed.telegramId === source.user.id
          && transaction.amount === selected.stars
        ) {
          db.ensureUser(source.user.id, source.user.username, source.user.first_name);
          if (db.recordPayment(
            source.user.id,
            parsed.packageId,
            selected.credits,
            selected.stars,
            source.invoice_payload,
            transaction.id,
          )) credited += 1;
        } else if (
          subscription
          && selectedPlan
          && subscription.telegramId === source.user.id
          && (transaction.amount === selectedPlan.stars || isLegacyPlusPayment)
        ) {
          db.ensureUser(source.user.id, source.user.username, source.user.first_name);
          const periodEnd = transaction.date + selectedPlan.months * PLUS_SUBSCRIPTION_PERIOD_SECONDS;
          if (db.recordSubscriptionPayment(
            source.user.id,
            transaction.amount,
            source.invoice_payload,
            transaction.id,
            periodEnd,
            true,
            {
              periodStart: transaction.date,
              requestLimit: selectedPlan.requestLimit,
              imageLimit: selectedPlan.imageLimit,
              durationMonths: selectedPlan.months,
              recurring: selectedPlan.recurring,
            },
          )) credited += 1;
        }
      }

      if (transaction.receiver?.type === "user") {
        if (db.markPaymentRefunded(transaction.id) || db.markSubscriptionPaymentRefunded(transaction.id)) {
          refunded += 1;
        }
      }
    }
    offset += transactions.length;
    db.setStateInt("star_transactions_offset", offset);
    if (transactions.length < 100) break;
  }
  return { credited, refunded };
}

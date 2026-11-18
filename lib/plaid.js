import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';

export const HISTORY_DAYS = 730; // Plaid returns at most 24 months of investment transactions

export function createPlaid({ clientId, secret, env }) {
  if (!PlaidEnvironments[env]) throw new Error(`PLAID_ENV must be sandbox or production, got "${env}"`);
  return new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { 'PLAID-CLIENT-ID': clientId, 'PLAID-SECRET': secret } },
  }));
}

export const plaidError = (err) => {
  const d = err.response?.data;
  return d ? { code: d.error_code, message: d.display_message || d.error_message } : { code: 'UNKNOWN', message: err.message };
};

async function allTransactions(plaid, accessToken, startDate, endDate) {
  const out = [];
  let total = Infinity;
  while (out.length < total) {
    const { data } = await plaid.investmentsTransactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset: out.length },
    });
    out.push(...data.investment_transactions);
    total = data.total_investment_transactions;
    if (!data.investment_transactions.length) break;
  }
  return out;
}

// One linked institution → the shape lib/portfolio.js consumes.
export async function fetchItem(plaid, item, asOf, { fresh = false } = {}) {
  const start = new Date(Date.parse(asOf) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const base = { itemId: item.item_id, institution: item.institution, historyStart: start };
  if (fresh && typeof plaid.investmentsRefresh === 'function') {
    await plaid.investmentsRefresh({ access_token: item.access_token }).catch(() => {});
  }
  let holdings;
  try {
    ({ data: holdings } = await plaid.investmentsHoldingsGet({ access_token: item.access_token }));
  } catch (err) {
    const e = plaidError(err);
    return { ...base, holdings: null, transactions: [], error: e.message, errorCode: e.code };
  }
  try {
    const transactions = await allTransactions(plaid, item.access_token, start, asOf);
    return { ...base, holdings, transactions };
  } catch (err) {
    const e = plaidError(err);
    const note = e.code === 'PRODUCT_NOT_READY'
      ? 'transaction history is still syncing, so tax lots are incomplete. Refresh in a few minutes.'
      : `could not load transaction history (${e.message}).`;
    return { ...base, holdings, transactions: [], error: note, errorCode: e.code };
  }
}

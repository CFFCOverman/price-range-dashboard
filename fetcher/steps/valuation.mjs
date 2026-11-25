/* steps/valuation.mjs — 旧 fetcher 的入口;取数与校验搬到 collect/datasets/valuation.mjs(重构 R1)。 */
import { assetPath } from '../lib/config.mjs';
import { marketDate } from '../lib/companies.mjs';
import { phase } from '../lib/ledger.mjs';
import { log } from '../lib/log.mjs';
import { VALUATION_YEARS } from '../../collect/parsers/valuation-history.mjs';
import { valuationHistory } from '../../collect/datasets/valuation.mjs';
import { apiFql } from './options.mjs';
export { valuationExpressions, cachedValuation } from '../../collect/datasets/valuation.mjs';

export const valuationFile = ticker => `${ticker} NTM Valuation History.csv`;
export async function fetchValuationHistory(ticker, { asOf = marketDate(), years = VALUATION_YEARS, request = apiFql, forceHistory = false, file = assetPath(valuationFile(ticker)) } = {}) {
  await valuationHistory(ticker, { asOf, years, request, forceHistory, file, log, phase });
  return true;
}

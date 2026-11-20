// One-off backfill uses the same step as normal fetch rounds, without fetching
// unrelated options/news or starting the monthly backtest.
import * as browser from '../fetcher/lib/browser.mjs';
import { ensureAssetDirs } from '../fetcher/lib/config.mjs';
import { step, writeSources } from '../fetcher/lib/ledger.mjs';
import { metaValuation } from '../fetcher/lib/registry.mjs';
import { fetchValuationHistory } from '../fetcher/steps/valuation.mjs';
import { TICKERS, VALID } from '../fetcher/lib/tickers.mjs';
const args=process.argv.slice(2);
const tickers=args.includes('--all')?TICKERS:args;
if(!tickers.length || tickers.some(t=>!VALID.test(t))) throw new Error('Usage: node tools/fetch-valuation.mjs NFLX-US (or --all)');
ensureAssetDirs();
try {
  await browser.ensureBrowser();
  for(const ticker of tickers) if(!await step(metaValuation(ticker),()=>fetchValuationHistory(ticker))) process.exitCode=1;
} finally {writeSources();await browser.releaseBrowser();}

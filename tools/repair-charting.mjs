import * as b from '../fetcher/lib/browser.mjs';
import { fetchCharting } from '../fetcher/steps/charting.mjs';
import { TICKERS } from '../fetcher/lib/tickers.mjs';
import { MARKETS, marketFile } from '../fetcher/lib/markets.mjs';
import { step, writeSources } from '../fetcher/lib/ledger.mjs';
import { metaCharting } from '../fetcher/lib/registry.mjs';
try {
 await b.ensureBrowser();
 for(const ticker of TICKERS) await step(metaCharting(ticker),()=>fetchCharting(ticker));
 for(const [ticker,role] of MARKETS) {const file=marketFile(ticker,role);await step(metaCharting(ticker,file,'market'),()=>fetchCharting(ticker,file));}
} finally {writeSources();await b.releaseBrowser();}

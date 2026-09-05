import * as browser from '../fetcher/lib/browser.mjs';
import { fetchCharting } from '../fetcher/steps/charting.mjs';
try { await browser.ensureBrowser(); await fetchCharting('AVGO-US'); }
finally { await browser.releaseBrowser(); }

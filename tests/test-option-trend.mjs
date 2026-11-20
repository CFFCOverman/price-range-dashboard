import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1300,height:1000}});
 await page.goto(pathToFileURL(path.resolve('options-dashboard.html')).href);
 await page.locator('#files').setInputFiles(path.resolve('Assets/options-signals/NVDA-US Options Signals.csv'));
 await page.waitForSelector('#trendChart svg');
 assert.ok(await page.locator('#trendChart circle').count()>0);
 assert.match(await page.locator('#trendSummary').innerText(),/有效/);
 await page.evaluate(()=>{
   const base={asof:'2026-09-09',signal_version:'3',quality:'usable',source:'test',interval_seconds:900,net_delta_shares:100,gross_delta_shares:100,classification_coverage:1};
   signals.set('NVDA-US',[{...base,timestamp:'2026-09-09T14:00:00Z',delta_imbalance:1},{...base,timestamp:'2026-09-09T14:15:00Z',quality:'low-coverage',delta_imbalance:-1},{...base,timestamp:'2026-09-09T14:30:00Z',delta_imbalance:-1}]);selectTrendDay();
 });
 assert.equal(await page.locator('#trendChart circle').count(),2);
 assert.equal(await page.locator('#trendChart line').count(),5);
 await page.locator('#trendChart circle').last().click();
 assert.match(await page.locator('#trendPoint').innerText(),/偏空/);
 await page.locator('#files').setInputFiles([]);
 await page.locator('#files').setInputFiles(path.resolve('Assets/options-signals/NVDA-US Options Signals.csv'));
 await page.waitForFunction(()=>signals.get('NVDA-US').length>3);
 await page.locator('#trendPanel').screenshot({path:'Assets/_logs/options-trend-preview.png'});
 console.log('PASS real signals import, signal-only selection, invalid interval gap, point details, screenshot');
}finally{await browser.close()}

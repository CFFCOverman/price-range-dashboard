import {chromium} from 'playwright';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();await page.goto(pathToFileURL(path.resolve('options-dashboard.html')).href);
 const result=await page.evaluate(()=>{
  const row={asof:'2026-09-04',source:'live',expiry:'2026-10-09',strike:230,callVol:100,putVol:0,callLast:1.1,callBid:1,callAsk:1.1,callDelta:.5,putLast:null,putBid:null,putAsk:null,putDelta:null};
  flows.set('TEST',[{...row,timestamp:'2026-09-04T18:00:00Z'},{...row,timestamp:'2026-09-04T18:05:00Z',callVol:150},{...row,asof:'2026-09-05',timestamp:'2026-09-05T12:00:00Z',callVol:150}]);
  const current=flowMap('TEST',row.expiry),history=lastHistoricalDirection('TEST',row.expiry,'2026-09-05');
  renderDateContext('TEST',row.expiry,[{fetchedAt:'2026-09-05T12:00:00Z'}],'2026-09-05','2026-09-03',current);
  return {current:current.map.size,history:history?.counts,day:history?.day,text:document.getElementById('dateContext').textContent,missing:sourceDates([{}]),explicit:sourceDates([{market_date:'2026-09-04'}]),et:etStamp('2026-09-05T01:00:00Z')};
 });
 assert.equal(result.current,0);assert.equal(result.history.up,1);assert.equal(result.day,'2026-09-04');
 assert.match(result.text,/2026-09-03 → 2026-09-05/);assert.match(result.missing,/未提供/);assert.equal(result.explicit,'2026-09-04');assert.match(result.et,/2026\/9\/4/);
 console.log('PASS weekend snapshot isolation, historical direction, OI comparison dates, missing source date, explicit source date, ET timezone');
}finally{await browser.close()}

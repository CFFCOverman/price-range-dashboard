import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1400,height:1000}});
 await page.goto(pathToFileURL(path.resolve('options-dashboard.html')).href);
 await page.locator('#files').setInputFiles(path.resolve('Assets/options/NVDA-US Options Flow.csv'));
 await page.waitForSelector('.heatcell');
 assert.ok(await page.locator('.heatcell').count()>10);
 await page.locator('.heatcell').first().click();
 assert.match(await page.locator('#heatDetail').innerText(),/行权价/);
 await page.locator('#heatPanel').screenshot({path:'Assets/_logs/options-heat-preview.png'});
 const result=await page.evaluate(()=>{
  const base={timestamp:'2026-09-09T14:00:00Z',asof:'2026-09-09',source:'live',spot:100,expiry:'2026-09-11',strike:100,callVol:0,putVol:0,callLast:1.2,callBid:1,callAsk:1.2,putLast:1.2,putBid:1,putAsk:1.2,callDelta:.5,putDelta:-.5};
  const a=[base,{...base,strike:110}],b=[{...base,timestamp:'2026-09-09T14:15:00Z',callVol:10},{...base,strike:110,timestamp:'2026-09-09T14:15:00Z',putVol:10}];
  flows.set('NVDA-US',[...a,...b]);selectHeatDay();
  const m=flowMap('NVDA-US',base.expiry,[a,b]);
  const values=[heatAssessment(m.map.get(100)).value,heatAssessment(m.map.get(110)).value];
  const balanced={r:{},legs:[{kind:'call',dv:10,action:'buy',delta:.5},{kind:'put',dv:10,action:'buy',delta:-.5}]};
  return {values,mixed:heatAssessment(balanced).value,missing:heatAssessment(null).value,reset:heatAssessment({r:{},legs:[{dv:5,action:'buy',delta:.5,reset:true}]}).value};
 });
 assert.deepEqual(result,{values:[1,-1],mixed:0,missing:null,reset:null});
 await page.locator('.heatcell').last().click();
 assert.match(await page.locator('#heatDetail').innerText(),/Call：[\s\S]*Put：/);
 console.log('PASS real flow-only import, strike direction separation, call/put cancellation, unavailable/reset gating, details');
}finally{await browser.close()}

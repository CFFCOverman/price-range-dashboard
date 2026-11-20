import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright';
import {fixture} from './test-fair-value.mjs';

const browser=await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve('price-range-dashboard.html')).href);
  await page.evaluate(()=>{fairToday=()=> '2026-10-01';localStorage.removeItem(FAIR_LEDGER_KEY);});
  const company={name:'companies.csv',mimeType:'text/csv',buffer:Buffer.from('ticker,name,currency,price,price_date,eps_fy1_mean\nTEST-US,测试公司,USD,80,2026-10-01,10\n')};
  await page.locator('#fileInput').setInputFiles([company]);
  await page.waitForFunction(()=>state.companies.size===1);
  assert.match(await page.locator('#fairOverview').innerText(),/待建模/);
  const m=fixture(), o={ticker:'TEST-US',period:'2027-01',date:'2026-10-01',mean:10,observed_at:'2026-10-01T20:00:00Z',basis:'EPS majority',currency:'USD',source:'Synthetic UI test'};
  const payload=doc=>({name:'Test Fair Value Inputs.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(doc))});
  await page.locator('#fileInput').setInputFiles([payload({document_type:'fair-value-inputs-v1',models:[m],observations:[o]})]);
  await page.waitForFunction(()=>state.fairModels.size===1);
  assert.match(await page.locator('#fairOverview').innerText(),/可用/);
  const before=await page.evaluate(()=>fairAssessment(state.companies.get('TEST-US')).result.mid);
  await page.locator('#fileInput').setInputFiles([payload({document_type:'fair-value-inputs-v1',models:[{...m,source:'reused ID'}]})]);
  await page.waitForFunction(()=>state.fairImportErrors.length===1);
  assert.match(await page.locator('#fairOverview').innerText(),/数据导入失败/);
  await page.locator('#fileInput').setInputFiles([company]);
  await page.waitForFunction(()=>state.companies.get('TEST-US').price===80);
  assert.equal(await page.evaluate(()=>state.fairImportErrors.length),1,'unrelated import cannot clear model file failure');
  await page.locator('#fileInput').setInputFiles([payload({document_type:'fair-value-inputs-v1',models:[m]})]);
  await page.waitForFunction(()=>state.fairImportErrors.length===0);
  await page.locator('#pxInput').fill('40');
  assert.equal(await page.evaluate(()=>fairAssessment(state.companies.get('TEST-US')).result.mid),before);
  await page.locator('#fileInput').setInputFiles([payload({document_type:'fair-value-inputs-v1',observations:[{...o,mean:8,observed_at:'2026-10-02T00:30:00Z'}]})]);
  await page.waitForFunction(()=>state.fairObservations.get('TEST-US|2027-01')?.mean===8);
  assert.match(await page.locator('#fairOverview').innerText(),/待复核/);
  assert.match(await page.locator('#fairOverview').innerText(),/从 10 更新到 8/);
  const count=await page.evaluate(()=>readFairLedger().length);
  assert.ok(count>=3);
  assert.equal(await page.evaluate(()=>readFairLedger().at(-1).mid),null);
  await page.locator('#fairOverview').screenshot({path:path.join(os.tmpdir(),'prd-fair-value-review.png')});
  await page.reload();
  assert.equal(await page.evaluate(()=>readFairLedger().length),count,'audit survives reload');
  assert.deepEqual(errors,[]);
  // Current private data preview: no test model is carried into production view.
  await page.evaluate(()=>localStorage.removeItem(FAIR_LEDGER_KEY));
  await page.locator('#fileInput').setInputFiles([
    path.resolve('Assets/summary/companies.csv'),
    path.resolve('Assets/summary/roster.csv'),
    path.resolve('Assets/fair-value/NVDA-US 2026-10-01 Fair Value Inputs.json')
  ].filter(p=>fs.existsSync(p)));
  await page.waitForFunction(()=>state.companies.size>1);
  await page.locator('#fairOverview').screenshot({path:path.join(os.tmpdir(),'prd-fair-value-current.png')});
  assert.equal(await page.evaluate(()=>state.fairModels.size),0);
  console.log('PASS fair-value UI: imports, price independence, after-midnight UTC earnings cut, stale-value suppression, persistent audit and private data view');
} finally {await browser.close();}

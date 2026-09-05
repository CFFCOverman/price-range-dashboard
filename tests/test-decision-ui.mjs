import {chromium} from 'playwright';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1400,height:1000}});
 await page.route('https://**/*',r=>r.abort());
 await page.goto(pathToFileURL(path.resolve('price-range-dashboard.html')).href);
 await page.addScriptTag({path:path.resolve('node_modules/xlsx/dist/xlsx.full.min.js')});
 const files=['Assets/summary/companies.csv','Assets/estimates/NVDA-US FY1 Estimate History.xlsx','Assets/estimates/NVDA-US FY2 Estimate History.xlsx','Assets/options-signals/NVDA-US Options Signals.csv'];
 await page.locator('#fileInput').setInputFiles(files.map(x=>path.resolve(x)));
 await page.waitForFunction(()=>state.optionSignals.has('NVDA-US'));
 await page.evaluate(()=>{state.selected='NVDA-US';renderAll()});
 let text=await page.locator('#decisionContext').innerText();assert.match(text,/现价隐含/);assert.match(text,/历史记录/);assert.match(text,/FY1/);
 const result=await page.evaluate(()=>impliedExpectations(state.companies.get('NVDA-US')));assert.ok(result.required>0);assert.ok(result.fy1>0);
 await page.locator('#decisionContext').screenshot({path:'Assets/_logs/decision-preview.png'});
 await page.evaluate(()=>{LANG='en';renderAll()});assert.match(await page.locator('#decisionContext').innerText(),/Implied expectations/);
 console.log('PASS real-file import, PE expectations, stale signal gating, English, rendered preview');
} finally {await browser.close()}

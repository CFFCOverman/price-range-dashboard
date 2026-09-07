import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { trySetDaily, captureChartExport } from '../fetcher/steps/charting.mjs';
const browser = await chromium.launch({headless:true});
try {
  const page = await browser.newPage();
  await page.setContent('<div>Daily</div><iframe></iframe>');
  const frame = page.frames()[1];
  await frame.setContent(`<span hidden>Daily</span><button onclick="document.querySelector('#menu').hidden=false">Periodicity</button><div id="menu" hidden><button onclick="window.frequency='daily';document.querySelector('#menu').hidden=true">Daily</button><button>Weekly</button></div>`);
  assert.equal(await trySetDaily(page),'Periodicity:Daily');
  assert.equal(await frame.evaluate(()=>window.frequency),'daily');
  await frame.setContent(`<button onclick="document.querySelector('#menu').hidden=false">W <span>(A)</span></button><div id="menu" hidden><span onclick="window.frequency='D';document.querySelector('#menu').hidden=true">D</span><span>W</span></div>`);
  assert.equal(await trySetDaily(page),'Periodicity:Daily');
  assert.equal(await frame.evaluate(()=>window.frequency),'D');
  await frame.setContent('<button>Download</button>');
  assert.equal(await trySetDaily(page),null);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'chart-blob-'));
  try {
    const output=path.join(temp,'export.xlsx');
    let nativeDownloads=0; page.on('download',()=>nativeDownloads++);
    await frame.evaluate(()=>{window.originalClick=HTMLAnchorElement.prototype.click;window.originalURL=URL.createObjectURL;});
    await captureChartExport(page, async()=>{
      await frame.evaluate(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['exact workbook bytes']));a.download='Charting.xlsx';a.click();URL.revokeObjectURL(a.href);});
      return true;
    },output);
    assert.equal(fs.readFileSync(output,'utf8'),'exact workbook bytes');
    assert.equal(nativeDownloads,0);
    assert.equal(await frame.evaluate(()=>HTMLAnchorElement.prototype.click===window.originalClick && URL.createObjectURL===window.originalURL),true);
    await assert.rejects(captureChartExport(page, async()=>{throw new Error('trigger failed');},output),/trigger failed/);
    assert.equal(await frame.evaluate(()=>HTMLAnchorElement.prototype.click===window.originalClick && !window.__prdChartExport),true);
  } finally {fs.rmSync(temp,{recursive:true,force:true});}
  console.log('PASS Charting: real W (A) / D menu, iframe isolation, Blob bytes, no native download, hook restoration');
} finally {await browser.close();}

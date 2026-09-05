/**
 * Live Options Montage reader.
 *
 * FQL P_OPT_VOLUME / P_OPT_CLOSE_PRICE are daily snapshot fields.  The Montage
 * receives changing quotes and cumulative volume through FactSet Data Monitor,
 * then renders them into a grid whose cells have stable `columnid` attributes.
 * This module reads that grid and merges FQL delta only as a hedge-weight proxy.
 */
import * as browser from '../lib/browser.mjs';
import { fetchOptionsViaApi } from './options.mjs';

const MONTAGE_URL = 'https://my.apps.factset.com/workstation/options-montage/';
const bare = ticker => String(ticker || '').split('-')[0].toUpperCase();
const number = value => {
  const match = String(value ?? '').replaceAll(',', '').match(/-?\d+(?:\.\d+)?/);
  return match ? +match[0] : '';
};
const cdf = x => {
  const t=1/(1+.2316419*Math.abs(x));
  const d=.3989423*Math.exp(-x*x/2);
  const p=1-d*t*(.3193815+t*(-.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));
  return x>=0?p:1-p;
};
function bsPrice(spot,strike,t,vol,call){
  const r=.04,s=vol*Math.sqrt(t),d1=(Math.log(spot/strike)+(r+vol*vol/2)*t)/s,d2=d1-s;
  return call?spot*cdf(d1)-strike*Math.exp(-r*t)*cdf(d2):strike*Math.exp(-r*t)*cdf(-d2)-spot*cdf(-d1);
}
function inferredDeltas(row,spot,now=Date.now()){
  // US option close expressed in UTC. One-hour DST error away from expiry is
  // immaterial; on expiry day clamp to at least one hour to avoid singularity.
  const close=Date.parse(`${row.expiry}T20:00:00Z`),t=Math.max(1/(365*24),(close-now)/(365.25*86400000));
  const callMid=row.call_bid!==''&&row.call_ask!==''?(row.call_bid+row.call_ask)/2:null;
  const putMid=row.put_bid!==''&&row.put_ask!==''?(row.put_bid+row.put_ask)/2:null;
  const useCall=row.strike>=spot,market=useCall?callMid:putMid;
  let lo=.03,hi=5;
  if(market!==null&&market>0){for(let i=0;i<50;i++){const mid=(lo+hi)/2;if(bsPrice(spot,row.strike,t,mid,useCall)<market)lo=mid;else hi=mid;}}
  const vol=market!==null&&market>0?(lo+hi)/2:.5,s=vol*Math.sqrt(t);
  const d1=(Math.log(spot/row.strike)+(.04+vol*vol/2)*t)/s;
  const call=cdf(d1);
  return {call_delta:call,put_delta:call-1};
}
function isoDate(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(value || '').trim());
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '';
}

export function parseMontageGrid(cells) {
  const grouped = new Map();
  for (const cell of cells || []) {
    if (!cell?.rowid?.includes('|') || !cell.columnid) continue;
    if (!grouped.has(cell.rowid)) grouped.set(cell.rowid, {});
    grouped.get(cell.rowid)[cell.columnid] = cell.text;
  }
  const rows = [];
  for (const x of grouped.values()) {
    const expiry = isoDate(x.expirationDate), strike = number(x.strike);
    if (!expiry || strike === '' || !x.callStrikeCode || !x.putStrikeCode) continue;
    rows.push({
      expiry, strike,
      call_oi: number(x.callOpenInterest), put_oi: number(x.putOpenInterest),
      call_volume: number(x.callCVol), put_volume: number(x.putCVol),
      call_last: number(x.callPriceLast), put_last: number(x.putPriceLast),
      call_bid: number(x.callPriceBid), call_ask: number(x.callPriceAsk),
      put_bid: number(x.putPriceBid), put_ask: number(x.putPriceAsk),
      call_delta: '', put_delta: '',
    });
  }
  return rows.sort((a,b) => a.expiry.localeCompare(b.expiry) || a.strike-b.strike);
}

async function montageFrame() {
  if (!browser.page) throw new Error('FactSet 浏览器尚未启动');
  let frame = browser.page.frames().find(f => /\/options-montage\//i.test(f.url()) && !/workstation/i.test(f.url()));
  if (!frame) {
    await browser.page.goto(MONTAGE_URL, { waitUntil:'domcontentloaded', timeout:60000 });
    await browser.page.waitForTimeout(6000);
    frame = browser.page.frames().find(f => /\/options-montage\//i.test(f.url()) && !/workstation/i.test(f.url()));
  }
  if (!frame) throw new Error('Options Montage 实时 frame 没有加载出来');
  return frame;
}

export async function fetchOptionsViaMontage(ticker) {
  const frame = await montageFrame();
  const symbol = `${bare(ticker)}-USA`;
  const input = frame.locator('input[placeholder="Enter Identifier"]');
  await input.waitFor({ state:'visible', timeout:30000 });
  if ((await input.inputValue()).toUpperCase() !== symbol) {
    await input.fill(symbol);
    await input.press('Enter');
  }
  // A previous ticker can leave a far month selected with no contracts for
  // this ticker. Reset to the first expiry month before waiting for rows.
  await browser.page.waitForTimeout(1200);
  const firstMonth=await frame.locator('body').evaluate(body=>[...body.querySelectorAll('*')]
    .find(e=>e.children.length===0&&/^[A-Z][a-z]{2} '\d{2}$/.test((e.textContent||'').trim()))?.textContent.trim());
  if(firstMonth)await frame.getByText(firstMonth,{exact:true}).last().click({force:true});
  await frame.locator(`[role="gridcell"][rowid^="${bare(ticker)}#"]`).first()
    .waitFor({ state:'attached', timeout:30000 });
  await browser.page.waitForTimeout(1800); // allow delayed-feed grid updates to settle
  if(process.env.FS_FLOW_DEBUG==='1')console.log('  · 控件诊断',await frame.locator('body').evaluate(body=>['Near 3','All'].map(label=>{const e=[...body.querySelectorAll('*')].find(x=>x.children.length===0&&(x.textContent||'').trim()===label);return e?{label,tag:e.tagName,cls:e.className,parent:e.parentElement?.outerHTML.slice(0,1200)}:{label}})));

  // The grid is virtualized and its custom scrollbar ignores programmatic
  // scrollTop changes. Select the first N expiry-month tabs instead; each tab
  // renders its near-expiry strike ladder and can be collected deterministically.
  const gridCell=frame.locator('[role="gridcell"][rowid][columnid]').first(),byCell=new Map();
  const monthLimit=Math.max(1,Math.min(6,+process.env.FS_FLOW_MONTHS||3));
  const monthLabels=await frame.locator('body').evaluate((body,limit)=>[...new Set([...body.querySelectorAll('*')]
    .filter(e=>e.children.length===0&&/^[A-Z][a-z]{2} '\d{2}$/.test((e.textContent||'').trim()))
    .map(e=>e.textContent.trim()))].slice(0,limit),monthLimit);
  if(process.env.FS_FLOW_DEBUG==='1')console.log('  · 到期月份标签',monthLabels.join(' / '));
  for(const label of monthLabels){
    await frame.getByText(label,{exact:true}).last().click({force:true});
    await browser.page.waitForTimeout(1200);
    // Montage keeps hidden grid/scroller copies in the DOM.  The first match
    // can have a zero-sized viewport, so use the element with the largest
    // vertical scroll range (the currently displayed option chain).
    const scrollerIndex=await frame.locator('.tf-grid-scroller').evaluateAll(els=>{
      let best=0,bestRange=-1;
      els.forEach((e,i)=>{const range=e.scrollHeight-e.clientHeight;if(range>bestRange){best=i;bestRange=range;}});
      return best;
    });
    const scroller=frame.locator('.tf-grid-scroller').nth(scrollerIndex);
    const viewportIndex=await frame.locator('.tf-grid-main-viewport').evaluateAll(els=>{
      let best=0,bestArea=-1;
      els.forEach((e,i)=>{const r=e.getBoundingClientRect(),area=r.width*r.height;if(area>bestArea){best=i;bestArea=area;}});
      return best;
    });
    const viewport=frame.locator('.tf-grid-main-viewport').nth(viewportIndex);
    await scroller.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll',{bubbles:true}))});
    for(let pageNo=0,stalled=0;pageNo<80&&stalled<2;pageNo++){
      const visible=await frame.locator(`[role="gridcell"][rowid^="${bare(ticker)}#"][columnid]`).evaluateAll(els =>
        els.map(e=>({rowid:e.getAttribute('rowid'),columnid:e.getAttribute('columnid'),text:(e.innerText||'').trim()})));
      for(const cell of visible)byCell.set(`${cell.rowid}|${cell.columnid}`,cell);
      const before=await scroller.evaluate(e=>e.scrollTop),box=await viewport.boundingBox();
      if(!box)break;
      await viewport.hover({force:true});
      await browser.page.mouse.wheel(0,Math.max(400,box.height*.8));
      await browser.page.waitForTimeout(140);
      const after=await scroller.evaluate(e=>e.scrollTop),max=await scroller.evaluate(e=>e.scrollHeight-e.clientHeight);
      stalled=after<=before?stalled+1:0;
      // Collect the final viewport on the next iteration before stopping.
      if(after>=max && after===before)break;
    }
    if(process.env.FS_FLOW_DEBUG==='1')console.log('  · 滚动诊断',label,await scroller.evaluate(e=>({top:e.scrollTop,max:e.scrollHeight-e.clientHeight})));
  }
  const cells=[...byCell.values()];
  const rows = parseMontageGrid(cells);
  if(process.env.FS_FLOW_DEBUG==='1')console.log('  · 实时网格诊断',JSON.stringify({cells:cells.length,rowids:new Set(cells.map(x=>x.rowid)).size,expiries:[...new Set(cells.filter(x=>x.columnid==='expirationDate').map(x=>x.text))],parsed:rows.length}));
  if (!rows.length) throw new Error(`${ticker} 的 Options Montage 实时网格没有可解析合约`);

  const detail = await frame.locator('body').innerText();
  const spot = number((/Underlying Security[\s\S]*?\nLast\s*\t?\s*([^\n]+)/i.exec(detail) || [])[1]);
  const sourceTime = ((/\nTime\s*\n\s*([^\n]+)/i.exec(detail) || [])[1] || '').trim();
  if (spot === '' || spot <= 0) throw new Error(`${ticker} 的 Options Montage 没有可用现价`);

  // Delta is not a visible default Montage column.  Use the daily FQL delta as
  // an explicit approximation, while every direction-defining field is live.
  const daily = await fetchOptionsViaApi(ticker);
  const delta = new Map(daily.rows.map(r => [`${r.expiry}|${r.strike}`, r]));
  for (const row of rows) {
    const d = delta.get(`${row.expiry}|${row.strike}`);
    if (d && d.call_delta!=='' && d.put_delta!=='') { row.call_delta=d.call_delta; row.put_delta=d.put_delta; }
    else Object.assign(row,inferredDeltas(row,spot));
  }
  return { rows, spot, source:'options-montage-live', sourceTime };
}

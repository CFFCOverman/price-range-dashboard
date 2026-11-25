// Independent rolling NTM history. Every estimate is requested as of its
// historical observation date; never divide old prices by today's forecast.
export const VALUATION_YEARS = 10;
export function valuationDates(asOf, years = VALUATION_YEARS) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf) || new Date(asOf+'T00:00:00Z').toISOString().slice(0,10)!==asOf)
    throw new Error('Invalid valuation as-of date');
  if (!Number.isInteger(years) || years < 1 || years > 30) throw new Error('Invalid history window');
  const [y,m]=asOf.split('-').map(Number),dates=[];
  for(let i=years*12;i>0;i--) dates.push(new Date(Date.UTC(y,m-1-i+1,0)).toISOString().slice(0,10));
  dates.push(asOf);
  return [...new Set(dates)];
}
const symbolKey=s=>String(s||'').toUpperCase().replace(/-USA$/,'-US');
export function scalarFql(json,ticker,expression) {
  if (!Array.isArray(json)) throw new Error('FQL 未返回数据数组');
  const matches=json.filter(x=>symbolKey(x?.$symbol)===symbolKey(ticker)&&x.$expression===expression);
  if(matches.length!==1) throw new Error(`FQL 未唯一返回 ${ticker} 的指定表达式`);
  const r=matches[0];
  if(r.$error) throw new Error(`FQL: ${r.$error_description||'表达式或权限错误'}`);
  const v=r.$value?.[0]?.[0];
  return typeof v==='number'&&Number.isFinite(v)?v:null;
}
export function valuationVerdict(rows) {
  if (!rows.length) return {ok:false,reason:'历史序列为空'};
  const positive=rows.filter(r=>r.pe_ntm>0&&r.eps_ntm>0&&r.price>0);
  if(positive.length<12) return {ok:false,reason:`仅 ${positive.length} 个有效 NTM P/E 点（至少12个）`};
  const eligible=rows.filter(r=>r.price>0);
  const missing=eligible.filter(r=>r.eps_ntm==null||(r.eps_ntm>0&&r.pe_ntm==null));
  if(missing.length>Math.max(2,eligible.length*.1)) return {ok:false,reason:`${eligible.length} 个有价格的日期中 ${missing.length} 个缺少 NTM 估值`};
  const latest=rows.at(-1);
  if(!(latest.price>0) || latest.eps_ntm==null || (latest.eps_ntm>0&&latest.pe_ntm==null)) return {ok:false,reason:'最新日期 NTM 数据缺失'};
  for(const r of positive) {
    if(Math.abs(r.pe_ntm*r.eps_ntm/r.price-1)>.03) return {ok:false,reason:`${r.date} P/E × NTM EPS 与同日股价不一致`};
  }
  return {ok:true,positive:positive.length,missing:missing.length,from:positive[0].date,to:positive.at(-1).date};
}

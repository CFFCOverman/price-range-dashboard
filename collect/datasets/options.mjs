/** options:期权链(OI/Volume/价格/Delta/报价),同源接口取数,快照合并规则见 fetcher/lib/opt-store.mjs。 */
import { fetchOptionsViaApi, saveOptionsCsv } from '../../fetcher/steps/options.mjs';
export const options = {
  key: 'options',
  async run({ symbol, file, today }) {
    const res = await fetchOptionsViaApi(symbol);
    const { total, snapshots } = saveOptionsCsv(symbol, res.rows, today, file('options', symbol));
    return { rows: total, note: `${res.legs} 条腿,${res.expiries.length} 个到期日,${snapshots} 层快照` };
  },
};

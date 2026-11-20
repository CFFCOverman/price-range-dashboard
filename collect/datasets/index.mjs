/** 数据集注册表:key → 实现。哪个数据集多久拉一次、对哪类标的拉,只看 config/params.json。 */
import { prices, consensus, valuation } from './fql-series.mjs';
import { estimates, targets, ownership } from './report-json.mjs';
import { news } from './news.mjs';
import { guidance, surprise, intel } from './report-csv.mjs';
import { options } from './options.mjs';

export const DATASETS = { prices, consensus, valuation, estimates, targets, ownership, news, guidance, surprise, ...intel, options };

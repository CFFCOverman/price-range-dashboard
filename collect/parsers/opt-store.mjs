/* collect/parsers/opt-store.mjs —— 期权快照的字段与保留期常量(按天文件的读写见 collect/datasets/options.mjs) */

/* 保留天数只在 config/params.json § datasets.options.keep_days */
export const OPT_EXTRA_FIELDS = ['fetched_at', 'call_volume', 'put_volume', 'call_delta', 'put_delta',
  'call_last', 'put_last', 'call_bid', 'call_ask', 'put_bid', 'put_ask',
  'call_iv', 'put_iv', 'call_gamma', 'put_gamma'];

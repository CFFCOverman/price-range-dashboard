/* lib/selftest-env.mjs — 只做一件事:让 --selftest 别把测试文件写进你的 Assets/
 *
 * 为什么单独一个文件、而且必须是入口的**第一个** import:
 * `config.mjs` 里的 OUT_DIR 是模块顶层的 const,一旦那个模块被求值就定死了。
 * ESM 的 import 全部先于模块体执行,所以在 factset-fetch.mjs 的函数体里改
 * process.env.FS_OUT 已经太晚。只有把"改环境变量"本身做成一个排在前面的 import,
 * 才能赶在 config 被求值之前生效。
 *
 * 这个坑是真踩出来的:自检里的 saveEstimateXlsx('TEST-US', ...) 和
 * xlsxHasVolume 的三个 '_selftest *.xlsx' 一直往真实的 Assets/ 里写,
 * 于是 estimates/ 里长出一个从来没人拉过的 TEST-US,misc/ 里躺着三个测试用 xlsx。
 * 后来加的"清单与数据对齐"检查一扫,理所当然地把 TEST-US 当成"你拉过但忘了登记的标的"。
 * 一个自检污染了它本该验证的东西,再由另一个检查如实报告出来——每一步都没错,合起来是错的。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SELFTEST_SANDBOX = (process.argv.includes('--selftest') && !process.env.FS_OUT)
  ? (process.env.FS_OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'price-range-selftest-')))
  : '';

/** 自检曾经留在真实 Assets/ 里的文件名。按**精确文件名**认,不做模式猜测——
 *  猜测会误伤你真的叫 TEST 的什么东西,而这几个名字是代码里写死的,不会有第二种来源。 */
export const SELFTEST_ARTIFACTS = [
  'TEST-US FY1 Estimate History.xlsx',
  'TEST-US FY2 Estimate History.xlsx',
  '_selftest vol.xlsx',
  '_selftest vol2.xlsx',
  '_selftest novol.xlsx',
];

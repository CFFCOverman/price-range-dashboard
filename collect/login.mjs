#!/usr/bin/env node
/** 只登录一次:开可见窗口,登录成功后保存登录态并退出。计划任务之前、或提示登录失效时运行。 */
import { openSession, closeSession } from './lib/session.mjs';
await openSession({ mode: 'visible' });
console.log('✔ 已登录,登录态已保存。');
await closeSession();

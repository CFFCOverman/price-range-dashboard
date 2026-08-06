/* ================= 文件夹连接(File System Access API;记忆通过 IndexedDB,不可用时静默降级) ================= */
let dirHandle = null;
function idbOpen() {
  return new Promise((res, rej) => {
    try {
      const rq = indexedDB.open('prd-db', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('handles');
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    } catch (e) { rej(e); }
  });
}
async function idbSet(k, v) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(v, k);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* 存储不可用(如 artifact 沙箱)时静默跳过 */ }
}
async function idbGet(k) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const rq = db.transaction('handles', 'readonly').objectStore('handles').get(k);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  } catch (e) { return null; }
}
async function collectDirFiles(handle, depth, out) {
  for await (const entry of handle.values()) {
    if (entry.kind === 'file' && /\.(csv|xlsx|xls)$/i.test(entry.name)) out.push(await entry.getFile());
    else if (entry.kind === 'directory' && depth < 3) await collectDirFiles(entry, depth + 1, out);
  }
}
async function scanFolder() {
  if (!dirHandle) return;
  const files = [];
  try { await collectDirFiles(dirHandle, 0, files); } catch (e) { renderAll(t('fsDenied')); return; }
  if (!files.length) { renderAll(t('fsNoFiles')(dirHandle.name)); return; }
  files.sort((a, b) => a.lastModified - b.lastModified);   /* 旧→新:最新文件最后导入、覆盖生效 */
  await handleFiles(files);
  const st = $('status');
  st.insertBefore(el('span', 'ok', t('fsScanned')(dirHandle.name, files.length) + ' '), st.firstChild);
  $('rescanBtn').hidden = false;
  $('reconnectBtn').hidden = true;
}
$('dirBtn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) { renderAll(t('fsUnsupported')); return; }
  try { dirHandle = await window.showDirectoryPicker({ mode: 'read' }); } catch (e) { return; /* 用户取消 */ }
  idbSet('dir', dirHandle);
  scanFolder();
});
$('rescanBtn').addEventListener('click', scanFolder);
$('reconnectBtn').addEventListener('click', async () => {
  const h = await idbGet('dir');
  if (!h) { $('reconnectBtn').hidden = true; return; }
  try {
    if (h.requestPermission && await h.requestPermission({ mode: 'read' }) !== 'granted') { renderAll(t('fsDenied')); return; }
  } catch (e) { renderAll(t('fsDenied')); return; }
  dirHandle = h;
  scanFolder();
});
idbGet('dir').then(h => { if (h && window.showDirectoryPicker) $('reconnectBtn').hidden = false; });

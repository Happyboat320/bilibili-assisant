/* 已完成的个人训练头保存在扩展 IndexedDB；基础模型使用浏览器模型缓存。 */
(function (root) {
  'use strict';
  function createCheckpointStore() {
    let database;
    async function open() {
      if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open('bili-preference', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('weights');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return database;
    }
    async function transaction(mode, operation) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('weights', mode);
        const request = operation(tx.objectStore('weights'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('训练权重保存失败。'));
      });
    }
    return {
      get: () => transaction('readonly', store => store.get('head')),
      put: value => transaction('readwrite', store => store.put(value, 'head')),
      clear: () => transaction('readwrite', store => store.delete('head'))
    };
  }
  root.BiliPreferenceStore = createCheckpointStore;
  if (typeof module !== 'undefined') module.exports = createCheckpointStore;
})(globalThis);

// can the engine keep a File in IndexedDB (an ephemeral context, like a private window)?
import { webkit, firefox, chromium } from '@playwright/test';
for (const [name, bt] of [['webkit', webkit], ['firefox', firefox], ['chromium', chromium]] as const) {
  const b = await bt.launch(); const p = await b.newPage();
  await p.goto('http://localhost:5207/');
  console.log(name, await p.evaluate(() => new Promise<string>(res => {
    const r = indexedDB.open('probe-blob', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('s');
    r.onerror = () => res('open error ' + r.error);
    r.onsuccess = () => {
      const db = r.result;
      try {
        const t = db.transaction('s', 'readwrite');
        const q = t.objectStore('s').put({ zips: [new File(['abc'], 'a.zip', { type: 'application/zip' })] }, 'k');
        q.onerror = () => res('put error ' + q.error?.name + ': ' + q.error?.message);
        t.oncomplete = () => res('stored');
        t.onabort = () => res('aborted ' + t.error?.name + ': ' + t.error?.message);
      } catch (e: any) { res('threw ' + e.name + ': ' + e.message); }
    };
  })));
  await b.close();
}

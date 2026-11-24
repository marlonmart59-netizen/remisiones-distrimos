/* Cola de entregas hechas sin internet (IndexedDB).
 * Cada entrega (firmas, foto, receptor) se guarda aquí hasta que el servidor la confirme.
 * Se mantiene una copia en memoria para consultarla de forma síncrona.
 */
(function () {
  'use strict';
  const NOMBRE = 'remisiones-sin-conexion';
  const TABLA = 'cola';
  let items = [];

  function abrir() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) return reject(new Error('Este navegador no permite guardar datos sin conexión.'));
      const q = indexedDB.open(NOMBRE, 1);
      q.onupgradeneeded = () => q.result.createObjectStore(TABLA, { keyPath: 'id' });
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error || new Error('No se pudo abrir el almacenamiento local.'));
    });
  }

  function operar(modo, fn) {
    return abrir().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(TABLA, modo);
      const res = fn(tx.objectStore(TABLA));
      tx.oncomplete = () => { db.close(); resolve(res && res.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('Operación cancelada.')); };
    }));
  }

  const listo = operar('readonly', (s) => s.getAll())
    .then((r) => { items = (r || []).sort((a, b) => a.creado.localeCompare(b.creado)); })
    .catch(() => { items = []; });

  window.SinConexion = {
    listo,
    items: () => items.slice(),
    cantidad: () => items.length,
    de: (remisionId) => items.find((i) => i.remisionId === remisionId) || null,
    async encolar(item) {
      const it = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, creado: new Date().toISOString(), ...item };
      await operar('readwrite', (s) => s.put(it));
      items.push(it);
      return it;
    },
    async quitar(id) {
      await operar('readwrite', (s) => s.delete(id));
      items = items.filter((i) => i.id !== id);
    },
  };
})();

import * as Y from 'yjs'
import * as idb from 'lib0/indexeddb.js'
import * as mutex from 'lib0/mutex.js'
import { Observable } from 'lib0/observable.js'

const customStoreName = 'custom'
const updatesStoreName = 'updates'

export const PREFERRED_TRIM_SIZE = 500

/**
 * @param {FilesystemPersistence} fsPersistence
 */
export const fetchUpdates = fsPersistence => {
  const [updatesStore] = idb.transact(/** @type {IDBDatabase} */(fsPersistence.db), [updatesStoreName]) // , 'readonly')
  return idb.getAll(updatesStore, idb.createIDBKeyRangeLowerBound(fsPersistence._dbref, false)).then(updates =>
    fsPersistence._mux(() =>
      updates.forEach(val => Y.applyUpdate(fsPersistence.doc, val))
    )
  )
    .then(() => idb.getLastKey(updatesStore).then(lastKey => { fsPersistence._dbref = lastKey + 1 }))
    .then(() => idb.count(updatesStore).then(cnt => { fsPersistence._dbsize = cnt }))
    .then(() => updatesStore)
}

/**
 * @param {FilesystemPersistence} fsPersistence
 * @param {boolean} forceStore
 */
export const storeState = (fsPersistence, forceStore = true) =>
  fetchUpdates(fsPersistence)
    .then(updatesStore => {
      if (forceStore || fsPersistence._dbsize >= PREFERRED_TRIM_SIZE) {
        idb.addAutoKey(updatesStore, Y.encodeStateAsUpdate(fsPersistence.doc))
          .then(() => idb.del(updatesStore, idb.createIDBKeyRangeUpperBound(fsPersistence._dbref, true)))
          .then(() => idb.count(updatesStore).then(cnt => { fsPersistence._dbsize = cnt }))
      }
    })

/**
 * @param {string} name
 */
export const clearDocument = name => idb.deleteDB(name)

/**
 * @extends Observable<string>
 */
export class FilesystemPersistence extends Observable {
  /**
   * @param {string} name
   * @param {Y.Doc} doc
   */
  constructor (name, doc) {
    super()
    this.doc = doc
    this.name = name
    this._mux = mutex.createMutex()
    this._dbref = 0
    this._dbsize = 0
    /**
     * @type {IDBDatabase|null}
     */
    this.db = null
    this.synced = false
    this._db = idb.openDB(name, db =>
      idb.createStores(db, [
        ['updates', { autoIncrement: true }],
        ['custom']
      ])
    )
    /**
     * @type {Promise<FilesystemPersistence>}
     */
    this.whenSynced = this._db.then(db => {
      this.db = db
      const currState = Y.encodeStateAsUpdate(doc)
      return fetchUpdates(this).then(updatesStore => idb.addAutoKey(updatesStore, currState)).then(() => {
        this.emit('synced', [this])
        this.synced = true
        return this
      })
    })
    /**
     * Timeout in ms untill data is merged and persisted in idb.
     */
    this._storeTimeout = 1000
    /**
     * @type {any}
     */
    this._storeTimeoutId = null
    /**
     * @param {Uint8Array} update
     */
    this._storeUpdate = update =>
      this._mux(() => {
        if (this.db) {
          const [updatesStore] = idb.transact(/** @type {IDBDatabase} */(this.db), [updatesStoreName])
          idb.addAutoKey(updatesStore, update)
          if (++this._dbsize >= PREFERRED_TRIM_SIZE) {
            // debounce store call
            if (this._storeTimeoutId !== null) {
              clearTimeout(this._storeTimeoutId)
            }
            this._storeTimeoutId = setTimeout(() => {
              storeState(this, false)
              this._storeTimeoutId = null
            }, this._storeTimeout)
          }
        }
      })
    doc.on('update', this._storeUpdate)
  }

  destroy () {
    if (this._storeTimeoutId) {
      clearTimeout(this._storeTimeoutId)
    }
    this.doc.off('update', this._storeUpdate)
    return this._db.then(db => {
      db.close()
    })
  }

  /**
   * Destroys this instance and removes all data from indexeddb.
   */
  clearData () {
    this.destroy().then(() => {
      idb.deleteDB(this.name)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<String | number | ArrayBuffer | Date | any>}
   */
  get (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName], 'readonly')
      return idb.get(custom, key)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @param {String | number | ArrayBuffer | Date} value
   * @return {Promise<String | number | ArrayBuffer | Date>}
   */
  set (key, value) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.put(custom, key, value)
    })
  }

  /**
   * @param {String | number | ArrayBuffer | Date} key
   * @return {Promise<undefined>}
   */
  del (key) {
    return this._db.then(db => {
      const [custom] = idb.transact(db, [customStoreName])
      return idb.del(custom, key)
    })
  }
}

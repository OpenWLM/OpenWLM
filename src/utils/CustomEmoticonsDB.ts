/**
 * UTILITAIRE DE GESTION DU CACHE DES ÉMOTICÔNES PERSONNALISÉES (IndexedDB)
 * - Trousseau local des clés privées d'émoticônes du propriétaire
 * - Cache local des assets déchiffrés (évite les re-téléchargements)
 * - Politique de purge LRU (Max 200 entrées pour borner le stockage)
 */

export interface MyEmoticonRecord {
  id: string;             // assetId (ex: emo_uuid)
  shortcut: string;       // ex: (chat)
  keyBase64: string;      // Clé AES-256 en base64
  mimeType: string;       // image/png, image/gif...
  width: number;
  height: number;
  isAnimated: number;
  createdAt: number;
}

export interface CachedEmoticonAsset {
  assetId: string;
  blob: Blob;
  mimeType: string;
  keyBase64: string;
  lastAccessed: number;
  size: number;
}

const DB_NAME = 'WLM_CustomEmoticons_v1';
const DB_VERSION = 1;
const STORE_MY_KEYS = 'my_keys';
const STORE_ASSET_CACHE = 'asset_cache';
const MAX_CACHE_ENTRIES = 200;
const PURGE_BATCH_SIZE = 50;

class CustomEmoticonsDB {
  private db: IDBDatabase | null = null;
  private memoryUrls = new Map<string, string>(); // assetId -> ObjectUrl

  public async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_MY_KEYS)) {
          const myStore = db.createObjectStore(STORE_MY_KEYS, { keyPath: 'id' });
          myStore.createIndex('shortcut', 'shortcut', { unique: true });
        }
        if (!db.objectStoreNames.contains(STORE_ASSET_CACHE)) {
          const cacheStore = db.createObjectStore(STORE_ASSET_CACHE, { keyPath: 'assetId' });
          cacheStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }
      };
      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };
      request.onerror = (e) => reject(e);
    });
  }

  // --- GESTION DU TROUSSEAU DU PROPRIÉTAIRE ---

  public async saveMyEmoticon(record: MyEmoticonRecord): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_MY_KEYS], 'readwrite');
      const store = tx.objectStore(STORE_MY_KEYS);
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  public async getMyEmoticons(): Promise<MyEmoticonRecord[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_MY_KEYS], 'readonly');
      const store = tx.objectStore(STORE_MY_KEYS);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = (e) => reject(e);
    });
  }

  public async deleteMyEmoticon(id: string): Promise<void> {
    if (!this.db) await this.init();
    if (this.memoryUrls.has(id)) {
      URL.revokeObjectURL(this.memoryUrls.get(id)!);
      this.memoryUrls.delete(id);
    }
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_MY_KEYS, STORE_ASSET_CACHE], 'readwrite');
      tx.objectStore(STORE_MY_KEYS).delete(id);
      tx.objectStore(STORE_ASSET_CACHE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  public async deleteMyEmoticonByShortcut(shortcut: string): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_MY_KEYS, STORE_ASSET_CACHE], 'readwrite');
      const myStore = tx.objectStore(STORE_MY_KEYS);
      const cacheStore = tx.objectStore(STORE_ASSET_CACHE);
      const index = myStore.index('shortcut');
      const req = index.get(shortcut);
      req.onsuccess = () => {
        const record = req.result as MyEmoticonRecord | undefined;
        if (record) {
          if (this.memoryUrls.has(record.id)) {
            URL.revokeObjectURL(this.memoryUrls.get(record.id)!);
            this.memoryUrls.delete(record.id);
          }
          myStore.delete(record.id);
          cacheStore.delete(record.id);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  // --- GESTION DU CACHE DES ASSETS DÉCHIFFRÉS ---

  public async getCachedAsset(assetId: string): Promise<Blob | null> {
    if (!this.db) await this.init();
    return new Promise((resolve) => {
      const tx = this.db!.transaction([STORE_ASSET_CACHE], 'readwrite');
      const store = tx.objectStore(STORE_ASSET_CACHE);
      const req = store.get(assetId);
      req.onsuccess = () => {
        const item: CachedEmoticonAsset = req.result;
        if (item) {
          // Mettre à jour lastAccessed pour la politique LRU
          item.lastAccessed = Date.now();
          store.put(item);
          resolve(item.blob);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  public async saveCachedAsset(assetId: string, blob: Blob, mimeType: string, keyBase64: string): Promise<void> {
    if (!this.db) await this.init();
    await this.pruneCacheIfNeeded();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_ASSET_CACHE], 'readwrite');
      const store = tx.objectStore(STORE_ASSET_CACHE);
      const record: CachedEmoticonAsset = {
        assetId,
        blob,
        mimeType,
        keyBase64,
        lastAccessed: Date.now(),
        size: blob.size
      };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e);
    });
  }

  /**
   * Retourne ou crée une URL locale (blob:) pour affichage direct en mémoire
   */
  public getOrCreateObjectUrl(assetId: string, blob: Blob): string {
    if (this.memoryUrls.has(assetId)) {
      return this.memoryUrls.get(assetId)!;
    }
    const url = URL.createObjectURL(blob);
    this.memoryUrls.set(assetId, url);
    return url;
  }

  public getMemoryUrl(assetId: string): string | undefined {
    return this.memoryUrls.get(assetId);
  }

  /**
   * Politique de purge LRU : limite le cache à MAX_CACHE_ENTRIES
   */
  private async pruneCacheIfNeeded(): Promise<void> {
    if (!this.db) return;
    return new Promise((resolve) => {
      const tx = this.db!.transaction([STORE_ASSET_CACHE], 'readwrite');
      const store = tx.objectStore(STORE_ASSET_CACHE);
      const countReq = store.count();

      countReq.onsuccess = () => {
        if (countReq.result <= MAX_CACHE_ENTRIES) {
          return resolve();
        }

        // Récupérer les entrées par ordre d'ancienneté d'accès
        const index = store.index('lastAccessed');
        const cursorReq = index.openCursor();
        let deleted = 0;

        cursorReq.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest).result;
          if (cursor && deleted < PURGE_BATCH_SIZE) {
            const assetId = cursor.primaryKey as string;
            if (this.memoryUrls.has(assetId)) {
              URL.revokeObjectURL(this.memoryUrls.get(assetId)!);
              this.memoryUrls.delete(assetId);
            }
            cursor.delete();
            deleted++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => resolve();
      };
      countReq.onerror = () => resolve();
    });
  }

  /**
   * Nettoie toutes les URLs d'objet mémoire créées lors de la session
   */
  public cleanupMemoryUrls(): void {
    for (const url of this.memoryUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.memoryUrls.clear();
  }
}

export default new CustomEmoticonsDB();

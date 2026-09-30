/**
 * UTILITAIRE DE STOCKAGE LOCAL (IndexedDB)
 * Permet de conserver l'historique des messages localement dans le navigateur.
 * Les données sont CHIFFRÉES avant d'être stockées pour une sécurité totale.
 */

import { encryptForLocal, decryptFromLocal } from './Security';

const DB_NAME = 'WLM_LocalHistory_v3'; // Version 3 avec déduplication stricte et setHistory
const DB_VERSION = 1;
const STORE_NAME = 'messages';

class LocalDB {
  private db: IDBDatabase | null = null;

  public async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('chatId', 'chatId', { unique: false });
        }
      };
      request.onsuccess = (event: Event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve();
      };
      request.onerror = (e) => reject(e);
    });
  }

  /**
   * Sauvegarde un message localement (CHIFFRÉ)
   */
  public async saveMessage(chatId: string | number, message: unknown, publicKeyJwk: JsonWebKey): Promise<void> {
    if (!this.db) await this.init();
    
    // On ne stocke que les données essentielles chiffrées
    const encryptedPayload = await encryptForLocal(message, publicKeyJwk);
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.add({ chatId: String(chatId), encryptedData: encryptedPayload });
      transaction.oncomplete = () => resolve();
      transaction.onerror = (e) => reject(e);
    });
  }

  /**
   * Remplace l'historique complet pour une conversation (élimine tout doublon)
   */
  public async setHistory(chatId: string | number, messages: unknown[], publicKeyJwk: JsonWebKey): Promise<void> {
    if (!this.db) await this.init();
    await this.clearHistory(chatId);
    
    for (const msg of messages) {
      await this.saveMessage(chatId, msg, publicKeyJwk);
    }
  }

  /**
   * Récupère tous les messages pour une conversation (DÉCHIFFRÉS et DÉDUPLIQUÉS)
   */
  public async getMessages<T = unknown>(chatId: string | number, privateKeyJwk: JsonWebKey): Promise<T[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('chatId');
      const request = index.getAll(IDBKeyRange.only(String(chatId)));

      request.onsuccess = async () => {
        const results = request.result;
        const decryptedMessages: T[] = [];
        const seenKeys = new Set<string>();
        
        for (const item of results) {
          const decrypted = await decryptFromLocal(item.encryptedData, privateKeyJwk);
          if (decrypted) {
            const d = decrypted as Record<string, unknown>;
            const dedupeKey = d.id 
              ? `id_${d.id}` 
              : `${d.sender_id || d.sender || ''}_${d.text || ''}_${d.timestamp || d.time || ''}`;
            if (!seenKeys.has(dedupeKey)) {
              seenKeys.add(dedupeKey);
              decryptedMessages.push(decrypted as T);
            }
          }
        }
        resolve(decryptedMessages);
      };
      request.onerror = (e) => reject(e);
    });
  }

  public async clearAll(): Promise<void> {
    if (!this.db) await this.init();
    const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
  }

  public async clearHistory(chatId: string | number): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('chatId');
      const request = index.openKeyCursor(IDBKeyRange.only(String(chatId)));

      request.onsuccess = (event: Event) => {
        const cursor = (event.target as IDBRequest<IDBCursor | null>).result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          resolve();
        }
      };
      request.onerror = (e) => reject(e);
    });
  }
}

export default new LocalDB();

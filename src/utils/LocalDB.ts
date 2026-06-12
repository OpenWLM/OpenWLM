/**
 * UTILITAIRE DE STOCKAGE LOCAL (IndexedDB)
 * Permet de conserver l'historique des messages localement dans le navigateur.
 * Les données sont CHIFFRÉES avant d'être stockées pour une sécurité totale.
 */

import { encryptForLocal, decryptFromLocal } from './Security';

const DB_NAME = 'WLM_LocalHistory_v2'; // Version 2 pour le chiffrement
const DB_VERSION = 1;
const STORE_NAME = 'messages';

class LocalDB {
  private db: IDBDatabase | null = null;

  public async init(): Promise<void> {
    if (this.db) return;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('chatId', 'chatId', { unique: false });
        }
      };
      request.onsuccess = (event: any) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = (e) => reject(e);
    });
  }

  /**
   * Sauvegarde un message localement (CHIFFRÉ)
   */
  public async saveMessage(chatId: string | number, message: any, publicKeyJwk: any): Promise<void> {
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
   * Récupère tous les messages pour une conversation (DÉCHIFFRÉS)
   */
  public async getMessages(chatId: string | number, privateKeyJwk: any): Promise<any[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const index = store.index('chatId');
      const request = index.getAll(IDBKeyRange.only(String(chatId)));

      request.onsuccess = async () => {
        const results = request.result;
        const decryptedMessages = [];
        
        for (const item of results) {
          const decrypted = await decryptFromLocal(item.encryptedData, privateKeyJwk);
          if (decrypted) {
            decryptedMessages.push(decrypted);
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

      request.onsuccess = (event: any) => {
        const cursor = event.target.result;
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

/**
 * UTILITAIRE DE GESTION DU STOCKAGE LOCAL SÉCURISÉ DES CLÉS E2EE (IndexedDB + Web Crypto)
 * 
 * Architecture de sécurité :
 * 1. Stocke les clés privées en tant qu'objets natifs CryptoKey avec { extractable: false }.
 * 2. Utilise le clonage structuré (Structured Clone) natif d'IndexedDB pour persister la CryptoKey.
 * 3. AUCUNE clé privée brute (JWK, PKCS#8, base64) n'est jamais stockée dans localStorage ou sessionStorage.
 * 4. Défense en profondeur contre l'exfiltration : Le moteur cryptographique du navigateur
 *    refuse l'exportation de clés non extractibles via crypto.subtle.exportKey(),
 *    ce qui réduit significativement le risque d'exfiltration directe par rapport à un stockage classique.
 * 5. Tolérance aux pannes : Toutes les méthodes gèrent les exceptions (quota, navigation privée, indisponibilité IDB)
 *    sans interrompre le flux d'authentification de l'utilisateur.
 */

export interface DeviceKeyRecord {
  userId: number;
  username: string;
  publicKeyJwk: JsonWebKey;
  privateCryptoKey: CryptoKey;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface KeyStorageResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

const DB_NAME = 'WLM_DeviceVault_v1';
const DB_VERSION = 1;
const STORE_NAME = 'e2ee_keys';

class E2EEKeyStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Vérifie la disponibilité d'IndexedDB et de Web Crypto dans l'environnement actuel
   */
  public isSupported(): boolean {
    return typeof window !== 'undefined' &&
      typeof window.indexedDB !== 'undefined' &&
      typeof window.crypto !== 'undefined' &&
      typeof window.crypto.subtle !== 'undefined';
  }

  /**
   * Initialise la base de données IndexedDB dédiée au coffre-fort d'appareil
   */
  public async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    if (!this.isSupported()) {
      throw new Error("IndexedDB ou Web Crypto n'est pas disponible dans ce navigateur.");
    }

    this.initPromise = new Promise<void>((resolve, reject) => {
      try {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'userId' });
          }
        };

        request.onsuccess = (event) => {
          this.db = (event.target as IDBOpenDBRequest).result;
          resolve();
        };

        request.onerror = () => {
          this.initPromise = null;
          reject(request.error || new Error("Échec d'ouverture d'IndexedDB"));
        };

        request.onblocked = () => {
          console.warn("[E2EEKeyStorage] Ouverture d'IndexedDB bloquée par une autre instance.");
        };
      } catch (err) {
        this.initPromise = null;
        reject(err);
      }
    });

    return this.initPromise;
  }

  /**
   * Persiste la paire de clés E2EE sur cet appareil (CryptoKey non extractible)
   * En cas d'échec (quota, sandbox), ne lève pas d'exception non gérée : renvoie { success: false, error }.
   */
  public async saveKeys(
    userId: number,
    username: string,
    publicKeyJwk: JsonWebKey,
    privateCryptoKey: CryptoKey
  ): Promise<KeyStorageResult> {
    try {
      if (!this.isSupported()) {
        return { success: false, error: "Web Crypto / IndexedDB non disponible" };
      }

      await this.init();

      if (!this.db) {
        return { success: false, error: "Base de données non initialisée" };
      }

      const record: DeviceKeyRecord = {
        userId,
        username,
        publicKeyJwk,
        privateCryptoKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1
      };

      return await new Promise<KeyStorageResult>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.put(record);

          tx.oncomplete = () => {
            resolve({ success: true });
          };

          tx.onerror = () => {
            console.warn("[E2EEKeyStorage] Erreur transaction saveKeys:", tx.error);
            resolve({ success: false, error: tx.error?.message || "Erreur de stockage" });
          };

          tx.onabort = () => {
            console.warn("[E2EEKeyStorage] Transaction interrompue:", tx.error);
            resolve({ success: false, error: tx.error?.message || "Transaction interrompue" });
          };
        } catch (txErr: unknown) {
          const msg = txErr instanceof Error ? txErr.message : "Exception transaction";
          console.warn("[E2EEKeyStorage] Exception transaction saveKeys:", txErr);
          resolve({ success: false, error: msg });
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue";
      console.warn("[E2EEKeyStorage] Échec saveKeys:", err);
      return { success: false, error: msg };
    }
  }

  /**
   * Récupère les clés persistées pour un utilisateur donné
   */
  public async getKeys(
    userId: number
  ): Promise<KeyStorageResult<{ publicKeyJwk: JsonWebKey; privateCryptoKey: CryptoKey }>> {
    try {
      if (!this.isSupported()) {
        return { success: false, error: "Web Crypto / IndexedDB non disponible" };
      }

      await this.init();

      if (!this.db) {
        return { success: false, error: "Base de données non initialisée" };
      }

      return await new Promise((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(userId);

          req.onsuccess = () => {
            const result = req.result as DeviceKeyRecord | undefined;
            if (!result || !result.privateCryptoKey || !result.publicKeyJwk) {
              resolve({ success: false, error: "Aucune clé trouvée pour cet utilisateur" });
              return;
            }

            // Vérification basique d'intégrité de la CryptoKey
            const privKey = result.privateCryptoKey;
            const isKeyObj = typeof privKey === 'object' && privKey !== null;
            if (!isKeyObj) {
              resolve({ success: false, error: "Clé privée corrompue" });
              return;
            }

            resolve({
              success: true,
              data: {
                publicKeyJwk: result.publicKeyJwk,
                privateCryptoKey: result.privateCryptoKey
              }
            });
          };

          req.onerror = () => {
            resolve({ success: false, error: req.error?.message || "Erreur lecture" });
          };
        } catch (txErr: unknown) {
          const msg = txErr instanceof Error ? txErr.message : "Exception transaction lecture";
          resolve({ success: false, error: msg });
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue";
      console.warn("[E2EEKeyStorage] Échec getKeys:", err);
      return { success: false, error: msg };
    }
  }

  /**
   * Supprime les clés persistées pour un utilisateur (oubli de l'appareil / déconnexion)
   */
  public async removeKeys(userId: number): Promise<boolean> {
    try {
      if (!this.isSupported()) return true;
      await this.init();
      if (!this.db) return true;

      return await new Promise<boolean>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.delete(userId);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    } catch (e) {
      console.warn("[E2EEKeyStorage] Erreur removeKeys:", e);
      return false;
    }
  }

  /**
   * Purge toutes les clés stockées sur l'appareil (réinitialisation globale)
   */
  public async clearAll(): Promise<boolean> {
    try {
      if (!this.isSupported()) return true;
      await this.init();
      if (!this.db) return true;

      return await new Promise<boolean>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.clear();
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
        } catch {
          resolve(false);
        }
      });
    } catch (e) {
      console.warn("[E2EEKeyStorage] Erreur clearAll:", e);
      return false;
    }
  }
}

export default new E2EEKeyStorage();

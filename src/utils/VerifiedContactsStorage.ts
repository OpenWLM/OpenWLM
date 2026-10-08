/**
 * UTILITAIRE DE GESTION DU STOCKAGE LOCAL DES CONTACTS VÉRIFIÉS (IndexedDB + Fallback)
 * 
 * Architecture :
 * 1. Intégré au coffre-fort d'appareil local 'WLM_DeviceVault_v1' (store 'verified_contacts').
 * 2. Statut et empreintes strictement locaux à l'appareil / navigateur (aucune confiance aveugle au serveur).
 * 3. Migration idempotente automatique depuis l'ancien localStorage['wlm_verified_contacts_v1'].
 * 4. Préservation des données en cas d'échec de migration (ne supprime pas le legacy si la migration échoue).
 * 5. Tolérance aux pannes : Fallback transparent si IndexedDB est indisponible (navigation privée stricte, quotas).
 * 
 * Note de sécurité :
 * IndexedDB améliore l'architecture de stockage et la cohérence avec le vault navigateur existant ;
 * il ne s'agit pas d'une protection absolue contre une XSS du même origin.
 */

export interface VerifiedContactRecord {
  contactId: number;
  fingerprint: string;
  verified: boolean;
  verifiedAt?: number;
  seenAt?: number;
}

export interface StorageResult<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface MigrationResult {
  success: boolean;
  migrated: boolean;
  count?: number;
  error?: string;
}

const DB_NAME = 'WLM_DeviceVault_v1';
const DB_VERSION = 2;
const STORE_NAME = 'verified_contacts';
const KEYS_STORE = 'e2ee_keys';

const LEGACY_STORAGE_KEY = 'wlm_verified_contacts_v1';
const LEGACY_FLAG_KEY = 'wlm_verified_contacts_migrated_v1';

class VerifiedContactsStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private useFallback: boolean = false;
  private fallbackMemory: Record<number, VerifiedContactRecord> = {};

  /**
   * Vérifie si IndexedDB est disponible dans l'environnement actuel
   */
  public isSupported(): boolean {
    return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
  }

  /**
   * Initialise la base de données IndexedDB (store verified_contacts)
   */
  public async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    if (!this.isSupported()) {
      this.useFallback = true;
      return;
    }

    this.initPromise = new Promise<void>((resolve) => {
      try {
        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(KEYS_STORE)) {
            db.createObjectStore(KEYS_STORE, { keyPath: 'userId' });
          }
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'contactId' });
          }
        };

        request.onsuccess = (event) => {
          this.db = (event.target as IDBOpenDBRequest).result;
          this.useFallback = false;
          resolve();
        };

        request.onerror = () => {
          console.warn("[VerifiedContactsStorage] Échec ouverture IndexedDB, basculement en mode fallback.", request.error);
          this.useFallback = true;
          this.initPromise = null;
          resolve();
        };

        request.onblocked = () => {
          console.warn("[VerifiedContactsStorage] Ouverture IndexedDB bloquée par une autre connexion.");
        };
      } catch (err) {
        console.warn("[VerifiedContactsStorage] Exception lors de l'ouverture IndexedDB:", err);
        this.useFallback = true;
        this.initPromise = null;
        resolve();
      }
    });

    return this.initPromise;
  }

  /**
   * Récupère tous les contacts vérifiés stockés
   */
  public async getAll(): Promise<Record<number, VerifiedContactRecord>> {
    try {
      await this.init();

      if (this.useFallback || !this.db) {
        return this.getFallbackAll();
      }

      return await new Promise<Record<number, VerifiedContactRecord>>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.getAll();

          req.onsuccess = () => {
            const list = (req.result || []) as VerifiedContactRecord[];
            const map: Record<number, VerifiedContactRecord> = {};
            for (const item of list) {
              if (item && typeof item.contactId === 'number') {
                map[item.contactId] = item;
              }
            }
            resolve(map);
          };

          req.onerror = () => {
            console.warn("[VerifiedContactsStorage] Erreur getAll, lecture fallback:", req.error);
            resolve(this.getFallbackAll());
          };
        } catch (txErr) {
          console.warn("[VerifiedContactsStorage] Exception transaction getAll:", txErr);
          resolve(this.getFallbackAll());
        }
      });
    } catch (err) {
      console.warn("[VerifiedContactsStorage] Échec global getAll:", err);
      return this.getFallbackAll();
    }
  }

  /**
   * Récupère l'enregistrement d'un contact donné
   */
  public async get(contactId: number): Promise<VerifiedContactRecord | null> {
    try {
      await this.init();

      if (this.useFallback || !this.db) {
        const all = this.getFallbackAll();
        return all[contactId] || null;
      }

      return await new Promise<VerifiedContactRecord | null>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(contactId);

          req.onsuccess = () => {
            resolve((req.result as VerifiedContactRecord) || null);
          };

          req.onerror = () => {
            resolve(this.getFallbackAll()[contactId] || null);
          };
        } catch {
          resolve(this.getFallbackAll()[contactId] || null);
        }
      });
    } catch {
      return this.getFallbackAll()[contactId] || null;
    }
  }

  /**
   * Enregistre ou met à jour la vérification d'un contact
   */
  public async save(record: VerifiedContactRecord): Promise<StorageResult> {
    try {
      await this.init();

      if (this.useFallback || !this.db) {
        this.saveFallback(record);
        return { success: true };
      }

      return await new Promise<StorageResult>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.put(record);

          tx.oncomplete = () => {
            resolve({ success: true });
          };

          tx.onerror = () => {
            console.warn("[VerifiedContactsStorage] Erreur transaction save:", tx.error);
            this.saveFallback(record);
            resolve({ success: true }); // Fallback réussi
          };
        } catch (txErr: unknown) {
          console.warn("[VerifiedContactsStorage] Exception transaction save:", txErr);
          this.saveFallback(record);
          resolve({ success: true });
        }
      });
    } catch (err: unknown) {
      this.saveFallback(record);
      return { success: true };
    }
  }

  /**
   * Enregistre un lot d'enregistrements (utilisé notamment lors de la migration)
   */
  public async saveAll(records: VerifiedContactRecord[]): Promise<StorageResult> {
    if (!records || records.length === 0) return { success: true };

    try {
      await this.init();

      if (this.useFallback || !this.db) {
        for (const rec of records) {
          this.saveFallback(rec);
        }
        return { success: true };
      }

      return await new Promise<StorageResult>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);

          for (const rec of records) {
            store.put(rec);
          }

          tx.oncomplete = () => {
            resolve({ success: true });
          };

          tx.onerror = () => {
            const err = tx.error?.message || "Erreur transaction saveAll";
            resolve({ success: false, error: err });
          };
        } catch (txErr: unknown) {
          const err = txErr instanceof Error ? txErr.message : "Exception saveAll";
          resolve({ success: false, error: err });
        }
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue saveAll";
      return { success: false, error: msg };
    }
  }

  /**
   * Supprime un contact des vérifications
   */
  public async remove(contactId: number): Promise<StorageResult> {
    try {
      await this.init();

      if (this.useFallback || !this.db) {
        this.removeFallback(contactId);
        return { success: true };
      }

      return await new Promise<StorageResult>((resolve) => {
        try {
          const tx = this.db!.transaction([STORE_NAME], 'readwrite');
          const store = tx.objectStore(STORE_NAME);
          store.delete(contactId);

          tx.oncomplete = () => resolve({ success: true });
          tx.onerror = () => resolve({ success: false, error: tx.error?.message });
        } catch (e: unknown) {
          resolve({ success: false, error: e instanceof Error ? e.message : "Exception delete" });
        }
      });
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : "Erreur delete" };
    }
  }

  /**
   * Effectue la migration automatique et idempotente depuis localStorage
   */
  public async migrateFromLocalStorage(): Promise<MigrationResult> {
    try {
      // 1. Purge systématique de tout ancien marqueur résiduel dans localStorage
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(LEGACY_FLAG_KEY);
        }
      } catch {}

      // 2. Vérification de la présence de données legacy
      let rawData: string | null = null;
      try {
        if (typeof localStorage !== 'undefined') {
          rawData = localStorage.getItem(LEGACY_STORAGE_KEY);
        }
      } catch {
        rawData = null;
      }

      // Si aucune clé legacy n'existe (déjà migré ou installation neuve) :
      // l'idempotence est naturelle et garantie sans laisser aucun drapeau dans localStorage.
      if (!rawData) {
        return { success: true, migrated: false, count: 0 };
      }

      // 3. Décodage sécurisé des données
      let parsed: Record<string, any> = {};
      try {
        parsed = JSON.parse(rawData);
      } catch (err) {
        console.warn("[VerifiedContactsStorage] Données legacy corrompues dans localStorage:", err);
        return { success: false, migrated: false, error: "JSON legacy corrompu" };
      }

      // 4. Extraction et conversion des records
      const recordsToMigrate: VerifiedContactRecord[] = [];
      for (const [keyStr, val] of Object.entries(parsed)) {
        const contactId = parseInt(keyStr, 10);
        if (!isNaN(contactId) && val && typeof val === 'object' && typeof val.fingerprint === 'string') {
          recordsToMigrate.push({
            contactId,
            fingerprint: val.fingerprint,
            verified: !!val.verified,
            verifiedAt: typeof val.verifiedAt === 'number' ? val.verifiedAt : undefined,
            seenAt: typeof val.seenAt === 'number' ? val.seenAt : Date.now()
          });
        }
      }

      // 5. Sauvegarde dans IndexedDB (si supporté)
      if (recordsToMigrate.length > 0) {
        const saveRes = await this.saveAll(recordsToMigrate);
        if (!saveRes.success) {
          // ÉCHEC : Préserver impérativement l'ancienne clé localStorage pour ne rien perdre !
          console.warn("[VerifiedContactsStorage] Échec d'écriture dans IndexedDB, données legacy conservées:", saveRes.error);
          return { success: false, migrated: false, error: saveRes.error };
        }
      }

      // 6. Succès : suppression propre de l'ancienne clé legacy.
      // Zéro résidu dans localStorage : ni données ni flags.
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
          localStorage.removeItem(LEGACY_FLAG_KEY);
        }
      } catch (err) {
        console.warn("[VerifiedContactsStorage] Impossible de nettoyer la clé localStorage:", err);
      }

      return {
        success: true,
        migrated: true,
        count: recordsToMigrate.length
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue de migration";
      console.warn("[VerifiedContactsStorage] Exception migration:", err);
      return { success: false, migrated: false, error: msg };
    }
  }

  // --- MÉTHODES DE FALLBACK (LocalStorage / Mémoire) ---

  private getFallbackAll(): Record<number, VerifiedContactRecord> {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          return parsed as Record<number, VerifiedContactRecord>;
        }
      }
    } catch {}
    return { ...this.fallbackMemory };
  }

  private saveFallback(record: VerifiedContactRecord): void {
    this.fallbackMemory[record.contactId] = record;
    try {
      if (typeof localStorage !== 'undefined') {
        const all = this.getFallbackAll();
        all[record.contactId] = record;
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(all));
      }
    } catch {}
  }

  private removeFallback(contactId: number): void {
    delete this.fallbackMemory[contactId];
    try {
      if (typeof localStorage !== 'undefined') {
        const all = this.getFallbackAll();
        delete all[contactId];
        localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(all));
      }
    } catch {}
  }
}

export default new VerifiedContactsStorage();

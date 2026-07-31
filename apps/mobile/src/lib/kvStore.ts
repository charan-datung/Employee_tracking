import { SecureStorage } from '@aparajita/capacitor-secure-storage';

// Key-value storage boundary. Everything that persists auth state goes
// through this interface so the backing store can be swapped in ONE place.
//
// BACKING: @aparajita/capacitor-secure-storage — values are encrypted at
// rest with a key held in the Android Keystore, so the Supabase refresh
// token never sits in plain SharedPreferences (see SECURITY.md "Session
// storage"). No manifest permissions required. Do not add a second storage
// path, and do not move auth state to @capacitor/preferences.
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class SecureKVStore implements KVStore {
  async get(key: string): Promise<string | null> {
    const value = await SecureStorage.get(key);
    // We only ever store strings; anything else is corruption — treat as
    // absent so callers re-authenticate rather than crash.
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await SecureStorage.set(key, value);
  }

  async remove(key: string): Promise<void> {
    await SecureStorage.remove(key);
  }
}

export const kvStore: KVStore = new SecureKVStore();

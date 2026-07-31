import { Preferences } from '@capacitor/preferences';

// Key-value storage boundary. Everything that persists auth state goes
// through this interface so the backing store can be swapped in ONE place.
//
// CURRENT BACKING: @capacitor/preferences = plain Android SharedPreferences,
// UNENCRYPTED. This is the sanctioned fallback while the encrypted-storage
// plugin decision is pending (see SECURITY.md "Session storage" for the
// residual risk and the swap plan). Do not add a second storage path.
export interface KVStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class PreferencesKVStore implements KVStore {
  async get(key: string): Promise<string | null> {
    const { value } = await Preferences.get({ key });
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    await Preferences.set({ key, value });
  }

  async remove(key: string): Promise<void> {
    await Preferences.remove({ key });
  }
}

export const kvStore: KVStore = new PreferencesKVStore();

type MutableStorage = Pick<
  Storage,
  "getItem" | "key" | "length" | "removeItem" | "setItem"
>;

const currentStoragePrefix = "synced:";
const retiredStoragePrefix = ["yi", "qi", "kan", ":"].join("");

export function migrateStorageIdentity(storage: MutableStorage): number {
  const retiredKeys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index),
  ).filter(
    (key): key is string =>
      typeof key === "string" && key.startsWith(retiredStoragePrefix),
  );
  let migrated = 0;

  for (const retiredKey of retiredKeys) {
    const currentKey =
      currentStoragePrefix + retiredKey.slice(retiredStoragePrefix.length);
    const retiredValue = storage.getItem(retiredKey);
    if (storage.getItem(currentKey) === null && retiredValue !== null) {
      storage.setItem(currentKey, retiredValue);
      migrated += 1;
    }
    storage.removeItem(retiredKey);
  }

  return migrated;
}

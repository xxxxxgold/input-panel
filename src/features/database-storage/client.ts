import type {
  DatabaseStorageMigrationInput,
  DatabaseStorageMigrationResult,
  DatabaseStorageStatus
} from "../../types";
import { desktopOrHttp } from "../../shared/transport/runtime";

export function getDatabaseStorageStatus() {
  return desktopOrHttp<DatabaseStorageStatus>({
    command: "get_database_storage_status",
    url: "/api/database-storage"
  });
}

export function migrateDatabaseStorage(payload: DatabaseStorageMigrationInput) {
  return desktopOrHttp<DatabaseStorageMigrationResult>({
    command: "migrate_database_storage",
    args: { payload },
    url: "/api/database-storage/migrate",
    init: {
      method: "POST",
      body: JSON.stringify(payload)
    }
  });
}

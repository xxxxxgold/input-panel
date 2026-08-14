import { useCallback, useEffect, useRef, useState } from "react";

import type {
  DatabaseStorageMigrationResult,
  DatabaseStorageStatus
} from "../../types";
import {
  getDatabaseStorageStatus,
  migrateDatabaseStorage
} from "./client";

function readableError(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message.trim() ? cause.message : fallback;
}

export function useDatabaseStorageWorkspace({ enabled }: { enabled: boolean }) {
  const [status, setStatus] = useState<DatabaseStorageStatus | null>(null);
  const [targetDirectory, setTargetDirectoryState] = useState("");
  const [loading, setLoading] = useState(false);
  const [migrationLoading, setMigrationLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [migrationResult, setMigrationResult] =
    useState<DatabaseStorageMigrationResult | null>(null);
  const mountedRef = useRef(false);
  const statusRef = useRef<DatabaseStorageStatus | null>(null);
  const targetDirectoryRef = useRef("");
  const targetEditedRef = useRef(false);
  const statusRequestRef = useRef<Promise<DatabaseStorageStatus | null> | null>(null);
  const migrationRequestRef =
    useRef<Promise<DatabaseStorageMigrationResult | null> | null>(null);
  const migrationCompletedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (statusRequestRef.current) {
      return statusRequestRef.current;
    }

    setLoading(true);
    setLoadError(null);
    const request = getDatabaseStorageStatus()
      .then((nextStatus) => {
        if (mountedRef.current) {
          statusRef.current = nextStatus;
          migrationCompletedRef.current = nextStatus.restartRequired;
          setStatus(nextStatus);
          if (!targetEditedRef.current) {
            targetDirectoryRef.current = nextStatus.targetDirectory;
            setTargetDirectoryState(nextStatus.targetDirectory);
          }
        }
        return nextStatus;
      })
      .catch((cause) => {
        if (mountedRef.current) {
          setLoadError(readableError(cause, "数据库存储状态读取失败。"));
        }
        return null;
      })
      .finally(() => {
        if (statusRequestRef.current === request) {
          statusRequestRef.current = null;
        }
        if (mountedRef.current) {
          setLoading(false);
        }
      });
    statusRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const setTargetDirectory = useCallback((value: string) => {
    targetEditedRef.current = true;
    targetDirectoryRef.current = value;
    setTargetDirectoryState(value);
    setMigrationError(null);
  }, []);

  const migrate = useCallback((requestedDirectory?: string) => {
    if (migrationRequestRef.current) {
      return migrationRequestRef.current;
    }

    const currentStatus = statusRef.current;
    const directory = (requestedDirectory ?? targetDirectoryRef.current).trim();
    if (!directory) {
      const message = "数据库存储目录不能为空。";
      setMigrationError(message);
      return Promise.resolve(null);
    }
    if (!currentStatus) {
      setMigrationError("请先读取数据库存储状态。");
      return Promise.resolve(null);
    }
    if (!currentStatus.migrationSupported || currentStatus.overrideActive) {
      setMigrationError("SUB2API_APP_ROOT 已生效，当前运行实例不允许修改数据库目录。");
      return Promise.resolve(null);
    }
    if (currentStatus.restartRequired || migrationCompletedRef.current) {
      setMigrationError("数据库已迁移完成，请先重启后端再继续操作。");
      return Promise.resolve(null);
    }

    setMigrationLoading(true);
    setMigrationError(null);
    setMigrationResult(null);
    const request = migrateDatabaseStorage({ targetDirectory: directory })
      .then((result) => {
        migrationCompletedRef.current = result.restartRequired;
        if (mountedRef.current) {
          targetEditedRef.current = true;
          targetDirectoryRef.current = directory;
          setTargetDirectoryState(directory);
          setMigrationResult(result);
          const nextStatus: DatabaseStorageStatus = {
            ...currentStatus,
            targetDirectory: directory,
            migrationPhase: result.restartRequired
              ? "restart_required"
              : currentStatus.migrationPhase,
            restartRequired: result.restartRequired,
            lastError: null
          };
          statusRef.current = nextStatus;
          setStatus(nextStatus);
        }
        return result;
      })
      .catch((cause) => {
        if (mountedRef.current) {
          setMigrationError(readableError(cause, "数据库迁移失败。"));
        }
        return null;
      })
      .finally(() => {
        if (migrationRequestRef.current === request) {
          migrationRequestRef.current = null;
        }
        if (mountedRef.current) {
          setMigrationLoading(false);
        }
      });
    migrationRequestRef.current = request;
    return request;
  }, []);

  return {
    status,
    targetDirectory,
    loading,
    migrationLoading,
    loadError,
    migrationError,
    migrationResult,
    setTargetDirectory,
    refresh,
    migrate
  };
}

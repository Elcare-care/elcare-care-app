"use client";

// ─────────────────────────────────────────────────────────────
// hooks/useAdminSession.ts — Admin session with audit events
// ─────────────────────────────────────────────────────────────

import { useState, useCallback, useEffect } from "react";
import { emitAuditEvent, clearSessionAuditLog } from "@/lib/auditLog";

const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

export function useAdminSession(adminPublicKey?: string | null) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [lastAuthTime, setLastAuthTime] = useState<number | null>(null);

  const checkSession = useCallback(() => {
    if (!lastAuthTime) return false;
    const isValid = Date.now() - lastAuthTime < SESSION_TIMEOUT_MS;
    if (!isValid && isAuthenticated) {
      setIsAuthenticated(false);
      emitAuditEvent("session.expired", adminPublicKey ?? null, "initiated");
      clearSessionAuditLog();
    }
    return isValid;
  }, [lastAuthTime, isAuthenticated, adminPublicKey]);

  const authenticate = useCallback(async () => {
    setLastAuthTime(Date.now());
    setIsAuthenticated(true);
    emitAuditEvent("session.start", adminPublicKey ?? null, "success");
    return true;
  }, [adminPublicKey]);

  const logout = useCallback(() => {
    setIsAuthenticated(false);
    setLastAuthTime(null);
    emitAuditEvent("session.end", adminPublicKey ?? null, "success");
    clearSessionAuditLog();
  }, [adminPublicKey]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = setInterval(() => checkSession(), 10_000);
    return () => clearInterval(interval);
  }, [isAuthenticated, checkSession]);

  return {
    isAuthenticated,
    authenticate,
    logout,
    checkSession,
    sessionExpiresIn: lastAuthTime
      ? Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - lastAuthTime))
      : 0,
  };
}

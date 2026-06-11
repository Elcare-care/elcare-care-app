"use client";

import { useCallback, useEffect, useState } from "react";
import { SUPPORTED_TOKENS, TokenConfig } from "@/config/tokens";
import { fetchSupportedTokens } from "@/lib/token-support";

export function useSupportedTokens() {
  const [tokens, setTokens] = useState<TokenConfig[]>(SUPPORTED_TOKENS);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const supportedTokens = await fetchSupportedTokens();
      setTokens(supportedTokens);
    } catch (err: unknown) {
      setTokens(SUPPORTED_TOKENS);
      setError(err instanceof Error ? err.message : "Failed to load supported tokens");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { tokens, isLoading, error, refresh };
}

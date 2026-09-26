/**
 * Admin token whitelist control — minimal implementation
 * Reference: docs/runbooks/token-onboarding.md §11
 */

import React, { useState } from "react";

interface TokenWhitelistControlProps {
  marketplaceContractId: string;
  network: "testnet" | "mainnet";
  onTokenAdded?: (address: string) => void;
  onTokenRemoved?: (address: string) => void;
}

interface WhitelistAction {
  type: "add" | "remove";
  tokenAddress: string;
  symbol: string;
  decimals: number;
  verificationChecklist: {
    eligibilityReviewed: boolean;
    preflightPassed: boolean;
    frontendMetadataMerged: boolean;
    secondOperatorReview: boolean;
  };
}

export const TokenWhitelistControl: React.FC<TokenWhitelistControlProps> = ({
  marketplaceContractId,
  network,
  onTokenAdded,
  onTokenRemoved,
}) => {
  const [action, setAction] = useState<WhitelistAction>({
    type: "add",
    tokenAddress: "",
    symbol: "",
    decimals: 7,
    verificationChecklist: {
      eligibilityReviewed: false,
      preflightPassed: false,
      frontendMetadataMerged: false,
      secondOperatorReview: false,
    },
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const validateAddress = (addr: string): boolean => {
    return /^C[A-Z2-7]{55}$/.test(addr);
  };

  const checklistComplete = (): boolean => {
    const { verificationChecklist } = action;
    return Object.values(verificationChecklist).every((v) => v === true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    // Validation
    if (!validateAddress(action.tokenAddress)) {
      setError("Invalid Stellar contract address (C + 55 chars)");
      return;
    }

    if (!action.symbol || action.symbol.length === 0) {
      setError("Symbol required");
      return;
    }

    if (!checklistComplete()) {
      setError("All verification items must be checked before proceeding");
      return;
    }

    setLoading(true);

    try {
      // Call contract method via admin UI or backend
      const method =
        action.type === "add"
          ? "add_token_to_whitelist"
          : "remove_token_from_whitelist";

      const response = await fetch("/api/admin/whitelist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          method,
          tokenAddress: action.tokenAddress,
          symbol: action.symbol,
          decimals: action.decimals,
          network,
          marketplaceContractId,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.message || "Whitelist operation failed");
      }

      const result = await response.json();
      setSuccess(
        `Token ${action.type === "add" ? "added" : "removed"}: ${result.txHash}`
      );

      if (action.type === "add") {
        onTokenAdded?.(action.tokenAddress);
      } else {
        onTokenRemoved?.(action.tokenAddress);
      }

      // Reset form
      setAction({
        type: "add",
        tokenAddress: "",
        symbol: "",
        decimals: 7,
        verificationChecklist: {
          eligibilityReviewed: false,
          preflightPassed: false,
          frontendMetadataMerged: false,
          secondOperatorReview: false,
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="token-whitelist-control">
      <h2>Token Whitelist Management</h2>
      <p className="subtitle">
        Add or remove payment tokens. All verification items must be completed
        before proceeding.
      </p>

      <form onSubmit={handleSubmit}>
        {/* Action type */}
        <fieldset>
          <legend>Action</legend>
          <label>
            <input
              type="radio"
              value="add"
              checked={action.type === "add"}
              onChange={(e) =>
                setAction({ ...action, type: e.target.value as "add" | "remove" })
              }
            />
            Add token
          </label>
          <label>
            <input
              type="radio"
              value="remove"
              checked={action.type === "remove"}
              onChange={(e) =>
                setAction({ ...action, type: e.target.value as "add" | "remove" })
              }
            />
            Remove token
          </label>
        </fieldset>

        {/* Token details */}
        <fieldset>
          <legend>Token Details</legend>

          <label>
            Contract Address (C + 55 chars)
            <input
              type="text"
              value={action.tokenAddress}
              onChange={(e) =>
                setAction({ ...action, tokenAddress: e.target.value })
              }
              placeholder="CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              required
            />
            {action.tokenAddress &&
              !validateAddress(action.tokenAddress) && (
                <span className="error">Invalid address format</span>
              )}
          </label>

          <label>
            Symbol
            <input
              type="text"
              value={action.symbol}
              onChange={(e) =>
                setAction({ ...action, symbol: e.target.value.toUpperCase() })
              }
              placeholder="USDC"
              maxLength={10}
              required
            />
          </label>

          <label>
            Decimals
            <input
              type="number"
              value={action.decimals}
              onChange={(e) =>
                setAction({
                  ...action,
                  decimals: Math.max(0, Math.min(18, parseInt(e.target.value))),
                })
              }
              min="0"
              max="18"
            />
            {action.decimals !== 7 && (
              <span className="warning">
                Non-standard decimals require engineering sign-off
              </span>
            )}
          </label>
        </fieldset>

        {/* Verification checklist */}
        <fieldset>
          <legend>Verification Checklist</legend>
          <p className="subtitle">
            All items must be completed before proceeding (see
            docs/runbooks/token-onboarding.md §1–4)
          </p>

          <label>
            <input
              type="checkbox"
              checked={action.verificationChecklist.eligibilityReviewed}
              onChange={(e) =>
                setAction({
                  ...action,
                  verificationChecklist: {
                    ...action.verificationChecklist,
                    eligibilityReviewed: e.target.checked,
                  },
                })
              }
            />
            Eligibility & issuer verification complete
          </label>

          <label>
            <input
              type="checkbox"
              checked={action.verificationChecklist.preflightPassed}
              onChange={(e) =>
                setAction({
                  ...action,
                  verificationChecklist: {
                    ...action.verificationChecklist,
                    preflightPassed: e.target.checked,
                  },
                })
              }
            />
            Preflight script passed (bash scripts/preflight/token-onboarding.sh)
          </label>

          <label>
            <input
              type="checkbox"
              checked={action.verificationChecklist.frontendMetadataMerged}
              onChange={(e) =>
                setAction({
                  ...action,
                  verificationChecklist: {
                    ...action.verificationChecklist,
                    frontendMetadataMerged: e.target.checked,
                  },
                })
              }
            />
            Frontend metadata PR merged (config/tokens.ts)
          </label>

          <label>
            <input
              type="checkbox"
              checked={action.verificationChecklist.secondOperatorReview}
              onChange={(e) =>
                setAction({
                  ...action,
                  verificationChecklist: {
                    ...action.verificationChecklist,
                    secondOperatorReview: e.target.checked,
                  },
                })
              }
            />
            Second operator reviewed verification evidence
          </label>
        </fieldset>

        {/* Messages */}
        {error && <div className="error-message">{error}</div>}
        {success && <div className="success-message">{success}</div>}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !checklistComplete()}
          className="submit-button"
        >
          {loading ? "Processing…" : `${action.type === "add" ? "Add" : "Remove"} Token`}
        </button>
      </form>

      {/* Reference links */}
      <div className="reference-links">
        <h3>Reference</h3>
        <ul>
          <li>
            <a href="/docs/runbooks/token-onboarding.md">
              Token Onboarding Runbook
            </a>
          </li>
          <li>
            <a href="/docs/guides/payment-tokens.md">Payment Tokens Guide</a>
          </li>
          <li>
            <a href="/docs/financial-reconciliation-runbook.md">
              Financial Reconciliation
            </a>
          </li>
        </ul>
      </div>

      <style>{`
        .token-whitelist-control {
          max-width: 600px;
          margin: 2rem 0;
          padding: 1.5rem;
          border: 1px solid #ddd;
          border-radius: 8px;
        }

        .subtitle {
          color: #666;
          font-size: 0.9rem;
          margin: 0.5rem 0 1rem;
        }

        fieldset {
          margin: 1.5rem 0;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 4px;
        }

        legend {
          font-weight: 600;
          padding: 0 0.5rem;
        }

        label {
          display: block;
          margin: 0.75rem 0;
        }

        input[type="text"],
        input[type="number"] {
          width: 100%;
          padding: 0.5rem;
          margin-top: 0.25rem;
          border: 1px solid #ccc;
          border-radius: 4px;
          font-family: monospace;
        }

        input[type="checkbox"],
        input[type="radio"] {
          margin-right: 0.5rem;
        }

        .error {
          display: block;
          color: #d32f2f;
          font-size: 0.85rem;
          margin-top: 0.25rem;
        }

        .warning {
          display: block;
          color: #f57c00;
          font-size: 0.85rem;
          margin-top: 0.25rem;
        }

        .error-message {
          padding: 0.75rem;
          margin: 1rem 0;
          background: #ffebee;
          color: #c62828;
          border-radius: 4px;
        }

        .success-message {
          padding: 0.75rem;
          margin: 1rem 0;
          background: #e8f5e9;
          color: #2e7d32;
          border-radius: 4px;
        }

        .submit-button {
          padding: 0.75rem 1.5rem;
          background: #0066cc;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 600;
        }

        .submit-button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }

        .reference-links {
          margin-top: 2rem;
          padding-top: 1rem;
          border-top: 1px solid #eee;
        }

        .reference-links ul {
          list-style: none;
          padding: 0;
        }

        .reference-links li {
          margin: 0.5rem 0;
        }

        .reference-links a {
          color: #0066cc;
          text-decoration: none;
        }

        .reference-links a:hover {
          text-decoration: underline;
        }
      `}</style>
    </div>
  );
};

export default TokenWhitelistControl;

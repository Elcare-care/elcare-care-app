import {
  AlertCircle,
  RefreshCw,
  Package,
  SearchX,
  ShieldAlert,
  FileQuestion,
  ServerCrash,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import type { PageStateError } from "@/lib/pageState";

interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry: () => void;
  className?: string;
}

/**
 * @deprecated Prefer `ResourceState` (below) so unavailable / unauthorized /
 * not-found errors get distinct copy and semantics instead of one generic
 * "Failed to load" banner. Kept for pages not yet migrated.
 */
export function ErrorState({ title = "Failed to load", message, onRetry, className = "" }: ErrorStateProps) {
  return (
    <div role="alert" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-red-500 mb-4">
        <AlertCircle size={32} aria-hidden="true" />
      </div>
      <h3 className="font-display font-bold text-gray-900 text-lg">{title}</h3>
      <p className="mt-1 text-sm text-gray-500 max-w-sm text-center">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all"
      >
        <RefreshCw size={14} aria-hidden="true" />
        Try Again
      </button>
    </div>
  );
}

// ── LoadingState ──────────────────────────────────────────────
//
// Use when a page has no more specific skeleton to show. Pages with a
// bespoke skeleton (grids, cards) should keep it but wrap it in the same
// `role="status"` + visually-hidden label so screen-reader users get a
// consistent "loading" announcement across every route.

interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = "Loading…", className = "" }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center py-20 ${className}`}
    >
      <Loader2 size={32} className="animate-spin text-brand-400" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

// ── UnavailableState ──────────────────────────────────────────
//
// The indexer/backend is unreachable or erroring (5xx, network failure,
// timeout). Distinct from EmptyState: the user has no way to know whether
// there is data or not, so the copy must say so explicitly and offer retry.

interface ActionLike {
  label: string;
  onClick?: () => void;
  href?: string;
}

/** Most pages sit on a light background; a few (offers, wallet flows) are
 * dark-themed. `tone` swaps text colors so state copy stays legible on
 * either without every call site re-deriving its own palette. */
type StateTone = "light" | "dark";

function StateActionButton({ action, variant = "primary" }: { action: ActionLike; variant?: "primary" | "secondary" }) {
  const className =
    variant === "primary"
      ? "mt-6 flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all"
      : "mt-3 flex items-center gap-2 rounded-xl border border-gray-200 px-6 py-2.5 text-sm font-bold text-gray-600 hover:bg-gray-50 transition-all";

  if (action.href) {
    return (
      <Link href={action.href} className={className}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" onClick={action.onClick} className={className}>
      {action.label}
    </button>
  );
}

function toneClasses(tone: StateTone) {
  return tone === "dark"
    ? { title: "text-white", message: "text-white/60" }
    : { title: "text-gray-900", message: "text-gray-500" };
}

interface UnavailableStateProps {
  message?: string;
  onRetry?: () => void;
  secondaryAction?: ActionLike;
  className?: string;
  tone?: StateTone;
}

export function UnavailableState({
  message = "The indexer is temporarily unavailable. Your data is safe on-chain — please try again shortly.",
  onRetry,
  secondaryAction,
  className = "",
  tone = "light",
}: UnavailableStateProps) {
  const t = toneClasses(tone);
  return (
    <div role="alert" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-50 text-amber-500 mb-4">
        <ServerCrash size={32} aria-hidden="true" />
      </div>
      <h3 className={`font-display font-bold text-lg ${t.title}`}>Temporarily unavailable</h3>
      <p className={`mt-1 text-sm max-w-sm text-center ${t.message}`}>{message}</p>
      {onRetry && <StateActionButton action={{ label: "Try Again", onClick: onRetry }} />}
      {secondaryAction && <StateActionButton action={secondaryAction} variant="secondary" />}
    </div>
  );
}

// ── UnauthorizedState ─────────────────────────────────────────

interface UnauthorizedStateProps {
  message?: string;
  action?: ActionLike;
  className?: string;
  tone?: StateTone;
}

export function UnauthorizedState({
  message = "You don't have permission to view this. Connect the correct wallet and try again.",
  action,
  className = "",
  tone = "light",
}: UnauthorizedStateProps) {
  const t = toneClasses(tone);
  return (
    <div role="alert" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-terracotta-50 text-terracotta-500 mb-4">
        <ShieldAlert size={32} aria-hidden="true" />
      </div>
      <h3 className={`font-display font-bold text-lg ${t.title}`}>Access restricted</h3>
      <p className={`mt-1 text-sm max-w-sm text-center ${t.message}`}>{message}</p>
      {action && <StateActionButton action={action} />}
    </div>
  );
}

// ── NotFoundState ─────────────────────────────────────────────
//
// The resource genuinely does not exist (404, or the indexer/contract
// confirmed it was never created / was deleted). Never retryable — the
// only useful action is navigation.

interface NotFoundStateProps {
  title?: string;
  message?: string;
  action?: ActionLike;
  className?: string;
  tone?: StateTone;
}

export function NotFoundState({
  title = "Not found",
  message = "This item could not be found. It may have been removed or never existed.",
  action = { label: "Back to Marketplace", href: "/explore" },
  className = "",
  tone = "light",
}: NotFoundStateProps) {
  const t = toneClasses(tone);
  return (
    <div role="status" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gray-100 text-gray-400 mb-4">
        <FileQuestion size={32} aria-hidden="true" />
      </div>
      <h3 className={`font-display font-bold text-lg ${t.title}`}>{title}</h3>
      <p className={`mt-1 text-sm max-w-sm text-center ${t.message}`}>{message}</p>
      {action && <StateActionButton action={action} />}
    </div>
  );
}

// ── ResourceState ─────────────────────────────────────────────
//
// Single gate for the blocking states (loading / empty / unavailable /
// unauthorized / not-found). Pages pass a `PageStateError | null` produced
// by `categorizePageError` (lib/pageState.ts) so retry and navigation
// actions are wired consistently everywhere. Returns null when the caller
// should render its normal "ready" content.

interface ResourceStateProps {
  isLoading: boolean;
  error: PageStateError | null;
  isEmpty?: boolean;
  onRetry?: () => void;
  loadingLabel?: string;
  empty?: {
    icon?: React.ElementType;
    title: string;
    description?: string;
    action?: ActionLike;
    iconClassName?: string;
    titleClassName?: string;
    descriptionClassName?: string;
  };
  /** Resource-specific overrides for the not-found action (defaults to "Back to Marketplace"). */
  notFoundAction?: ActionLike;
  /** Resource-specific action for the unauthorized state (e.g. "Connect Wallet"). */
  unauthorizedAction?: ActionLike;
  className?: string;
  /** Set to "dark" on dark-background pages (e.g. offers, wallet flows) so text stays legible. */
  tone?: StateTone;
}

export function ResourceState({
  isLoading,
  error,
  isEmpty = false,
  onRetry,
  loadingLabel,
  empty,
  notFoundAction,
  unauthorizedAction,
  className,
  tone = "light",
}: ResourceStateProps): React.ReactElement | null {
  if (isLoading) {
    return <LoadingState label={loadingLabel} className={className} />;
  }

  if (error) {
    if (error.category === "not-found") {
      return <NotFoundState message={error.message} action={notFoundAction} className={className} tone={tone} />;
    }
    if (error.category === "unauthorized") {
      return <UnauthorizedState message={error.message} action={unauthorizedAction} className={className} tone={tone} />;
    }
    return (
      <UnavailableState
        message={error.message}
        onRetry={error.retryable ? onRetry : undefined}
        className={className}
        tone={tone}
      />
    );
  }

  if (isEmpty && empty) {
    return <EmptyState {...empty} className={className} />;
  }

  return null;
}

interface EmptyStateAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: EmptyStateAction;
  className?: string;
  iconClassName?: string;
  titleClassName?: string;
  descriptionClassName?: string;
}

export function EmptyState({
  icon: Icon = Package,
  title,
  description,
  action,
  className = "",
  iconClassName = "",
  titleClassName = "",
  descriptionClassName = "",
}: EmptyStateProps) {
  return (
    <div role="status" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className={`flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-500 mb-4 ${iconClassName}`}>
        <Icon size={32} aria-hidden="true" />
      </div>
      <h3 className={`font-display font-bold text-gray-900 text-lg ${titleClassName}`}>{title}</h3>
      {description && (
        <p className={`mt-1 text-sm text-gray-500 max-w-sm text-center ${descriptionClassName}`}>{description}</p>
      )}
      {action && action.href ? (
        <Link
          href={action.href}
          className="mt-6 flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all"
        >
          {action.label}
        </Link>
      ) : action?.onClick ? (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-6 flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

interface NoResultsProps {
  message?: string;
  onClearFilters: () => void;
  className?: string;
}

export function NoResults({
  message = "No artworks match the current filters. Try adjusting your search or filters.",
  onClearFilters,
  className = "",
}: NoResultsProps) {
  return (
    <div role="status" className={`flex flex-col items-center justify-center py-20 ${className}`}>
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-brand-500 mb-4">
        <SearchX size={32} aria-hidden="true" />
      </div>
      <h3 className="font-display font-bold text-gray-900 text-lg">No results found</h3>
      <p className="mt-1 text-sm text-gray-500 max-w-sm text-center">{message}</p>
      <button
        type="button"
        onClick={onClearFilters}
        className="mt-6 flex items-center gap-2 rounded-xl bg-brand-500 px-6 py-2.5 text-sm font-bold text-white hover:bg-brand-600 transition-all"
      >
        Clear Filters
      </button>
    </div>
  );
}

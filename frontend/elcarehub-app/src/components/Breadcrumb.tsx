// ─────────────────────────────────────────────────────────────
// components/Breadcrumb.tsx — Contextual breadcrumb navigation
//
// Renders an accessible breadcrumb trail. The last item is the
// current page (aria-current="page"). Intermediate items link
// back to parent routes.
//
// Usage:
//   <Breadcrumb items={[
//     { label: "Auctions", href: "/auctions" },
//     { label: "Sunset Over Sahara" },   // no href = current page
//   ]} />
// ─────────────────────────────────────────────────────────────

import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  className?: string;
}

export function Breadcrumb({ items, className = "" }: BreadcrumbProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol
        role="list"
        className="flex flex-wrap items-center gap-1 text-sm text-white/50"
      >
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          return (
            <li key={index} className="flex items-center gap-1 min-w-0">
              {index > 0 && (
                <ChevronRight
                  size={13}
                  aria-hidden="true"
                  className="shrink-0 text-white/25"
                />
              )}
              {isLast || !item.href ? (
                <span
                  aria-current={isLast ? "page" : undefined}
                  className={`truncate max-w-[200px] ${
                    isLast ? "text-white/90 font-medium" : "text-white/50"
                  }`}
                >
                  {item.label}
                </span>
              ) : (
                <Link
                  href={item.href}
                  className="truncate max-w-[200px] text-white/50 hover:text-brand-400 transition-colors"
                >
                  {item.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

import '@testing-library/jest-dom';
import React from 'react';

/* -------------------------------------------------------------------------- */
/*  next/image mock (issues #1146)                                            */
/* -------------------------------------------------------------------------- */
/*  Renders a plain <img> so tests can deterministically fire `load` and      */
/*  `error` events. Forwards `onLoad`/`onError`/`onLoadingComplete` handlers  */
/*  and preserves `alt`, `src`, `width`, `height`, `className`, `style`,      */
/*  `priority`, `fill`, `sizes`, `quality`, `placeholder`, `blurDataURL`.     */
/* -------------------------------------------------------------------------- */

jest.mock('next/image', () => {
  const MockNextImage = (props: any) => {
    const {
      src,
      alt,
      width,
      height,
      className,
      style,
      onLoad,
      onError,
      onLoadingComplete,
      priority,
      fill,
      sizes,
      quality,
      placeholder,
      blurDataURL,
      loader,
      unoptimized,
      ...rest
    } = props ?? {};

    const resolvedSrc =
      typeof src === 'string'
        ? src
        : src && typeof src === 'object' && 'src' in src
          ? src.src
          : src;

    const handleLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (typeof onLoad === 'function') onLoad(event);
      if (typeof onLoadingComplete === 'function') {
        onLoadingComplete({
          naturalWidth: (event.target as HTMLImageElement).naturalWidth,
          naturalHeight: (event.target as HTMLImageElement).naturalHeight,
        });
      }
    };

    const handleError = (event: React.SyntheticEvent<HTMLImageElement>) => {
      if (typeof onError === 'function') onError(event);
    };

    return React.createElement('img', {
      ...rest,
      src: resolvedSrc,
      alt: alt ?? '',
      width: fill ? undefined : width,
      height: fill ? undefined : height,
      className,
      style,
      onLoad: handleLoad,
      onError: handleError,
      'data-next-image': 'true',
      'data-priority': priority ? 'true' : undefined,
      'data-fill': fill ? 'true' : undefined,
      'data-sizes': sizes,
      'data-quality': quality,
      'data-placeholder': placeholder,
      'data-blur-data-url': blurDataURL,
      'data-loader': loader ? 'custom' : undefined,
      'data-unoptimized': unoptimized ? 'true' : undefined,
    });
  };

  return {
    __esModule: true,
    default: MockNextImage,
  };
});

/* -------------------------------------------------------------------------- */
/*  matchMedia mock (issues #1148)                                            */
/* -------------------------------------------------------------------------- */
/*  Supports `prefers-reduced-motion` and theme queries (`prefers-color-      */
/*  scheme`, `data-theme`, `theme`). Tests can override via                    */
/*  `window.__setMatchMediaOverrides({ ... })` and reset in afterEach.        */
/* -------------------------------------------------------------------------- */

type MatchMediaOverrides = Record<string, boolean>;

declare global {
  interface Window {
    __setMatchMediaOverrides?: (overrides: MatchMediaOverrides) => void;
    __resetMatchMediaOverrides?: () => void;
  }
}

const defaultMatchMediaState: MatchMediaOverrides = {
  '(prefers-reduced-motion: reduce)': false,
  '(prefers-reduced-motion: no-preference)': true,
  '(prefers-color-scheme: dark)': false,
  '(prefers-color-scheme: light)': true,
};

let matchMediaOverrides: MatchMediaOverrides = { ...defaultMatchMediaState };

const resolveMatches = (query: string): boolean => {
  if (Object.prototype.hasOwnProperty.call(matchMediaOverrides, query)) {
    return matchMediaOverrides[query];
  }
  // Theme queries: `[data-theme="dark"]`, `(theme: dark)`, etc.
  if (/dark/i.test(query)) return false;
  if (/light/i.test(query)) return true;
  return false;
};

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList => {
      const listeners = new Set<(event: MediaQueryListEvent) => void>();

      const mql: MediaQueryList = {
        get matches() {
          return resolveMatches(query);
        },
        media: query,
        onchange: null,
        addListener: (listener) => {
          if (listener) listeners.add(listener);
        },
        removeListener: (listener) => {
          if (listener) listeners.delete(listener);
        },
        addEventListener: (_type: string, listener: any) => {
          if (listener) listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: any) => {
          if (listener) listeners.delete(listener);
        },
        dispatchEvent: (event: Event): boolean => {
          listeners.forEach((listener) =>
            listener(event as MediaQueryListEvent),
          );
          return true;
        },
      } as MediaQueryList;

      return mql;
    },
  });

  window.__setMatchMediaOverrides = (overrides: MatchMediaOverrides) => {
    matchMediaOverrides = { ...defaultMatchMediaState, ...overrides };
  };

  window.__resetMatchMediaOverrides = () => {
    matchMediaOverrides = { ...defaultMatchMediaState };
  };
}

/* -------------------------------------------------------------------------- */
/*  Console spies (issues #1146 / #1148)                                      */
/* -------------------------------------------------------------------------- */
/*  Tests can assert against `console.error` / `console.warn` calls and the   */
/*  spies are reset + restored in afterEach so no state leaks between tests.  */
/* -------------------------------------------------------------------------- */

let consoleErrorSpy: jest.SpyInstance;
let consoleWarnSpy: jest.SpyInstance;

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  // Reset matchMedia overrides so theme/reduced-motion state does not leak.
  if (typeof window !== 'undefined' && window.__resetMatchMediaOverrides) {
    window.__resetMatchMediaOverrides();
  }

  // Restore console spies so subsequent tests start clean.
  if (consoleErrorSpy) {
    consoleErrorSpy.mockRestore();
  }
  if (consoleWarnSpy) {
    consoleWarnSpy.mockRestore();
  }

  // Clear any timers scheduled by image loading/timeout fixtures.
  jest.clearAllTimers();
  jest.useRealTimers();
});
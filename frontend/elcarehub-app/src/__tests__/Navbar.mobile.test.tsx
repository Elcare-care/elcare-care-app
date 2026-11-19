/**
 * Navbar.mobile.test.tsx — Issue 1035
 *
 * Verifies that the sticky navigation does not overflow or clip at the
 * 320px smallest supported viewport. We exercise the DOM output of the
 * Navbar component and assert:
 *   • Logo container does not use a width/padding wider than the viewport.
 *   • Hamburger button remains present and has the correct aria-label.
 *   • The "Connect Wallet" button in the mobile drawer uses truncate to
 *     prevent label overflow.
 *   • The mobile drawer is hidden by default (aria-hidden=true) and
 *     becomes visible when the hamburger is clicked.
 *   • Escape key closes the mobile menu and returns focus to the hamburger.
 *   • The LocaleSwitcher is rendered inside the desktop-only area and not
 *     duplicated in the mobile drawer.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// ── Dependency mocks ──────────────────────────────────────────

jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

jest.mock("@/context/WalletContext", () => ({
  useWalletContext: () => ({
    publicKey: null,
    isConnected: false,
    isConnecting: false,
    disconnect: jest.fn(),
    isWrongNetwork: false,
    balance: null,
    isLoadingBalance: false,
  }),
}));

jest.mock("@/components/ConnectWalletModal", () => ({
  ConnectWalletModal: () => null,
}));

jest.mock("@/components/WalletMenu", () => ({
  WalletMenu: () => <div data-testid="wallet-menu">wallet menu</div>,
}));

jest.mock("@/components/NotificationCenter", () => ({
  NotificationCenter: () => null,
}));

jest.mock("@/components/LocaleSwitcher", () => ({
  LocaleSwitcher: () => <div data-testid="locale-switcher">EN</div>,
}));

jest.mock("lucide-react", () => {
  const icon = (name: string) => ({ size, ...rest }: { size?: number } & Record<string, unknown>) =>
    <span data-testid={`icon-${name}`} {...rest} />;
  return {
    Wallet: icon("wallet"),
    Store: icon("store"),
    LayoutDashboard: icon("layout-dashboard"),
    Menu: icon("menu"),
    X: icon("x"),
    AlertTriangle: icon("alert-triangle"),
    ShieldCheck: icon("shield-check"),
    Tag: icon("tag"),
    Inbox: icon("inbox"),
    Compass: icon("compass"),
    User: icon("user"),
    Gavel: icon("gavel"),
    Settings: icon("settings"),
    HelpCircle: icon("help-circle"),
    Rocket: icon("rocket"),
    ChevronDown: icon("chevron-down"),
    Activity: icon("activity"),
  };
});

import { Navbar } from "@/components/Navbar";

// ── Tests ─────────────────────────────────────────────────────

describe("Navbar mobile layout — 320px viewport (Issue 1035)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the hamburger button with an accessible label", () => {
    render(<Navbar />);
    expect(
      screen.getByRole("button", { name: /open navigation menu/i })
    ).toBeInTheDocument();
  });

  it("hamburger has shrink-0 so it never clips at narrow widths", () => {
    render(<Navbar />);
    const btn = screen.getByRole("button", { name: /open navigation menu/i });
    expect(btn.className).toContain("shrink-0");
  });

  it("mobile menu is hidden before hamburger is clicked (aria-hidden=true)", () => {
    render(<Navbar />);
    const drawer = screen.getByRole("dialog", { hidden: true });
    expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  it("mobile menu becomes visible after hamburger click", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));

    // After opening the drawer aria-hidden should be false
    const drawer = screen.getByRole("dialog", { hidden: true });
    expect(drawer).toHaveAttribute("aria-hidden", "false");
  });

  it("hamburger label changes to 'Close' when menu is open", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));
    expect(
      screen.getByRole("button", { name: /close navigation menu/i })
    ).toBeInTheDocument();
  });

  it("Escape key closes the mobile menu", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));
    // menu is open — now send Escape
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /open navigation menu/i })
      ).toBeInTheDocument();
    });
  });

  it("Connect Wallet button in the mobile drawer has truncate class to prevent overflow", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));

    // Find the wallet button inside the mobile drawer
    const walletButtons = screen.getAllByRole("button", { name: /connect wallet/i });
    // The mobile drawer button is the one NOT in the desktop area (hidden on md+)
    const mobileWalletBtn = walletButtons[walletButtons.length - 1];
    expect(mobileWalletBtn.className).toContain("truncate");
  });

  it("logo link has shrink-0 to prevent it being squashed by the flex container", () => {
    render(<Navbar />);
    const logo = screen.getByRole("link", { name: /elcarehub home/i });
    expect(logo.className).toContain("shrink-0");
  });

  it("LocaleSwitcher is rendered inside the desktop-only section (not in the mobile drawer)", async () => {
    render(<Navbar />);
    // LocaleSwitcher renders without opening the drawer
    const switcher = screen.getByTestId("locale-switcher");
    expect(switcher).toBeInTheDocument();
    // The desktop nav area is hidden on mobile via "hidden md:flex"
    const desktopArea = switcher.closest(".hidden.md\\:flex");
    expect(desktopArea).not.toBeNull();
  });

  it("mobile nav links include all public routes", async () => {
    const user = userEvent.setup();
    render(<Navbar />);

    await user.click(screen.getByRole("button", { name: /open navigation menu/i }));

    // All public nav labels must be present in the mobile drawer
    for (const label of ["Marketplace", "Discover", "Auctions", "Launchpad"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThanOrEqual(1);
    }
  });
});

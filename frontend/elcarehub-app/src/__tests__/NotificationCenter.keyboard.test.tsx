import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationCenter } from "@/components/NotificationCenter";

const mockMarkRead = jest.fn();
const mockMarkAllRead = jest.fn();
const mockUpdatePref = jest.fn();

jest.mock("@/hooks/useNotificationCenter", () => ({
  useNotificationCenter: () => ({
    notifications: [{
      id: "keyboard-notification",
      category: "LISTING_SOLD",
      priority: "HIGH",
      title: "Your watched listing sold",
      body: "Listing sold for 10 XLM.",
      href: "/listings/1",
      receivedAt: Date.now(),
      isRead: false,
      isStale: false,
    }],
    unreadCount: 1,
    prefs: { BID_PLACED: true },
    sseConnected: true,
    markRead: mockMarkRead,
    markAllRead: mockMarkAllRead,
    updatePref: mockUpdatePref,
  }),
}));

async function tabTo(user: ReturnType<typeof userEvent.setup>, target: HTMLElement) {
  for (let index = 0; index < 30 && document.activeElement !== target; index++) {
    await user.tab();
  }
  expect(target).toHaveFocus();
}

describe("NotificationCenter keyboard controls", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(["{Enter}", " "])("opens and closes with the native bell using %s", async (key) => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    const bell = screen.getByRole("button", { name: "1 unread notifications" });
    await user.tab();
    expect(bell).toHaveFocus();
    expect(bell).toHaveAttribute("aria-expanded", "false");
    await user.keyboard(key);
    const panel = screen.getByTestId("notification-panel");
    expect(bell).toHaveAttribute("aria-expanded", "true");
    expect(bell).toHaveAttribute("aria-controls", panel.id);
    await user.keyboard(key);
    expect(screen.queryByTestId("notification-panel")).not.toBeInTheDocument();
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(bell).toHaveFocus();
  });

  it("closes with Escape from a panel control and restores focus to the bell", async () => {
    const user = userEvent.setup();
    const onParentKeyDown = jest.fn();
    render(<div onKeyDown={onParentKeyDown}><NotificationCenter /></div>);
    const bell = screen.getByRole("button", { name: "1 unread notifications" });
    await user.tab();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await tabTo(user, screen.getByTestId("pref-toggle-BID_PLACED"));
    onParentKeyDown.mockClear();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("notification-panel")).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(onParentKeyDown).not.toHaveBeenCalled();
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(mockMarkAllRead).not.toHaveBeenCalled();
    expect(mockUpdatePref).not.toHaveBeenCalled();
  });

  it.each(["{Enter}", " "])("activates each notification update once with %s", async (key) => {
    const user = userEvent.setup();
    render(<NotificationCenter />);
    await user.tab();
    await user.keyboard(key);
    await tabTo(user, screen.getByRole("button", { name: "Mark as read" }));
    await user.keyboard(key);
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
    expect(mockMarkRead).toHaveBeenCalledWith("keyboard-notification");
    await tabTo(user, screen.getByRole("button", { name: "All read" }));
    await user.keyboard(key);
    expect(mockMarkAllRead).toHaveBeenCalledTimes(1);
    await tabTo(user, screen.getByRole("button", { name: "Settings" }));
    await user.keyboard(key);
    const preference = screen.getByTestId("pref-toggle-BID_PLACED");
    expect(preference).toHaveAccessibleName();
    await tabTo(user, preference);
    await user.keyboard(key);
    expect(mockUpdatePref).toHaveBeenCalledTimes(1);
    expect(mockUpdatePref).toHaveBeenCalledWith("BID_PLACED", false);
  });

  it("does not close or steal focus when Escape is pressed outside the component", async () => {
    const user = userEvent.setup();
    render(<><NotificationCenter /><button type="button">Outside</button></>);
    await user.tab();
    await user.keyboard("{Enter}");
    const outside = screen.getByRole("button", { name: "Outside" });
    await tabTo(user, outside);
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
    expect(outside).toHaveFocus();
  });
});

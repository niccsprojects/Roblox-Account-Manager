import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../../store";
import { usePrompt, useConfirm } from "../../hooks/usePrompt";
import { useTr } from "../../i18n/text";
import { MenuItemView, MenuLevel } from "./MenuItemView";
import type { MenuItem } from "./MenuItemView";

export function ContextMenu() {
  const store = useStore();
  const t = useTr();
  const prompt = usePrompt();
  const confirm = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        store.closeContextMenu();
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") store.closeContextMenu();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [store.closeContextMenu]);

  useLayoutEffect(() => {
    if (!store.contextMenu) return;
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const width = el.offsetWidth || 220;
    const height = el.offsetHeight || 360;
    const left = Math.max(pad, Math.min(store.contextMenu.x, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(store.contextMenu.y, window.innerHeight - height - pad));
    setMenuPos({ left, top });
  }, [store.contextMenu]);

  if (!store.contextMenu) return null;

  const accounts = store.selectedAccounts;
  const single = accounts.length === 1 ? accounts[0] : null;
  const userIds = accounts.map((a) => a.UserID);
  const bottingActive = store.bottingStatus?.active === true;
  const activeBottingIds = new Set(store.bottingStatus?.userIds || []);
  const addableBottingIds = userIds.filter((id) => !activeBottingIds.has(id));
  const launchedSelectedIds = userIds.filter((id) => store.launchedByProgram.has(id));
  const singleLaunched = !!single && launchedSelectedIds.includes(single.UserID);

  async function copyToClipboard(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      store.addToast(t("Copied {{label}}", { label }));
    } catch {
      store.addToast(t("Failed to copy"));
    }
  }

  function normalizeQuickLoginCode(value: string) {
    return value.replace(/\D/g, "");
  }

  function copyMulti(getter: (a: typeof accounts[0]) => string, label: string) {
    const text = accounts.map(getter).join("\n");
    copyToClipboard(text, label);
  }

  const copySubmenu: MenuItem[] = [
    {
      label: t("Cookie"),
      action: () => copyMulti((a) => a.SecurityToken, t("cookie")),
    },
    {
      label: t("Username"),
      action: () => copyMulti((a) => a.Username, t("username")),
    },
    {
      label: t("Password"),
      action: () => copyMulti((a) => a.Password, t("password")),
    },
    {
      label: t("User:Pass"),
      action: () => copyMulti((a) => `${a.Username}:${a.Password}`, t("user:pass")),
    },
    {
      label: t("User:Pass:Cookie"),
      action: () =>
        copyMulti((a) => `${a.Username}:${a.Password}:${a.SecurityToken}`, t("user:pass:cookie")),
    },
    { separator: true, label: "" },
    {
      label: t("User ID"),
      action: () => copyMulti((a) => String(a.UserID), t("user ID")),
    },
    {
      label: t("Profile Link"),
      action: () =>
        copyMulti(
          (a) => `https://www.roblox.com/users/${a.UserID}/profile`,
          t("profile link")
        ),
    },
  ];

  if (store.devMode) {
    copySubmenu.push(
      { separator: true, label: "" },
      {
        label: t("rbx-player Link"),
        devOnly: true,
        action: async () => {
          if (!single) return;
          try {
            const ticket = await invoke<string>("get_auth_ticket", {
              userId: single.UserID,
            });
            const ts = Date.now();
            const url = `roblox-player://1/1+launchmode:play+gameinfo:${ticket}+launchtime:${ts}+placelauncherurl:https://assetgame.roblox.com/game/PlaceLauncher.ashx?request=RequestGame%26placeId=${store.placeId}+placeId:${store.placeId}`;
            await copyToClipboard(url, t("rbx-player link"));
          } catch (e) {
            store.addToast(t("Error: {{error}}", { error: String(e) }));
          }
        },
      },
      {
        label: t("App Link"),
        devOnly: true,
        action: async () => {
          if (!single) return;
          try {
            const ticket = await invoke<string>("get_auth_ticket", {
              userId: single.UserID,
            });
            const ts = Date.now();
            const url = `roblox-player://1/1+launchmode:app+gameinfo:${ticket}+launchtime:${ts}+browsertrackerid:${single.BrowserTrackerID || Math.floor(Math.random() * 1e12)}`;
            await copyToClipboard(url, t("app link"));
          } catch (e) {
            store.addToast(t("Error: {{error}}", { error: String(e) }));
          }
        },
      }
    );
  }

  const existingGroups = [...new Set(store.accounts.map((a) => a.Group || "Default"))];
  const moveToGroupSubmenu: MenuItem[] = [
    ...existingGroups.map((g) => ({
      label: g === "Default" ? t("Default") : g,
      action: () => store.moveToGroup(userIds, g),
    })),
    { separator: true, label: "" },
    {
      label: t("New Group..."),
      action: async () => {
        const name = await prompt(t("Group name:"));
        if (name?.trim()) store.moveToGroup(userIds, name.trim());
      },
    },
  ];

  const items: MenuItem[] = [
    {
      label: t("Set Alias"),
      action: async () => {
        const alias = await prompt(t("Alias:"), single?.Alias || "");
        if (alias === null) return;
        for (const a of accounts) {
          store.updateAccount({ ...a, Alias: alias.slice(0, 30) });
        }
        store.addToast(t("Alias updated"));
      },
    },
    {
      label: t("Set Description"),
      action: async () => {
        const desc = await prompt(t("Description:"), single?.Description || "");
        if (desc === null) return;
        for (const a of accounts) {
          store.updateAccount({ ...a, Description: desc });
        }
        store.addToast(t("Description updated"));
      },
    },
    { separator: true, label: "" },
    { label: t("Copy"), submenu: copySubmenu },
    { separator: true, label: "" },
  ];

  if (bottingActive) {
    items.push({
      label:
        addableBottingIds.length > 1
          ? t("Add {{count}} accounts to Botting Mode", { count: addableBottingIds.length })
          : addableBottingIds.length === 1
            ? t("Add {{count}} account to Botting Mode", { count: 1 })
            : t("Already in Botting Mode"),
      action: async () => {
        if (addableBottingIds.length === 0) {
          store.addToast(t("Selected accounts are already in Botting Mode"));
          return;
        }
        try {
          await store.addBottingAccounts(addableBottingIds);
        } catch (e) {
          store.addToast(t("Botting account action failed: {{error}}", { error: String(e) }));
        }
      },
    });
    items.push({ separator: true, label: "" });
  }

  if (singleLaunched || launchedSelectedIds.length > 0) {
    if (singleLaunched) {
      items.push({
        label: t("Focus client"),
        action: async () => {
          if (!single) return;
          try {
            const focused = await store.focusRobloxClient(single.UserID);
            if (!focused) {
              store.addToast(t("No active Roblox window found for this account"));
            }
          } catch (e) {
            store.addToast(t("Failed to focus client: {{error}}", { error: String(e) }));
          }
        },
      });
    }

    items.push({
      label:
        launchedSelectedIds.length <= 1
          ? t("Restart client")
          : t("Restart clients ({{count}})", { count: launchedSelectedIds.length }),
      action: async () => {
        await store.restartRobloxClients(launchedSelectedIds);
      },
    });

    items.push({ separator: true, label: "" });
  }

  if (store.devMode) {
    items.push(
      {
        label: t("Get Auth Ticket"),
        devOnly: true,
        action: async () => {
          if (!single) return;
          try {
            const ticket = await invoke<string>("get_auth_ticket", {
              userId: single.UserID,
            });
            await copyToClipboard(ticket, t("auth ticket"));
          } catch (e) {
            store.addToast(t("Error: {{error}}", { error: String(e) }));
          }
        },
      },
      {
        label: t("View/Edit Fields"),
        devOnly: true,
        action: () => {
          if (!single) return;
          store.setAccountFieldsOpen(true);
        },
      },
      { separator: true, label: "" }
    );
  }

  items.push(
    {
      label: t("Remove Account"),
      className: "text-red-400",
      action: async () => {
        const msg =
          accounts.length === 1
            ? t("Remove {{name}}?", { name: single?.Alias || single?.Username || "" })
            : t("Remove {{count}} accounts?", { count: accounts.length });
        if (await confirm(msg, true)) {
          store.removeAccounts(userIds);
        }
      },
    },
    { separator: true, label: "" },
    { label: t("Move to Group"), submenu: moveToGroupSubmenu },
    {
      label: t("Copy Group"),
      action: () => {
        if (!single) return;
        copyToClipboard(single.Group || "Default", t("group"));
      },
    },
    {
      label: t("Sort Alphabetically"),
      action: () => {
        if (!single) return;
        store.sortGroupAlphabetically(single.Group || "Default");
      },
    },
    {
      label: t("Toggle Group Visibility"),
      action: () => {
        store.setShowGroups(!store.showGroups);
      },
    },
    { separator: true, label: "" },
    {
      label: t("Show Details"),
      action: () => {
        if (!single) return;
        const details = {
          Username: single.Username,
          UserID: single.UserID,
          Alias: single.Alias,
          Description: single.Description,
          Group: single.Group,
          Valid: single.Valid,
          LastUse: single.LastUse,
          LastAttemptedRefresh: single.LastAttemptedRefresh,
          Fields: single.Fields,
          BrowserTrackerID: single.BrowserTrackerID,
          HasPassword: !!single.Password,
          HasCookie: !!single.SecurityToken,
        };
        store.showModal(
          single.Alias || single.Username,
          JSON.stringify(details, null, 2)
        );
      },
    },
    {
      label: t("Quick Login"),
      action: async () => {
        if (!single) return;
        let code = "";
        try {
          const clip = await navigator.clipboard.readText();
          const normalizedClipCode = normalizeQuickLoginCode(clip);
          if (normalizedClipCode.length === 6) code = normalizedClipCode;
        } catch {}
        if (!code) {
          const input = await prompt(t("Enter 6-digit code:"));
          if (!input) return;
          code = normalizeQuickLoginCode(input);
        }
        if (code.length !== 6) {
          store.addToast(t("Invalid code (must be 6 digits)"));
          return;
        }
        try {
          await invoke("quick_login_enter_code", {
            userId: single.UserID,
            code,
          });
          store.addToast(t("Quick login code entered"));
        } catch (e) {
          store.addToast(t("Quick login failed: {{error}}", { error: String(e) }));
        }
      },
    }
  );

  const pos = store.contextMenu;

  return (
    <div
      ref={ref}
      className="theme-modal-scope theme-panel theme-border fixed z-50 min-w-[220px] bg-zinc-900/95 backdrop-blur-xl border border-zinc-700/50 rounded-xl shadow-2xl py-1.5 animate-scale-in"
      style={{
        left: menuPos?.left ?? pos.x,
        top: menuPos?.top ?? pos.y,
      }}
    >
      <MenuLevel>
        {items
          .filter((item) => !item.devOnly || store.devMode)
          .map((item, i) => (
            <MenuItemView
              key={i}
              item={item}
              close={store.closeContextMenu}
              itemKey={String(i)}
            />
          ))}
      </MenuLevel>
    </div>
  );
}

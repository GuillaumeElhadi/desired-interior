import { Store } from "@tauri-apps/plugin-store";

export interface AppSettings {
  falKey: string;
  analyticsEnabled?: boolean;
  anonymousId?: string;
}

const DEFAULTS: AppSettings = { falKey: "" };

let _store: Store | null = null;

async function store(): Promise<Store> {
  if (!_store) _store = await Store.load("settings.json");
  return _store;
}

export async function loadSettings(): Promise<AppSettings> {
  const s = await store();
  const falKey = (await s.get<string>("fal_key")) ?? DEFAULTS.falKey;
  const analyticsEnabled = (await s.get<boolean | null>("analytics_enabled")) ?? undefined;
  const anonymousId = (await s.get<string | null>("anonymous_id")) ?? undefined;
  return { falKey, analyticsEnabled: analyticsEnabled ?? undefined, anonymousId };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const s = await store();
  await s.set("fal_key", settings.falKey);
  if (settings.analyticsEnabled !== undefined) {
    await s.set("analytics_enabled", settings.analyticsEnabled);
  }
  if (settings.anonymousId !== undefined) {
    await s.set("anonymous_id", settings.anonymousId);
  }
  await s.save();
}

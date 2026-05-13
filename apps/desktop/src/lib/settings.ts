import { Store } from "@tauri-apps/plugin-store";

export interface AppSettings {
  falKey: string;
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
  return { falKey };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const s = await store();
  await s.set("fal_key", settings.falKey);
  await s.save();
}

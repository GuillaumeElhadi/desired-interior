import { Store } from "@tauri-apps/plugin-store";

export interface SceneVariantState {
  cleanedSceneId: string;
  cleanedUrl: string;
}

let _store: Store | null = null;

async function store(): Promise<Store> {
  if (!_store) _store = await Store.load("scene-variants.json");
  return _store;
}

export async function loadSceneVariant(sceneId: string): Promise<SceneVariantState | null> {
  const s = await store();
  return (await s.get<SceneVariantState | null>(sceneId)) ?? null;
}

export async function saveSceneVariant(sceneId: string, variant: SceneVariantState): Promise<void> {
  const s = await store();
  await s.set(sceneId, variant);
  await s.save();
}

export async function clearSceneVariant(sceneId: string): Promise<void> {
  const s = await store();
  await s.delete(sceneId);
  await s.save();
}

import Database from "@tauri-apps/plugin-sql";

export interface ObjectRecord {
  id: string;
  scene_id: string;
  name: string;
  masked_url: string;
  width: number;
  height: number;
  created_at: number;
}

const DB_PATH = "sqlite:interior-vision.db";

let _db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!_db) {
    _db = await Database.load(DB_PATH);
  }
  return _db;
}

/** Reset the cached DB connection — for tests only. */
export function _resetDbForTest(): void {
  _db = null;
}

export async function loadObjects(sceneId: string): Promise<ObjectRecord[]> {
  const db = await getDb();
  return db.select<ObjectRecord[]>(
    "SELECT * FROM objects WHERE scene_id = $1 ORDER BY created_at ASC",
    [sceneId]
  );
}

export async function saveObject(record: ObjectRecord): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT OR IGNORE INTO objects (id, scene_id, name, masked_url, width, height, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [
      record.id,
      record.scene_id,
      record.name,
      record.masked_url,
      record.width,
      record.height,
      record.created_at,
    ]
  );
}

export async function removeObject(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM objects WHERE id = $1", [id]);
}

export async function renameObject(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE objects SET name = $1 WHERE id = $2", [name, id]);
}

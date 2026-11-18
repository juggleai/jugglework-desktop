/** Only local, resized raster images are stored; never retain full paths or EXIF metadata. */
type ImportedBackground = { id: `custom-${string}`; label: string; url: string };
const store = "images";

async function withStore<T>(mode: IDBTransactionMode, operation: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("jugglework.meeting-backgrounds", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(store, { keyPath: "id" });
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = operation(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error ?? new Error("无法保存本机背景"));
    });
  } finally { db.close(); }
}

export function listImportedBackgrounds(): Promise<ImportedBackground[]> {
  return withStore("readonly", s => s.getAll());
}

export async function readImportedBackgroundUrl(id: string): Promise<string | null> {
  const item: ImportedBackground | undefined = await withStore("readonly", s => s.get(id));
  return item?.url ?? null;
}

export async function deleteImportedBackground(id: string) {
  await withStore("readwrite", s => s.delete(id));
}

export async function importMeetingBackground(file: File): Promise<ImportedBackground> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || !file.size || file.size > 12 * 1024 * 1024) {
    throw new Error("请选择不超过 12 MB 的 JPG、PNG 或 WebP 图片。");
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法读取本机图片。");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const item: ImportedBackground = { id: `custom-${crypto.randomUUID()}`, label: file.name.slice(0, 120), url: canvas.toDataURL("image/jpeg", 0.82) };
    await withStore("readwrite", s => s.add(item));
    return item;
  } finally { bitmap.close(); }
}

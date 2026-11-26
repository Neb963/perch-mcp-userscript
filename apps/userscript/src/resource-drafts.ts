import type { KeyValueStore } from "./native-types.js";
export interface LocalResourceDraft {
  schemaVersion: 1;
  key: string;
  documentId: string;
  editedAt: number;
  value: string;
}
/** Local unpublished drafts have document ownership; canonical Resource versions remain in Registry. */
export class DocumentDraftStore {
  private readonly prefix = "perch:manager-draft:v2:";
  constructor(
    private store: KeyValueStore,
    private documentId: string,
    private budget = 64 * 1024 * 1024,
  ) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(documentId))
      throw new Error("Invalid draft document identity.");
  }
  private storageKey(key: string) {
    if (key.length > 256) throw new Error("Draft key exceeds limit.");
    return this.prefix + encodeURIComponent(key) + ":" + this.documentId;
  }
  async list(): Promise<LocalResourceDraft[]> {
    const rows: LocalResourceDraft[] = [];
    for (const key of (await this.store.list()).filter((k) =>
      k.startsWith(this.prefix),
    )) {
      const row = await this.store.get<LocalResourceDraft>(key);
      if (
        row?.schemaVersion === 1 &&
        typeof row.key === "string" &&
        typeof row.value === "string" &&
        typeof row.documentId === "string" &&
        Number.isFinite(row.editedAt)
      )
        rows.push(row);
    }
    return rows.sort(
      (a, b) =>
        b.editedAt - a.editedAt || a.documentId.localeCompare(b.documentId),
    );
  }
  async get(key: string): Promise<string | undefined> {
    const own = await this.store.get<LocalResourceDraft>(this.storageKey(key));
    if (own?.schemaVersion === 1 && typeof own.value === "string")
      return own.value;
    const latest = (await this.list()).find((row) => row.key === key);
    if (latest) return latest.value;
    return this.store.get<string>("perch:manager-draft:" + key);
  }
  async set(key: string, value: string): Promise<void> {
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > 16 * 1024 * 1024)
      throw new Error("Unpublished Resource draft exceeds 16 MiB.");
    const all = await this.list();
    const retained = all.filter(
      (r) => !(r.documentId === this.documentId && r.key === key),
    );
    if (
      retained.length >= 1000 ||
      retained.reduce(
        (n, r) => n + new TextEncoder().encode(r.value).length,
        0,
      ) +
        bytes >
        this.budget
    )
      throw new Error(
        "Unpublished draft budget reached. Export retained drafts before cleanup.",
      );
    await this.store.set(this.storageKey(key), {
      schemaVersion: 1,
      key,
      documentId: this.documentId,
      editedAt: Date.now(),
      value,
    } satisfies LocalResourceDraft);
  }
  async delete(key: string): Promise<void> {
    await this.store.delete(this.storageKey(key));
  }
  async export(): Promise<{
    schemaVersion: 1;
    requiresExplicitPublish: true;
    drafts: LocalResourceDraft[];
  }> {
    const drafts = await this.list();
    for (const key of (await this.store.list()).filter(
      (k) => k.startsWith("perch:manager-draft:") && !k.startsWith(this.prefix),
    )) {
      const value = await this.store.get<unknown>(key);
      if (typeof value === "string")
        drafts.push({
          schemaVersion: 1,
          key: key.slice("perch:manager-draft:".length),
          documentId: "legacy",
          editedAt: 0,
          value,
        });
    }
    return { schemaVersion: 1, requiresExplicitPublish: true, drafts };
  }
}

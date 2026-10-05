import type { PrismaClient } from '@photobooth/database';
import { mergeSettings, settingsSchema, SETTINGS_SECTIONS, type Settings, type SettingsSection } from '@photobooth/shared';
import type { EventBus } from './bus';

/**
 * Settings = env/code defaults + admin overrides (AppSetting rows, one per section).
 * Cached in memory; updates are validated with zod before being persisted.
 */
export class SettingsService {
  private current: Settings;
  private overrides: Partial<Record<SettingsSection, unknown>> = {};

  constructor(
    private readonly prisma: PrismaClient,
    readonly defaults: Settings,
    private readonly bus: EventBus,
  ) {
    this.current = defaults;
  }

  async load(): Promise<Settings> {
    const rows = await this.prisma.appSetting.findMany();
    const o: Partial<Record<SettingsSection, unknown>> = {};
    for (const r of rows) if ((SETTINGS_SECTIONS as string[]).includes(r.key)) o[r.key as SettingsSection] = r.value;
    try {
      this.current = mergeSettings(this.defaults, o);
      this.overrides = o;
    } catch {
      // A bad stored override must never brick the booth: fall back per section.
      const safe: Partial<Record<SettingsSection, unknown>> = {};
      for (const [k, v] of Object.entries(o)) {
        try {
          mergeSettings(this.defaults, { [k]: v });
          safe[k as SettingsSection] = v;
        } catch {
          /* drop invalid section */
        }
      }
      this.current = mergeSettings(this.defaults, safe);
      this.overrides = safe;
    }
    return this.current;
  }

  get(): Settings {
    return this.current;
  }

  getOverrides() {
    return this.overrides;
  }

  async update(section: SettingsSection, value: unknown, updatedBy: string): Promise<Settings> {
    const next = mergeSettings(this.current, { [section]: value });
    // Validate the merged section precisely.
    settingsSchema.shape[section].parse(next[section]);
    const stored = next[section] as object;
    await this.prisma.appSetting.upsert({
      where: { key: section },
      create: { key: section, value: stored as never, updatedBy },
      update: { value: stored as never, updatedBy },
    });
    this.overrides[section] = stored;
    this.current = next;
    this.bus.emitSettings();
    return next;
  }

  async reset(section: SettingsSection): Promise<Settings> {
    await this.prisma.appSetting.deleteMany({ where: { key: section } });
    delete this.overrides[section];
    this.current = mergeSettings(this.defaults, this.overrides);
    this.bus.emitSettings();
    return this.current;
  }
}

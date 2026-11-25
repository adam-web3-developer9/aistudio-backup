import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { AigateClient } from '../comfyui/aigate-client.js';
import type { AigateAsrNodes } from './aigate-nodes.js';

export const instanceIdSchema = z.string().regex(/^[1-9]\d{0,18}$/);
export const aigateAsrTemplates = z.array(z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  areaName: z.enum(['华东一区', '华东二区']),
  imageId: instanceIdSchema,
  skuName: z.string().min(1).optional(),
  skuNames: z.array(z.string().min(1)).min(1).optional(),
  instanceId: instanceIdSchema.optional(),
}).refine(template => (template.skuName === undefined) !== (template.skuNames === undefined),
  'ASR AIGate template requires either skuName or skuNames'))
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate ASR AIGate template');

export type AsrAigateTemplate = z.infer<typeof aigateAsrTemplates>[number];
export type AsrAigateRental = Pick<AigateClient, 'createInstance' | 'findInstancesByName'>;
type Slot = { instance_id: string | null; request_name: string | null; request_at: number | null };
const cooldownMs = 30_000;

export class AigateAsrTemplates {
  constructor(private readonly db: Database.Database, private readonly power: AigateAsrNodes,
      private readonly platform: AsrAigateRental, templates: AsrAigateTemplate[], private readonly clock = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS aigate_asr_templates (
      id TEXT PRIMARY KEY, instance_id TEXT UNIQUE, request_name TEXT UNIQUE, request_at INTEGER
    )`);
    const insert = db.prepare('INSERT OR IGNORE INTO aigate_asr_templates(id, instance_id) VALUES (?, ?)');
    for (const template of templates) insert.run(template.id, template.instanceId ?? null);
  }

  async resolve(template: AsrAigateTemplate, demand: boolean, canReplace: boolean) {
    const row = this.db.prepare('SELECT * FROM aigate_asr_templates WHERE id=?').get(template.id) as Slot;
    if (row.instance_id && (!demand || !canReplace || !await this.power.released(row.instance_id))) return row.instance_id;
    if (row.instance_id) {
      this.db.prepare('UPDATE aigate_asr_templates SET instance_id=NULL, request_name=NULL, request_at=NULL WHERE id=? AND instance_id=?')
        .run(template.id, row.instance_id);
      row.request_at = null;
    }
    const now = this.clock();
    if (row.request_at !== null && now - row.request_at < cooldownMs) return;
    if (row.request_name) {
      // A lost rental reply does not authorize another purchase. Recover only
      // by the durable unique name and original image and region.
      const claimed = this.db.prepare(`UPDATE aigate_asr_templates SET request_at=? WHERE id=? AND request_name=?
        AND instance_id IS NULL AND request_at <= ?`).run(now, template.id, row.request_name, now - cooldownMs);
      if (!claimed.changes) return;
      const result = await this.platform.findInstancesByName(row.request_name, { maxPages: 10 });
      const candidates = result.records.filter(item => (item.operationStatus ?? item.status) !== '4');
      if (candidates.length !== 1) return;
      const instance = candidates[0]!;
      if (instance.areaName !== template.areaName || instance.imageId !== template.imageId || instance.imageType !== '3') {
        throw new Error('AIGate ASR rental receipt does not match the template');
      }
      return this.bind(template.id, row.request_name, instance.id);
    }
    if (!demand) return;
    const name = 'qasr-' + randomUUID().replaceAll('-', '').slice(0, 15);
    const claimed = this.db.prepare(`UPDATE aigate_asr_templates SET request_name=?,request_at=?
      WHERE id=? AND instance_id IS NULL AND request_name IS NULL AND (request_at IS NULL OR request_at <= ?)`)
      .run(name, now, template.id, now - cooldownMs);
    if (!claimed.changes) return;
    try {
      const skus = template.skuNames ?? [template.skuName!];
      for (const [index, skuName] of skus.entries()) {
        try {
          const instance = await this.platform.createInstance({
            areaName: template.areaName, skuName, imageId: template.imageId, imageType: '3',
            count: 1, instanceName: name,
          });
          return this.bind(template.id, name, instance);
        } catch (error) {
          const failure = error as { code?: string; uncertain?: boolean };
          // A confirmed capacity rejection leaves no instance. Other replies
          // end this rental attempt and keep its name for reconciliation.
          if (failure?.code !== 'CAPACITY_UNAVAILABLE' || failure.uncertain !== false
              || index === skus.length - 1) throw error;
        }
      }
    } catch (error) {
      if ((error as { uncertain?: boolean })?.uncertain === false) {
        this.db.prepare('UPDATE aigate_asr_templates SET request_name=NULL WHERE id=? AND request_name=?')
          .run(template.id, name);
      }
      throw error;
    }
  }

  private bind(template: string, name: string, instance: string) {
    const changed = this.db.prepare(`UPDATE aigate_asr_templates SET instance_id=?, request_name=NULL,request_at=NULL
      WHERE id=? AND request_name=? AND instance_id IS NULL`).run(instance, template, name);
    return changed.changes ? instance : undefined;
  }
}

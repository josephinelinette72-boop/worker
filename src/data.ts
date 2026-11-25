/**
 * What the agents leave behind, read for the page.
 *
 * Ops: files in <wallet>/agents/ops/output/.
 * Marketing: the queue code from the marketing project itself, imported at
 * runtime, so approve/reject/publish behave exactly like its commands.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

export function opsData(walletDir: string) {
  const out = path.join(walletDir, 'agents', 'ops', 'output');
  const listDir = (sub: string, ext: string) => {
    const dir = path.join(out, sub);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(ext)).sort().reverse();
  };
  return {
    reports(): { name: string; title: string }[] {
      return listDir('reports', '.md').slice(0, 50).map((name) => {
        const first = readFileSync(path.join(out, 'reports', name), 'utf8').split('\n')[0] ?? '';
        return { name, title: first.replace(/^#\s*/, '') || name };
      });
    },
    report(name: string): string {
      if (!SAFE_NAME.test(name) || !name.endsWith('.md')) throw new Error('Bad report name.');
      return readFileSync(path.join(out, 'reports', name), 'utf8');
    },
    alerts(): unknown[] {
      const file = path.join(out, 'alerts.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .slice(-200)
        .reverse()
        .map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return { severity: 'warning', title: 'Unreadable alert line', details: l };
          }
        });
    },
    proposals(): { name: string; file: unknown }[] {
      return listDir('proposals', '.json')
        .slice(0, 50)
        .map((name) => ({ name, file: JSON.parse(readFileSync(path.join(out, 'proposals', name), 'utf8')) as unknown }));
    },
  };
}

type Campaign = { id: string; name: string; subject: string; createdAt: string; publishedAt?: string } & Record<string, unknown>;
type Status = 'pending' | 'approved' | 'rejected';
type BrandInfo = { id: string; name: string; regulated: boolean; requiredDisclosure: string };

type MarketingModules = {
  brand: { listBrands(): string[]; loadBrand(id: string): BrandInfo };
  store: {
    listCampaigns(status: Status): Campaign[];
    findCampaign(id: string): { campaign: Campaign; status: Status } | undefined;
    moveCampaign(c: Campaign, from: Status, to: Status, patch?: object): Campaign;
  };
  publish: { publishApproved(): Promise<Campaign[]>; campaignMarkdown(c: Campaign): string };
  tools: { campaignTask(input: { subject: string; brief?: string; brand?: BrandInfo; web: boolean }): string };
};

export async function marketingData(marketingDir: string) {
  const src = path.join(marketingDir, 'src');
  const m: MarketingModules = {
    brand: (await import(path.join(src, 'brand.ts'))) as MarketingModules['brand'],
    store: (await import(path.join(src, 'store.ts'))) as MarketingModules['store'],
    publish: (await import(path.join(src, 'publish.ts'))) as MarketingModules['publish'],
    tools: (await import(path.join(src, 'tools.ts'))) as MarketingModules['tools'],
  };
  const statuses: Status[] = ['pending', 'approved', 'rejected'];
  return {
    /** Optional brand packs. */
    brands() {
      return m.brand.listBrands().map((id) => {
        const b = m.brand.loadBrand(id);
        return { id, name: b.name, regulated: b.regulated };
      });
    },
    loadBrand(id: string) {
      if (!m.brand.listBrands().includes(id)) throw new Error(`Unknown brand pack ${id}`);
      return m.brand.loadBrand(id);
    },
    task: m.tools.campaignTask,
    campaigns() {
      return Object.fromEntries(
        statuses.map((s) => [s, m.store.listCampaigns(s).map((c) => ({ ...c, markdown: m.publish.campaignMarkdown(c) }))]),
      );
    },
    review(id: string, decision: 'approve' | 'reject', reason?: string) {
      const found = m.store.findCampaign(id);
      if (!found || found.status !== 'pending') throw new Error('That campaign is no longer waiting for review.');
      const at = new Date().toISOString();
      if (decision === 'approve') return m.store.moveCampaign(found.campaign, 'pending', 'approved', { review: { decision: 'approved', at } });
      return m.store.moveCampaign(found.campaign, 'pending', 'rejected', {
        review: { decision: 'rejected', reason: reason?.trim() || 'no reason given', at },
      });
    },
    publish() {
      return m.publish.publishApproved();
    },
  };
}

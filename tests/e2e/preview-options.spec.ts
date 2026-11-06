import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';
import type { LayoutConfig } from '../../src/core/model';

interface ConversionJob {
  id: number;
  config: LayoutConfig;
  preview: boolean;
  terminated: boolean;
  resultConfig?: LayoutConfig;
}

interface ObservedWorkers {
  jobs: ConversionJob[];
  release: (id: number) => boolean;
}

declare global {
  interface Window {
    previewWorkers: ObservedWorkers;
  }
}

async function holdConversions(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const releases = new Map<number, () => void>();
    const jobs: ConversionJob[] = [];
    window.previewWorkers = {
      jobs,
      release: (id) => {
        const job = jobs.find((entry) => entry.id === id);
        const forward = releases.get(id);
        if (!job || job.terminated || !forward) return false;
        releases.delete(id);
        forward();
        return true;
      },
    };
    window.Worker = class extends NativeWorker {
      private conversion?: ConversionJob;

      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', ({ data }) => {
          const conversion = this.conversion;
          if (data.type === 'result' && conversion && conversion.id === data.id)
            conversion.resultConfig = structuredClone(data.value.layout.config);
        });
      }

      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const payload = message as {
          type?: string;
          id: number;
          config: LayoutConfig;
          range?: number[];
        };
        const forward = () => {
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        };
        if (payload?.type !== 'convert') {
          forward();
          return;
        }
        this.conversion = {
          id: payload.id,
          config: structuredClone(payload.config),
          preview: payload.range !== undefined,
          terminated: false,
        };
        jobs.push(this.conversion);
        releases.set(payload.id, forward);
      }

      terminate() {
        if (this.conversion) {
          this.conversion.terminated = true;
          releases.delete(this.conversion.id);
        }
        super.terminate();
      }
    };
  });
}

const mm = (value: number) => (value * 72) / 25.4;
const jobs = (page: Page) => page.evaluate(() => window.previewWorkers.jobs);
const release = (page: Page, id: number) =>
  page.evaluate((job) => window.previewWorkers.release(job), id);

test('editing margins cancels active previews and keeps only the latest settings', async ({
  page,
}) => {
  await holdConversions(page);
  await page.goto('');
  await page
    .locator('#pdf-file-input')
    .setInputFiles(resolve('.cache/fixtures/mixed-document.pdf'));
  await expect.poll(async () => (await jobs(page)).length, { timeout: 60_000 }).toBe(1);

  const top = page.getByRole('spinbutton', { name: '위 여백', exact: true });
  const bottom = page.getByRole('spinbutton', { name: '아래 여백', exact: true });
  const toolbar = page.locator('[data-scope]');
  const first = (await jobs(page))[0];
  expect(first.preview).toBe(true);
  await expect(top).toBeEnabled();
  await expect(bottom).toBeEnabled();

  await top.fill('14');
  expect((await jobs(page)).find((job) => job.id === first.id)?.terminated).toBe(true);
  await expect(top).toBeFocused();
  await expect.poll(async () => (await jobs(page)).length).toBe(2);
  const interrupted = (await jobs(page))[1];
  await expect(top).toBeFocused();
  await expect(bottom).toBeEnabled();
  expect(interrupted.config.marginTopPt).toBeCloseTo(mm(14), 6);

  await top.fill('16');
  expect((await jobs(page)).find((job) => job.id === interrupted.id)?.terminated).toBe(true);
  await top.fill('18');
  await bottom.fill('15');
  await expect
    .poll(async () => {
      const last = (await jobs(page)).at(-1)!;
      return [last.terminated, last.config.marginTopPt, last.config.marginBottomPt];
    })
    .toEqual([false, mm(18), mm(15)]);
  const latest = (await jobs(page)).at(-1)!;
  await expect(bottom).toBeFocused();
  const disabledSettings = await page
    .locator('.settings-sidebar input, .settings-sidebar button')
    .evaluateAll((controls) => controls.filter((control) => control.matches(':disabled')).length);
  expect(disabledSettings).toBe(0);
  expect(await release(page, first.id)).toBe(false);
  expect(await release(page, interrupted.id)).toBe(false);
  expect(await release(page, latest.id)).toBe(true);

  await expect(toolbar).toHaveAttribute('data-scope', 'preview', { timeout: 60_000 });
  await expect(toolbar).toHaveAttribute('data-stale', 'false');
  await expect(page.getByRole('button', { name: '변환', exact: true })).toBeEnabled();
  await expect(page.locator('.error-message')).toHaveCount(0);
  const completed = (await jobs(page)).find((job) => job.id === latest.id)!;
  expect(completed.resultConfig?.marginTopPt).toBeCloseTo(mm(18), 6);
  expect(completed.resultConfig?.marginBottomPt).toBeCloseTo(mm(15), 6);
  expect((await jobs(page)).filter((job) => job.resultConfig).map((job) => job.id)).toEqual([
    latest.id,
  ]);

  await page.getByRole('button', { name: '변환', exact: true }).click();
  await expect.poll(async () => (await jobs(page)).at(-1)?.preview).toBe(false);
  const full = (await jobs(page)).at(-1)!;
  expect(full.config.marginTopPt).toBeCloseTo(mm(18), 6);
  expect(full.config.marginBottomPt).toBeCloseTo(mm(15), 6);
  expect(await release(page, full.id)).toBe(true);
  await expect(toolbar).toHaveAttribute('data-scope', 'full', { timeout: 60_000 });
  await expect(toolbar).toHaveAttribute('data-stale', 'false');
  await expect(page.getByRole('button', { name: 'PDF 다운로드', exact: true })).toBeEnabled();
  await expect(page.locator('.error-message')).toHaveCount(0);
});

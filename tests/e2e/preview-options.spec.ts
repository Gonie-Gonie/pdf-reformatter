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

test('automatic figure rotation defaults on, cancels older previews, and resets to on', async ({
  page,
}) => {
  await holdConversions(page);
  await page.goto('');
  const section = page.getByRole('region', { name: '자동조정', exact: true });
  const rotation = section.getByRole('checkbox', { name: '큰 표·그림 자동 회전', exact: true });
  await expect(rotation).toBeChecked();
  await page
    .locator('#pdf-file-input')
    .setInputFiles(resolve('.cache/fixtures/mixed-document.pdf'));
  await expect.poll(async () => (await jobs(page)).length, { timeout: 60_000 }).toBe(1);
  const initial = (await jobs(page))[0];
  expect(initial.config.autoRotateFigures).toBe(true);

  await rotation.uncheck();
  expect((await jobs(page)).find((job) => job.id === initial.id)?.terminated).toBe(true);
  await expect.poll(async () => (await jobs(page)).at(-1)?.config.autoRotateFigures).toBe(false);
  const optedOut = (await jobs(page)).at(-1)!;
  await expect(rotation).not.toBeChecked();
  await expect(rotation).toBeEnabled();

  await page.getByRole('button', { name: '기본 설정으로', exact: true }).click();
  await expect(rotation).toBeChecked();
  expect((await jobs(page)).find((job) => job.id === optedOut.id)?.terminated).toBe(true);
  await expect
    .poll(async () => {
      const current = (await jobs(page)).at(-1)!;
      return [current.id !== optedOut.id, current.config.autoRotateFigures];
    })
    .toEqual([true, true]);
  const latest = (await jobs(page)).at(-1)!;
  expect(await release(page, initial.id)).toBe(false);
  expect(await release(page, optedOut.id)).toBe(false);
  expect(await release(page, latest.id)).toBe(true);
  await expect(page.locator('[data-scope]')).toHaveAttribute('data-scope', 'preview', {
    timeout: 60_000,
  });
  expect(
    (await jobs(page)).find((job) => job.id === latest.id)?.resultConfig?.autoRotateFigures,
  ).toBe(true);
  await expect(page.locator('.error-message')).toHaveCount(0);
});

test('line spacing uses a percentage that stays fixed when font size changes', async ({ page }) => {
  await page.goto('');
  const spacing = page.getByRole('spinbutton', { name: '줄간격', exact: true });
  const fontSize = page.getByRole('spinbutton', { name: '글자 크기', exact: true });
  await expect(spacing.locator('..')).toHaveText('%');
  await expect(spacing).toHaveValue('160');
  await expect(spacing).toHaveAttribute('step', '10');
  await expect(fontSize).toHaveAttribute('step', '0.5');
  await expect(page.getByRole('spinbutton', { name: '가로', exact: true })).toHaveAttribute(
    'step',
    '0.1',
  );
  await expect(page.getByRole('spinbutton', { name: '세로', exact: true })).toHaveAttribute(
    'step',
    '0.1',
  );
  for (const label of ['위 여백', '아래 여백', '왼쪽 여백', '오른쪽 여백', '문단 간격'])
    await expect(page.getByRole('spinbutton', { name: label, exact: true })).toHaveAttribute(
      'step',
      '1',
    );
  await spacing.fill('150');
  await fontSize.fill('20');
  await expect(spacing).toHaveValue('150');
  await expect(fontSize).toHaveValue('20');
  await expect(page.locator('.error-message')).toHaveCount(0);
});

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

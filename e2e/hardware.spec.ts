import { test, expect } from '@playwright/test';
import { design, emitSerial, enterHardware, fakeSerial, fakeSerialState, fresh, loadExample, state } from './helpers';

/**
 * 实机 — the cable to a real board (阶段 5 RFC §5.1).
 *
 * The port is faked (a headless browser has no board), but everything above it is
 * the shipping code: the Web Serial adapter, the line decoder and the panel. What
 * these tests hold to is the feature's one promise — show what the board actually
 * printed, and never dress that up as simulation.
 */
test.describe('实机 · a cable, not a simulation', () => {
  test('① a board that prints appears line by line, and the panel never claims to be the simulator', async ({ page }) => {
    await fakeSerial(page);
    await fresh(page);
    await enterHardware(page);
    expect((await state(page)).mode).toBe('hardware');
    await expect(page.getByTestId('hardware-panel')).toContainText('这不是仿真');
    await expect(page.getByTestId('hardware-unsupported')).toHaveCount(0);
    await expect(page.getByTestId('hardware-console')).toContainText('还没有连接');

    await page.getByTestId('hardware-baud').selectOption('9600');
    await page.getByTestId('hardware-connect').click();
    await expect(page.getByTestId('hardware-disconnect')).toBeVisible();
    expect((await fakeSerialState(page)).opened, '开的是用户选的波特率').toEqual([9600]);

    // a chunk that stops mid-line: only the finished line may be shown
    await emitSerial(page, 'I (312) boot: ESP32-S3\nI (410) app: hel');
    await expect(page.getByTestId('hardware-console')).toContainText('I (312) boot: ESP32-S3');
    await expect(page.getByTestId('hardware-console')).not.toContainText('I (410) app: hel');
    await emitSerial(page, 'lo\n');
    await expect(page.getByTestId('hardware-console')).toContainText('I (410) app: hello');

    await page.getByTestId('hardware-clear').click();
    await expect(page.getByTestId('hardware-console')).toContainText('已连接，等待板子输出');
  });

  test('② 复位 pulses EN the way the auto-reset circuit expects, and 断开 closes the port', async ({ page }) => {
    await fakeSerial(page);
    await fresh(page);
    await enterHardware(page);
    await page.getByTestId('hardware-connect').click();
    await expect(page.getByTestId('hardware-disconnect')).toBeVisible();

    await page.getByTestId('hardware-reset').click();
    await expect
      .poll(async () => (await fakeSerialState(page)).signals)
      // RTS low pulls EN down; DTR must stay de-asserted or the chip boots into download mode
      .toEqual([{ dataTerminalReady: false, requestToSend: true }, { requestToSend: false }]);

    await page.getByTestId('hardware-disconnect').click();
    await expect(page.getByTestId('hardware-connect')).toBeVisible();
    await expect.poll(async () => (await fakeSerialState(page)).closes).toBe(1);
  });

  test('③ a cancelled picker is not an error to shout about; a yanked cable is', async ({ page }) => {
    await fakeSerial(page);
    await fresh(page);
    await enterHardware(page);

    await page.evaluate(() => ((window as unknown as { __fakeSerial: { cancelPicker: boolean } }).__fakeSerial.cancelPicker = true));
    await page.getByTestId('hardware-connect').click();
    await expect(page.getByTestId('hardware-error')).toHaveText('没有选择串口。');
    await expect(page.getByTestId('hardware-connect')).toBeVisible();

    await page.evaluate(() => ((window as unknown as { __fakeSerial: { cancelPicker: boolean } }).__fakeSerial.cancelPicker = false));
    await page.getByTestId('hardware-connect').click();
    await expect(page.getByTestId('hardware-disconnect')).toBeVisible();

    await emitSerial(page, 'up\n');
    await expect(page.getByTestId('hardware-console')).toContainText('up');
    await page.evaluate(() => (window as unknown as { __fakeSerial: { drop: (r: string) => void } }).__fakeSerial.drop('The device has been lost.'));
    await expect(page.getByTestId('hardware-error')).toContainText('连接已断开');
    await expect(page.getByTestId('hardware-connect'), '断开后可以再连一次').toBeVisible();
    await expect(page.getByTestId('hardware-console'), '已经收到的行不会因为断开而消失').toContainText('up');
  });

  test('④ the design is untouchable in 实机, and the connection does not survive leaving it', async ({ page }) => {
    await fakeSerial(page);
    await fresh(page);
    await loadExample(page, 'touch_display');
    await enterHardware(page);
    await page.getByTestId('hardware-connect').click();
    await expect(page.getByTestId('hardware-disconnect')).toBeVisible();

    // 实机 只是看一块真板打印什么: the canvas keeps no editing affordance at all
    for (const id of ['tool-wire', 'undo', 'tab-dsl', 'sim-run', 'lib-esp32s3_n16r8_dual_usb']) {
      await expect(page.getByTestId(id), `${id} 不属于实机`).toHaveCount(0);
    }
    const revisionBefore = (await design(page)).metadata.revision;
    await page.getByTestId('canvas').press('Delete');
    expect((await design(page)).metadata.revision, '实机 里键盘也删不掉东西').toBe(revisionBefore);

    await page.getByTestId('mode-build').click();
    await expect(page.getByTestId('tool-select')).toBeVisible();
    await expect.poll(async () => (await fakeSerialState(page)).closes, { message: '离开实机会挂断，不留一个看不见的串口' }).toBe(1);
  });
});

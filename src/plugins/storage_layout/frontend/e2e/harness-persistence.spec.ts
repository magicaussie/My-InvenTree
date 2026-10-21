import { expect, test } from '@playwright/test';
import { open, recordedCalls } from './helpers';

test('created drawer and bin survive save, reload, reopen and another edit', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await page.getByLabel('Add drawer', { exact: true }).click();
  const inspector = page.getByTestId('drawer-inspector');
  await inspector.getByLabel('Label', { exact: true }).fill('Persistent drawer');
  await page.getByLabel('Save layout', { exact: true }).click();
  await expect(page.getByText('revision 4', { exact: true })).toBeVisible();
  const put = (await recordedCalls(page)).find((call) => call.method === 'PUT');
  const drawer = put?.body.drawers.find((entry: { label: string }) => entry.label === 'Persistent drawer');
  expect(drawer?.id).toBeTruthy();

  await page.reload();
  const drawerButton = page.getByTestId('drawer-list').getByRole('button', { name: 'Drawer Persistent drawer', exact: true });
  await expect(drawerButton).toBeVisible();
  await drawerButton.click();
  await inspector.getByLabel('Label', { exact: true }).fill('Reopened drawer');
  await page.getByLabel('Save layout', { exact: true }).click();
  await expect(page.getByText('revision 5', { exact: true })).toBeVisible();

  await open(page, { path: `/drawers/${drawer.id}/design`, feature: 'RenderDrawerDesigner' });
  await expect(page.getByText('Drawer Reopened drawer', { exact: true })).toBeVisible();
  await page.getByLabel('Add bin', { exact: true }).click();
  const binInspector = page.getByTestId('bin-inspector');
  await binInspector.getByLabel('Label', { exact: true }).fill('Persistent bin');
  await page.getByLabel('Save layout', { exact: true }).click();
  await expect(page.getByText('Unsaved', { exact: true })).not.toBeVisible();
  await page.reload();
  const binButton = page.getByTestId('bin-list').getByRole('button', { name: 'Bin Persistent bin', exact: true });
  await expect(binButton).toBeVisible();
  await binButton.click();
  await binInspector.getByLabel('Label', { exact: true }).fill('Edited again');
  await page.getByLabel('Save layout', { exact: true }).click();
  await expect(page.getByText('Unsaved', { exact: true })).not.toBeVisible();
  const saves = (await recordedCalls(page)).filter((call) => call.method === 'PUT');
  expect(saves.at(-1)?.headers?.['If-Match']).toBe('"6"');
  await open(page, { path: '/drawers/drawer-1/design', feature: 'RenderDrawerDesigner' });
  await expect(page.getByTestId('bin-list').getByRole('button', { name: 'Bin A1-01', exact: true })).toBeVisible();
  await open(page, { path: `/drawers/${drawer.id}/design`, feature: 'RenderDrawerDesigner' });
  await expect(page.getByTestId('bin-list').getByRole('button', { name: 'Bin Edited again', exact: true })).toBeVisible();
});

test('a separate browser test starts with the original fixture', async ({ page }) => {
  await open(page, { path: '/cabinets/cab-1/design', feature: 'RenderCabinetDesigner' });
  await expect(page.getByText('revision 3', { exact: true })).toBeVisible();
  await expect(page.getByTestId('drawer-list').getByRole('button')).toHaveCount(2);
});

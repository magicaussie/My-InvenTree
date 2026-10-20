import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

Element.prototype.scrollIntoView = vi.fn();

import type { StorageLayoutClient } from '../src/api/client';
import {
  type ElectricalDocument,
  StorageLayoutApiError
} from '../src/api/types';
import { SimulationPanel } from '../src/components/editor/SimulationPanel';
import { TopologyEditor } from '../src/components/editor/TopologyEditor';

it('uses saved purpose-specific profiles without overriding duration and shows the frozen snapshot', async () => {
  const profiles = ['locate', 'test', 'reserved'].map((purpose) => ({
    id: purpose,
    name: `${purpose} saved`,
    purpose,
    rgb: [1, 2, 3],
    white: 0,
    brightness: 42,
    duration_seconds: purpose === 'test' ? 7 : 37
  }));
  const listProfiles = vi.fn().mockResolvedValue({ results: profiles });
  const session = {
    id: 'session',
    state: 'completed',
    executions: [],
    profile: profiles[0],
    plan: { duration_seconds: 37 }
  };
  const createLocateSession = vi.fn().mockResolvedValue(session);
  const pixelTest = vi.fn().mockResolvedValue({
    ...session,
    profile: profiles[1],
    plan: { duration_seconds: 7 }
  });
  const client = {
    listProfiles,
    createLocateSession,
    pixelTest
  } as unknown as StorageLayoutClient;
  render(
    <MantineProvider env='test'>
      <SimulationPanel
        client={client}
        cabinetId='cab'
        totalPixels={10}
        mappingHash='hash'
        topology={[]}
        readOnly={false}
        defaultTarget={{ kind: 'drawer', id: 'drawer' }}
      />
    </MantineProvider>
  );
  await userEvent.click(
    await screen.findByRole('combobox', { name: 'Locate profile' })
  );
  await userEvent.click(
    await screen.findByRole('option', { name: 'locate saved', hidden: true })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Locate' }));
  await waitFor(() => expect(createLocateSession).toHaveBeenCalled());
  expect(createLocateSession.mock.calls[0][0]).toMatchObject({
    profile: 'locate'
  });
  expect(createLocateSession.mock.calls[0][0]).not.toHaveProperty(
    'duration_seconds'
  );
  expect(await screen.findByTestId('effective-profile')).toHaveTextContent(
    'RGB 1, 2, 3; White: 0; Brightness: 42; Duration: 37s'
  );
  await userEvent.click(screen.getByRole('combobox', { name: 'Test profile' }));
  await userEvent.click(
    await screen.findByRole('option', { name: 'test saved', hidden: true })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Run pixel test' }));
  await waitFor(() => expect(pixelTest).toHaveBeenCalled());
  expect(pixelTest.mock.calls[0][0]).toMatchObject({ profile: 'test' });
  expect(await screen.findByTestId('effective-profile')).toHaveTextContent('7');
  fireEvent.click(screen.getByRole('button', { name: 'Reload profiles' }));
  await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(2));
});

it('creates topology with null IDs and reuses server IDs on subsequent saves', async () => {
  const getElectrical = vi.fn().mockResolvedValue({
    data: { cabinet: { revision: 4 }, controllers: [] },
    etag: '"4"'
  });
  const saveElectrical = vi
    .fn()
    .mockImplementation(async (_id: string, document: ElectricalDocument) => ({
      data: {
        cabinet: { revision: 5 },
        controllers: document.controllers.map((controller) => ({
          ...controller,
          id: 'saved-controller',
          outputs: controller.outputs.map((output) => ({
            ...output,
            id: 'saved-output',
            strings: output.strings.map((string) => ({
              ...string,
              id: 'saved-string'
            }))
          }))
        }))
      },
      etag: '"5"'
    }));
  const client = {
    getElectrical,
    saveElectrical
  } as unknown as StorageLayoutClient;
  render(
    <MantineProvider env='test'>
      <TopologyEditor client={client} cabinetId='cab' readOnly={false} />
    </MantineProvider>
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Add controller' })
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add output' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add string' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save topology' }));
  await screen.findByText('Electrical topology saved.');
  expect(saveElectrical.mock.calls[0][1].controllers[0]).toMatchObject({
    id: null,
    outputs: [{ id: null, strings: [{ id: null }] }]
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save topology' }));
  await waitFor(() => expect(saveElectrical).toHaveBeenCalledTimes(2));
  expect(saveElectrical.mock.calls[1][1].controllers[0]).toMatchObject({
    id: 'saved-controller',
    outputs: [{ id: 'saved-output', strings: [{ id: 'saved-string' }] }]
  });
  expect(saveElectrical.mock.calls[1][2]).toBe('"5"');
});

it('notifies the parent only after authoritative topology save', async () => {
  const data = { cabinet: { revision: 4 }, controllers: [] };
  const onSaved = vi.fn();
  const client = {
    getElectrical: vi.fn().mockResolvedValue({ data, etag: '"4"' }),
    saveElectrical: vi.fn().mockResolvedValue({
      data: { ...data, cabinet: { revision: 5 } },
      etag: '"5"'
    })
  } as unknown as StorageLayoutClient;
  render(
    <MantineProvider env='test'>
      <TopologyEditor
        client={client}
        cabinetId='cab'
        readOnly={false}
        onSaved={onSaved}
      />
    </MantineProvider>
  );
  const save = await screen.findByRole('button', { name: 'Save topology' });
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await waitFor(() =>
    expect(onSaved).toHaveBeenCalledWith({
      controllers: [],
      revision: 5,
      etag: '"5"'
    })
  );
  vi.mocked(client.saveElectrical).mockRejectedValueOnce(
    new StorageLayoutApiError('stale', 412, { code: 'stale' })
  );
  fireEvent.click(save);
  expect(
    await screen.findByText(
      'Stale revision: reload before saving the electrical topology.'
    )
  ).toBeInTheDocument();
  expect(onSaved).toHaveBeenCalledTimes(1);
});

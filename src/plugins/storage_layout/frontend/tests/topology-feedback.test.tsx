import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StorageLayoutClient } from '../src/api/client';
import {
  type ControllerInput,
  type ElectricalResponse,
  StorageLayoutApiError
} from '../src/api/types';
import { TopologyEditor } from '../src/components/editor/TopologyEditor';

const savedMessage = 'Electrical topology saved.';
const staleMessage =
  'Stale revision: reload before saving the electrical topology.';
const validationMessage = 'Electrical topology is invalid.';
const validationDetails = [
  {
    path: 'controllers[0].outputs[0].pins',
    message: 'Pin is already assigned.'
  },
  {
    path: 'controllers[0].outputs[0].strings[0].pixel_count',
    message: 'String exceeds output capacity.'
  }
];

function controllers(persisted = false): ControllerInput[] {
  return [
    {
      id: persisted ? 'controller-1' : null,
      name: 'Controller',
      origin: '',
      expected_mac: null,
      firmware_adapter: 'wled-v16.0.1-1d',
      enabled: false,
      commissioning_policy: {},
      outputs: [
        {
          id: persisted ? 'output-1' : null,
          bus_index: 0,
          wled_start: 0,
          pixel_count: 10,
          pins: [16],
          led_type: '',
          colour_order: 'GRB',
          bus_reverse: false,
          skip: 0,
          auto_white_mode: 0,
          max_current_ma: null,
          strings: [
            {
              id: persisted ? 'string-1' : null,
              label: 'S1',
              output_offset: 0,
              pixel_count: 10,
              notes: '',
              archived: false
            }
          ]
        }
      ]
    }
  ];
}

function response(revision = 1, persisted = false) {
  const data: ElectricalResponse = {
    schema_version: 1,
    cabinet: { id: 'cabinet-1', revision },
    controllers: controllers(persisted),
    archive_ids: []
  };
  return { data, etag: `"topology-${revision}"` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup() {
  const getElectrical = vi
    .fn<StorageLayoutClient['getElectrical']>()
    .mockResolvedValue(response());
  const saveElectrical = vi
    .fn<StorageLayoutClient['saveElectrical']>()
    .mockResolvedValue(response(2, true));
  const client = {
    getElectrical,
    saveElectrical
  } as unknown as StorageLayoutClient;
  const onSaved = vi.fn();
  render(
    <MantineProvider env='test'>
      <TopologyEditor
        client={client}
        cabinetId='cabinet-1'
        readOnly={false}
        onSaved={onSaved}
      />
    </MantineProvider>
  );
  await screen.findByDisplayValue('Controller');
  return { getElectrical, saveElectrical, onSaved };
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save topology' }));
}

function expectAlertColor(alert: HTMLElement, color: 'red' | 'green') {
  // Mantine exposes the semantic theme color without relying on generated classes.
  expect(alert.style.getPropertyValue('--alert-color')).toContain(
    `--mantine-color-${color}-`
  );
}

function validationError() {
  return new StorageLayoutApiError(validationMessage, 400, {
    errors: validationDetails
  });
}

describe('TopologyEditor save feedback', () => {
  it('shows successful saves in a green alert and notifies the parent with persisted topology', async () => {
    const { onSaved } = await setup();
    save();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(savedMessage)).toBeVisible();
    expectAlertColor(alert, 'green');
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({
      controllers: controllers(true),
      revision: 2,
      etag: '"topology-2"'
    });
  });

  it('shows the backend summary and every validation path/message in a red alert', async () => {
    const { saveElectrical, onSaved } = await setup();
    const error = validationError();
    saveElectrical.mockRejectedValueOnce(error);
    save();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(validationMessage)).toBeVisible();
    for (const detail of validationDetails) {
      expect(alert).toHaveTextContent(detail.path);
      expect(alert).toHaveTextContent(detail.message);
    }
    expectAlertColor(alert, 'red');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it.each([409, 412])(
    'shows a %i conflict as a red error without reporting success',
    async (status) => {
      const { saveElectrical, onSaved } = await setup();
      saveElectrical.mockRejectedValueOnce(
        new StorageLayoutApiError(
          'Topology conflicts with the current cabinet.',
          status
        )
      );
      save();
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(
        status === 412
          ? staleMessage
          : 'Topology conflicts with the current cabinet.'
      );
      expectAlertColor(alert, 'red');
      expect(screen.queryByText(savedMessage)).not.toBeInTheDocument();
      expect(onSaved).not.toHaveBeenCalled();
    }
  );

  it('preserves returned controller/output/string IDs and advances the ETag on each repeat save', async () => {
    const { saveElectrical, onSaved } = await setup();
    saveElectrical
      .mockResolvedValueOnce(response(2, true))
      .mockResolvedValueOnce(response(3, true))
      .mockResolvedValueOnce(response(4, true));
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saveElectrical).toHaveBeenNthCalledWith(
      1,
      'cabinet-1',
      { schema_version: 1, controllers: controllers(), archive_ids: [] },
      '"topology-1"'
    );
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(saveElectrical).toHaveBeenNthCalledWith(
      2,
      'cabinet-1',
      { schema_version: 1, controllers: controllers(true), archive_ids: [] },
      '"topology-2"'
    );
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3));
    expect(saveElectrical).toHaveBeenNthCalledWith(
      3,
      'cabinet-1',
      { schema_version: 1, controllers: controllers(true), archive_ids: [] },
      '"topology-3"'
    );
  });

  it.each([
    {
      kind: 'validation',
      error: validationError(),
      message: validationMessage
    },
    {
      kind: 'stale revision',
      error: new StorageLayoutApiError('Revision changed.', 412),
      message: staleMessage
    }
  ])(
    'clears $kind feedback immediately on retry, then replaces it with success',
    async ({ error, message }) => {
      const { saveElectrical } = await setup();
      saveElectrical.mockRejectedValueOnce(error);
      save();
      await screen.findByText(message);
      const pending =
        deferred<Awaited<ReturnType<StorageLayoutClient['saveElectrical']>>>();
      saveElectrical.mockReturnValueOnce(pending.promise);
      save();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      await act(async () => {
        pending.resolve(response(2, true));
      });
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(savedMessage);
      expect(alert).not.toHaveTextContent(message);
      expect(alert).not.toHaveTextContent('Pin is already assigned.');
      expectAlertColor(alert, 'green');
    }
  );

  it('clears stale errors on reload and retries with the reloaded topology and ETag', async () => {
    const { getElectrical, saveElectrical, onSaved } = await setup();
    saveElectrical.mockRejectedValueOnce(
      new StorageLayoutApiError('Revision changed.', 412)
    );
    save();
    await screen.findByText(staleMessage);
    const pending =
      deferred<Awaited<ReturnType<StorageLayoutClient['getElectrical']>>>();
    getElectrical.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(screen.queryByText(staleMessage)).not.toBeInTheDocument();
    await act(async () => {
      pending.resolve(response(7, true));
    });
    await screen.findByDisplayValue('Controller');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    saveElectrical.mockResolvedValueOnce(response(8, true));
    save();
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(saveElectrical).toHaveBeenLastCalledWith(
      'cabinet-1',
      { schema_version: 1, controllers: controllers(true), archive_ids: [] },
      '"topology-7"'
    );
    expect(await screen.findByText(savedMessage)).toBeVisible();
  });
});

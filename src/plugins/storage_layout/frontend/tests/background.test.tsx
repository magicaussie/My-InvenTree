import { MantineProvider } from '@mantine/core';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundCanvas } from '../src/components/editor/BackgroundCanvas';

const metadata = {
  x: 0.1,
  y: 0.2,
  width: 0.5,
  height: 0.5,
  opacity: 0.4,
  visible: true,
  locked: true,
  aspect_locked: true
};
function fixture(
  target: 'cabinets' | 'drawers' = 'cabinets',
  targetId = 'one'
) {
  const document = { image_url: 'https://untrusted.invalid/image', metadata };
  const api = {
    get: vi.fn(async (url: string) => ({
      data: url.endsWith('/content/') ? new Blob(['png']) : document,
      headers: { etag: '"3"' }
    })),
    request: vi.fn(async (config: { data: unknown }) => ({
      data: { ...document, metadata: config.data },
      headers: { etag: '"4"' }
    }))
  };
  const props = {
    api: api as unknown as AxiosInstance,
    target,
    targetId,
    rootEtag: '"3"',
    onBackgroundSaved: vi.fn(),
    layoutDirty: false,
    readOnly: false,
    bounds: { width: 200, height: 100 },
    entities: [
      {
        id: 'drawer',
        label: 'Drawer',
        rect: { x: 0, y: 0, width: 30, height: 30 }
      }
    ],
    selection: ['drawer'],
    ariaLabel: 'Canvas',
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onResize: vi.fn(),
    onDraw: vi.fn()
  };
  const element = (patch = {}) => (
    <MantineProvider>
      <BackgroundCanvas {...props} {...patch} />
    </MantineProvider>
  );
  return { api, props, element };
}
async function edit() {
  await waitFor(() =>
    expect(screen.getByLabelText('Edit background image')).toBeEnabled()
  );
  fireEvent.click(screen.getByLabelText('Edit background image'));
}
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:private-reference');
  URL.revokeObjectURL = vi.fn();
});
describe('independent authenticated background canvases', () => {
  it.each(['cabinets', 'drawers'] as const)(
    'renders %s normalized underlays with authenticated blob reads',
    async (target) => {
      const f = fixture(target);
      const view = render(f.element());
      const image = await screen.findByTestId('background-image');
      expect(f.api.get).toHaveBeenCalledWith(
        expect.stringContaining(`/${target}/one/background/content/`),
        { responseType: 'blob' }
      );
      expect(image).toHaveAttribute('href', 'blob:private-reference');
      expect(image).toHaveAttribute('x', '20');
      expect(image).toHaveAttribute('y', '20');
      expect(image).toHaveAttribute('width', '100');
      expect(image).toHaveAttribute('opacity', '0.4');
      expect(image.parentElement).toHaveAttribute('pointer-events', 'none');
      view.rerender(f.element({ bounds: { width: 400, height: 200 } }));
      expect(image).toHaveAttribute('width', '200');
      view.unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith(
        'blob:private-reference'
      );
    }
  );
  it('isolates image keyboard moves and saves full metadata using root CAS without layout writes', async () => {
    const f = fixture();
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.keyDown(screen.getByRole('application'), { key: 'ArrowRight' });
    expect(f.props.onMove).not.toHaveBeenCalled();
    expect(f.props.onDraw).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByLabelText('Background width (canvas fraction)'),
      { target: { value: '0.6' } }
    );
    expect(
      screen.getByLabelText('Background height (canvas fraction)')
    ).toHaveValue('0.6');
    fireEvent.click(screen.getByText('Save background'));
    await waitFor(() =>
      expect(f.props.onBackgroundSaved).toHaveBeenCalledWith('"4"')
    );
    expect(f.api.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'patch',
        headers: { 'If-Match': '"3"' },
        data: expect.objectContaining({ width: 0.6, locked: false })
      })
    );
  });
  it('supports visibility, opacity, fit and reverting an independent image draft', async () => {
    const f = fixture();
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.click(screen.getByText('Fit background'));
    expect(
      screen.getByLabelText('Background width (canvas fraction)')
    ).toHaveValue('0.5');
    expect(
      screen.getByLabelText('Background height (canvas fraction)')
    ).toHaveValue('1');
    fireEvent.click(screen.getByLabelText('Show background'));
    expect(screen.queryByTestId('background-image')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Background opacity'), {
      target: { value: '0.7' }
    });
    fireEvent.click(screen.getByText('Revert background'));
    expect(await screen.findByTestId('background-image')).toHaveAttribute(
      'opacity',
      '0.4'
    );
    expect(f.api.request).not.toHaveBeenCalled();
  });
  it('retains the draft and reports a stale or failed save', async () => {
    const f = fixture();
    f.api.request.mockRejectedValue(new Error('Stale revision'));
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.click(screen.getByText('Save background'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Stale revision'
    );
    expect(screen.getByText('Unsaved background changes')).toBeInTheDocument();
    expect(f.props.onBackgroundSaved).not.toHaveBeenCalled();
  });
  it('blocks image writes while layout is dirty or read-only', async () => {
    const f = fixture();
    const view = render(f.element({ layoutDirty: true }));
    await screen.findByTestId('background-image');
    expect(
      screen.getByRole('button', { name: 'Replace background' })
    ).toBeDisabled();
    view.rerender(f.element({ readOnly: true }));
    expect(screen.getByLabelText('Edit background image')).toBeDisabled();
  });
  it('ignores late content after switching drawer identity', async () => {
    const f = fixture('drawers');
    let resolve: (value: unknown) => void = () => undefined;
    f.api.get.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }) as never
    );
    const view = render(f.element());
    view.rerender(f.element({ targetId: 'two' }));
    await screen.findByTestId('background-image');
    await act(async () =>
      resolve({
        data: { image_url: null, metadata: { ...metadata, x: 9 } },
        headers: { etag: '"1"' }
      })
    );
    expect(screen.getByTestId('background-image')).toHaveAttribute('x', '20');
  });
  it('undo and redo are independent of layout history', async () => {
    const f = fixture();
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo background' }));
    expect(screen.getByLabelText('Lock background')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Redo background' }));
    expect(screen.getByLabelText('Lock background')).not.toBeChecked();
    expect(f.props.onMove).not.toHaveBeenCalled();
  });
  it('failed replacement retains the previous content and failed uploads are explicit', async () => {
    const f = fixture();
    f.api.request.mockRejectedValue(new Error('Upload rejected'));
    const view = render(f.element());
    await screen.findByTestId('background-image');
    const input = view.container.querySelector(
      'input[type=file]'
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(['png'], 'view.png', { type: 'image/png' })] }
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Upload rejected'
    );
    expect(screen.getByTestId('background-image')).toHaveAttribute(
      'href',
      'blob:private-reference'
    );
    expect(f.props.onBackgroundSaved).not.toHaveBeenCalled();
  });
  it('disables image edits while saving and never reloads or overwrites intervening layout edits', async () => {
    const f = fixture();
    let resolve: (value: unknown) => void = () => undefined;
    f.api.request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }) as never
    );
    const view = render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.click(screen.getByText('Save background'));
    expect(screen.getByLabelText('Background opacity')).toBeDisabled();
    view.rerender(f.element({ layoutDirty: true }));
    await act(async () =>
      resolve({
        data: {
          image_url: 'content',
          metadata: { ...metadata, locked: false }
        },
        headers: { etag: '"4"' }
      })
    );
    expect(f.props.onBackgroundSaved).toHaveBeenCalledWith('"4"');
    expect(f.props.onMove).not.toHaveBeenCalled();
    expect(f.api.get).toHaveBeenCalledTimes(2);
  });
});

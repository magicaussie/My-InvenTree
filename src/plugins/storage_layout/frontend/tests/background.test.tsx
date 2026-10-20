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
    fireEvent.click(screen.getByRole('button', { name: 'Save background' }));
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
  it.each(['cabinets', 'drawers'] as const)(
    'preserves the %s background draft and history after a layout save advances root CAS',
    async (target) => {
      const f = fixture(target);
      const view = render(f.element());
      await edit();
      fireEvent.click(screen.getByLabelText('Lock background'));
      view.rerender(f.element({ layoutDirty: true }));
      expect(
        screen.getByRole('button', { name: 'Save background' })
      ).toBeDisabled();
      f.api.get.mockImplementation(async (url: string) => ({
        data: url.endsWith('/content/')
          ? new Blob(['png'])
          : { image_url: 'https://untrusted.invalid/image', metadata },
        headers: { etag: '"4"' }
      }));
      view.rerender(f.element({ rootEtag: '"4"' }));
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save background' })
        ).toBeEnabled()
      );
      expect(screen.getByLabelText('Lock background')).not.toBeChecked();
      expect(
        screen.getByText('Unsaved background changes')
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Undo background' }));
      expect(screen.getByLabelText('Lock background')).toBeChecked();
      fireEvent.click(screen.getByRole('button', { name: 'Redo background' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save background' }));
      await waitFor(() => expect(f.api.request).toHaveBeenCalledOnce());
      expect(f.api.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'patch',
          headers: { 'If-Match': '"4"' },
          data: { ...metadata, locked: false }
        })
      );
    }
  );
  it.each(['metadata', 'replacement', 'revision', 'failed read'])(
    'does not rebase over a background conflict or unverifiable baseline: %s',
    async (conflict) => {
      const f = fixture();
      const view = render(f.element());
      await edit();
      fireEvent.click(screen.getByLabelText('Lock background'));
      view.rerender(f.element({ layoutDirty: true }));
      f.api.get.mockImplementation(async (url: string) => {
        if (conflict === 'failed read') throw new Error('Offline');
        return {
          data: url.endsWith('/content/')
            ? new Blob([conflict === 'replacement' ? 'different png' : 'png'])
            : {
                image_url: 'https://untrusted.invalid/image',
                metadata: {
                  ...metadata,
                  opacity: conflict === 'metadata' ? 0.9 : metadata.opacity
                }
              },
          headers: { etag: conflict === 'revision' ? '"5"' : '"4"' }
        };
      });
      f.api.request.mockRejectedValue(new Error('Stale revision'));
      view.rerender(f.element({ rootEtag: '"4"' }));
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Save background' })
        ).toBeEnabled()
      );
      fireEvent.click(screen.getByRole('button', { name: 'Save background' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Stale revision'
      );
      expect(f.api.request).toHaveBeenCalledWith(
        expect.objectContaining({ headers: { 'If-Match': '"3"' } })
      );
      expect(
        screen.getByText('Unsaved background changes')
      ).toBeInTheDocument();
      expect(f.props.onBackgroundSaved).not.toHaveBeenCalled();
    }
  );
  it('retains the draft and reports a stale or failed save', async () => {
    const f = fixture();
    f.api.request.mockRejectedValue(new Error('Stale revision'));
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.click(screen.getByRole('button', { name: 'Save background' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Save background' }));
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
  it('scopes keyboard history to image editor, excluding numeric inputs', async () => {
    const f = fixture();
    render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(screen.getByLabelText('Background opacity'), {
      key: 'z',
      ctrlKey: true
    });
    expect(screen.getByLabelText('Lock background')).not.toBeChecked();
    fireEvent.keyDown(screen.getByRole('application'), {
      key: 'z',
      ctrlKey: true
    });
    expect(screen.getByLabelText('Lock background')).toBeChecked();
    fireEvent.keyDown(screen.getByRole('application'), {
      key: 'z',
      metaKey: true,
      shiftKey: true
    });
    expect(screen.getByLabelText('Lock background')).not.toBeChecked();
  });
  it('guards SPA/history navigation while dirty and removes guard after revert', async () => {
    const navigation = new EventTarget();
    Object.defineProperty(window, 'navigation', {
      configurable: true,
      value: navigation
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const f = fixture('drawers');
      render(f.element());
      await edit();
      fireEvent.click(screen.getByLabelText('Lock background'));
      const denied = new Event('navigate', { cancelable: true });
      navigation.dispatchEvent(denied);
      expect(denied.defaultPrevented).toBe(true);
      confirm.mockReturnValue(true);
      const allowed = new Event('navigate', { cancelable: true });
      navigation.dispatchEvent(allowed);
      expect(allowed.defaultPrevented).toBe(false);
      fireEvent.click(screen.getByText('Revert background'));
      confirm.mockClear();
      navigation.dispatchEvent(new Event('navigate', { cancelable: true }));
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      confirm.mockRestore();
      Reflect.deleteProperty(window, 'navigation');
    }
  });
  it('distinguishes committed upload from failed preview retrieval', async () => {
    const f = fixture();
    const view = render(f.element());
    await screen.findByTestId('background-image');
    f.api.request.mockResolvedValueOnce({
      data: { image_url: 'saved', metadata },
      headers: { etag: '"4"' }
    } as never);
    f.api.get.mockRejectedValueOnce(new Error('Preview unavailable'));
    fireEvent.change(
      view.container.querySelector('input[type=file]') as HTMLInputElement,
      {
        target: {
          files: [new File(['png'], 'view.png', { type: 'image/png' })]
        }
      }
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Background reference is saved, but its preview could not be loaded'
    );
    expect(f.props.onBackgroundSaved).toHaveBeenCalledWith('"4"');
    expect(
      screen.getByText('Background saved separately from layout')
    ).toBeInTheDocument();
    expect(f.api.request).toHaveBeenCalledTimes(1);
  });
  it('guards fallback links and stops guarding after the editor unmounts', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const f = fixture();
    const view = render(f.element());
    await edit();
    fireEvent.click(screen.getByLabelText('Lock background'));
    const link = document.createElement('a');
    link.href = '/another-drawer';
    document.body.appendChild(link);
    try {
      expect(fireEvent.click(link)).toBe(false);
      expect(confirm).toHaveBeenCalledOnce();
      view.unmount();
      confirm.mockClear();
      // Avoid jsdom's actual navigation while verifying our listener was removed.
      link.addEventListener('click', (event) => event.preventDefault());
      fireEvent.click(link);
      expect(confirm).not.toHaveBeenCalled();
    } finally {
      link.remove();
      confirm.mockRestore();
    }
  });
});

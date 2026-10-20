import type { InvenTreePluginContext } from '@inventreedb/ui';
import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type StructureDocument,
  StructureEditor
} from '../src/components/StructureEditor';

const document: StructureDocument = {
  schema_version: 1,
  units: 'mm',
  view: 'front',
  envelope: { width: 300, height: 400, depth: 200 },
  features: []
};

function context(structure: StructureDocument | null = document) {
  const api = {
    get: vi.fn(async () => ({
      data: { id: 'cabinet-1', revision: 8, structure },
      headers: { etag: '8' }
    })),
    patch: vi.fn(async (_url: string, body: unknown, _config: unknown) => ({
      data: {
        id: 'cabinet-1',
        revision: 9,
        structure: (body as { structure: StructureDocument }).structure
      },
      headers: {}
    }))
  };
  return { api, context: { api } as unknown as InvenTreePluginContext };
}

beforeEach(() => {
  Object.defineProperty(SVGElement.prototype, 'setPointerCapture', {
    configurable: true,
    value: vi.fn()
  });
});

describe('StructureEditor', () => {
  it('clears undo history when switching cabinets', async () => {
    const { context: pluginContext } = context({ ...document, features: [{ id: 'p1', type: 'partition', x: 30, y: 40, width: 10, height: 50 }] });
    const { rerender } = render(<MantineProvider><StructureEditor context={pluginContext} cabinetId='cabinet-1' /></MantineProvider>);
    const feature = await screen.findByTestId('feature-partition');
    fireEvent.pointerDown(feature, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(feature, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Span cabinet height' }));
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();
    rerender(<MantineProvider><StructureEditor context={pluginContext} cabinetId='cabinet-2' /></MantineProvider>);
    await screen.findByTestId('feature-partition');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(screen.getByTestId('feature-partition')).toHaveAttribute('height', '50');
  });
  it('spans a divider without changing thickness and ignores keyboard commands when inactive', async () => {
    const { context: pluginContext } = context({ ...document, features: [{ id: 'p1', type: 'partition', x: 30, y: 40, width: 10, height: 50 }] });
    render(<MantineProvider><StructureEditor context={pluginContext} cabinetId='cabinet-1' active={false} /></MantineProvider>);
    const feature = await screen.findByTestId('feature-partition');
    fireEvent.pointerDown(feature, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(feature, { clientX: 60, clientY: 60, pointerId: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Span cabinet height' }));
    expect(feature).toHaveAttribute('height', '400');
    expect(feature).toHaveAttribute('width', '10');
    expect(feature).toHaveAttribute('y', '0');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(feature).toHaveAttribute('height', '400');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(feature).toHaveAttribute('height', '50');
  });
  it('requires explicit millimetre initialization when legacy structure is null', async () => {
    const { context: pluginContext } = context(null);
    render(
      <MantineProvider>
        <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    expect(await screen.findByText(/not initialized/i)).toBeInTheDocument();
    expect(screen.getByText(/will not be converted/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /initialize structure/i })
    ).toBeEnabled();
    expect(
      screen.queryByRole('img', { name: /cabinet structure drawing/i })
    ).not.toBeInTheDocument();
  });

  it('draws a structural feature by dragging, supports undo/redo and saves by revision CAS', async () => {
    const { context: pluginContext, api } = context();
    render(
      <StrictMode>
        <MantineProvider>
          <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
        </MantineProvider>
      </StrictMode>
    );
    const envelope = await screen.findByTestId('cabinet-envelope');
    fireEvent.click(screen.getByRole('button', { name: 'Partition' }));
    fireEvent.pointerDown(envelope, { clientX: 50, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(envelope, {
      clientX: 130,
      clientY: 110,
      pointerId: 1
    });
    fireEvent.pointerUp(envelope, { clientX: 130, clientY: 110, pointerId: 1 });
    const feature = await screen.findByTestId('feature-partition');
    expect(feature).toHaveAttribute('width', '80');
    expect(feature).toHaveAttribute('height', '70');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() =>
      expect(screen.queryByTestId('feature-partition')).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(await screen.findByTestId('feature-partition')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save structure' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledOnce());
    expect(api.patch.mock.calls[0][1]).toMatchObject({
      structure: {
        units: 'mm',
        features: [expect.objectContaining({ type: 'partition' })]
      }
    });
    expect(api.patch.mock.calls[0][2]).toMatchObject({
      headers: { 'If-Match': '8' }
    });
    expect(
      await screen.findByRole('button', { name: 'Save structure' })
    ).toBeDisabled();
  });

  it('visually resizes the cabinet envelope without changing legacy layout units', async () => {
    const { context: pluginContext } = context();
    render(
      <MantineProvider>
        <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    await screen.findByTestId('cabinet-envelope');
    const handle = screen.getByTestId('cabinet-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 4 });
    fireEvent.pointerMove(handle, { clientX: 140, clientY: 130, pointerId: 4 });
    fireEvent.pointerUp(handle, { clientX: 140, clientY: 130, pointerId: 4 });
    await waitFor(() =>
      expect(screen.getByTestId('cabinet-envelope')).toHaveAttribute(
        'width',
        '340'
      )
    );
    expect(screen.getByTestId('cabinet-envelope')).toHaveAttribute(
      'height',
      '430'
    );
  });

  it('Escape restores the original geometry during a move without adding history', async () => {
    const existing = {
      ...document,
      features: [
        {
          id: 'f1',
          type: 'shelf' as const,
          x: 20,
          y: 30,
          width: 100,
          height: 10
        }
      ]
    };
    const { context: pluginContext } = context(existing);
    render(
      <MantineProvider>
        <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    const feature = await screen.findByTestId('feature-shelf');
    fireEvent.pointerDown(feature, { clientX: 50, clientY: 60, pointerId: 10 });
    fireEvent.pointerMove(feature, { clientX: 90, clientY: 80, pointerId: 10 });
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('x', '60');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('x', '20');
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('y', '30');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

    const current = screen.getByTestId('feature-shelf');
    fireEvent.pointerDown(current, {
      clientX: 100,
      clientY: 100,
      pointerId: 12
    });
    const resize = screen.getByTestId('feature-resize-handle');
    fireEvent.pointerDown(resize, {
      clientX: 100,
      clientY: 100,
      pointerId: 13
    });
    fireEvent.pointerMove(resize, {
      clientX: 140,
      clientY: 130,
      pointerId: 13
    });
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('width', '140');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('width', '100');
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('height', '10');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('rejects overlapping openings and gives invalid numeric geometry feedback', async () => {
    const existing = {
      ...document,
      features: [
        {
          id: 'open-1',
          type: 'opening' as const,
          x: 20,
          y: 20,
          width: 100,
          height: 100
        },
        {
          id: 'open-2',
          type: 'opening' as const,
          x: 80,
          y: 80,
          width: 100,
          height: 100
        }
      ]
    };
    const { context: pluginContext, api } = context(existing);
    render(
      <MantineProvider>
        <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    await screen.findAllByTestId('feature-opening');
    expect(screen.getByText('Openings must not overlap.')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Save structure' })
    ).toBeDisabled();
    fireEvent.pointerDown(screen.getAllByTestId('feature-opening')[0], {
      clientX: 30,
      clientY: 30,
      pointerId: 11
    });
    const xField = screen.getByLabelText('x (mm)');
    fireEvent.change(xField, { target: { value: '-5' } });
    expect(
      await screen.findByText(/coordinates must be nonnegative/i)
    ).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('shows selection resize handles and persists an edited feature geometry', async () => {
    const existing = {
      ...document,
      features: [
        {
          id: 'f1',
          type: 'shelf' as const,
          x: 20,
          y: 30,
          width: 100,
          height: 10
        }
      ]
    };
    const { context: pluginContext } = context(existing);
    render(
      <MantineProvider>
        <StructureEditor context={pluginContext} cabinetId='cabinet-1' />
      </MantineProvider>
    );
    const feature = await screen.findByTestId('feature-shelf');
    fireEvent.pointerDown(feature, { clientX: 50, clientY: 60, pointerId: 2 });
    expect(
      await screen.findByTestId('feature-resize-handle')
    ).toBeInTheDocument();
    expect(screen.getByLabelText('x (mm)')).toHaveValue('20');
    const handle = screen.getByTestId('feature-resize-handle');
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 3 });
    fireEvent.pointerMove(handle, { clientX: 130, clientY: 120, pointerId: 3 });
    fireEvent.pointerUp(handle, { clientX: 130, clientY: 120, pointerId: 3 });
    await waitFor(() =>
      expect(screen.getByTestId('feature-shelf')).toHaveAttribute(
        'width',
        '130'
      )
    );
    expect(screen.getByTestId('feature-shelf')).toHaveAttribute('height', '30');
  });
});

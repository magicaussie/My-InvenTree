/**
 * Regression tests for {@link MappingPanel} candidate invalidation and
 * asynchronous preview/publish races.
 *
 * The panel must never present preview/hash/translation data derived from a
 * candidate that has since been edited, and a preview response (or error) that
 * resolves against an obsolete candidate, cabinet or topology must be
 * discarded. A successful publish stays authoritative but is marked stale once
 * the candidate changes locally. These tests use deferred promises to control
 * completion order deterministically.
 */

import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { StorageLayoutClient } from '../src/api/client';
import {
  type MappingPreviewResponse,
  type MappingPublishResponse,
  StorageLayoutApiError,
  type TranslationSample
} from '../src/api/types';
import { MappingPanel } from '../src/components/editor/MappingPanel';
import type { StringTopology } from '../src/state/mapping';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const topology: StringTopology[] = [
  {
    id: 'string-1',
    label: 'String 1',
    output_offset: 0,
    pixel_count: 10,
    output: {
      id: 'output-1',
      bus_index: 0,
      wled_start: 0,
      pixel_count: 10,
      controller: { id: 'ctrl-1', name: 'Controller 1' }
    }
  }
];

const sample: TranslationSample = {
  logical: 1,
  runs: [
    {
      logical_start: 1,
      logical_end: 10,
      controller: 'ctrl-1',
      output: 'output-1',
      string: 'string-1',
      wled_start: 0,
      wled_stop: 10,
      direction: 1
    }
  ]
};

function previewResponse(
  hash: string,
  samples: TranslationSample[] = [sample]
): MappingPreviewResponse {
  return {
    valid: true,
    errors: [],
    warnings: [],
    unused_ranges: [],
    total_pixels: 10,
    mapping_hash: hash,
    samples,
    drawer_impacts: []
  };
}

function publishResponse(number: number): MappingPublishResponse {
  return {
    id: `revision-${number}`,
    number,
    state: 'published',
    total_pixels: 10,
    mapping_hash: 'published-hash',
    revision: number,
    changed_count: 0,
    changed_pixels: []
  };
}

function setup(props: Partial<ComponentProps<typeof MappingPanel>> = {}) {
  const mappingPreview = vi.fn();
  const mappingPublish = vi.fn();
  const client = {
    mappingPreview,
    mappingPublish
  } as unknown as StorageLayoutClient;
  const onPublished = vi.fn();

  const renderPanel = (
    extra: Partial<ComponentProps<typeof MappingPanel>> = {}
  ) => (
    <MantineProvider>
      <MappingPanel
        client={client}
        cabinetId='cab-1'
        totalPixels={10}
        topology={topology}
        readOnly={false}
        etag='etag-1'
        onPublished={onPublished}
        {...props}
        {...extra}
      />
    </MantineProvider>
  );

  const view = render(renderPanel());
  return { mappingPreview, mappingPublish, onPublished, renderPanel, ...view };
}

function previewButton() {
  return screen.getByRole('button', { name: 'Preview' });
}

function publishButton() {
  return screen.getByRole('button', { name: 'Publish mapping' });
}

function hashInput() {
  return screen.getByLabelText('Mapping hash') as HTMLInputElement;
}

/** The three numeric span inputs of the first row: start, length, offset. */
function spanInputs(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLInputElement>('tbody input[type="text"]')
  );
}

async function settle<T>(d: Deferred<T>, value: T) {
  await act(async () => {
    d.resolve(value);
    await d.promise;
  });
}

async function settleError<T>(d: Deferred<T>, error: unknown) {
  await act(async () => {
    d.reject(error);
    await d.promise.catch(() => undefined);
  });
}

describe('MappingPanel candidate invalidation', () => {
  it('clears the preview hash and samples after a span field edit', async () => {
    const { mappingPreview, container } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-a'));

    expect(hashInput().value).toBe('hash-a');
    expect(screen.getByTestId('translation-sample')).toBeInTheDocument();

    // Edit the string offset (a span field that does not affect coverage).
    const offsetInput = spanInputs(container)[2];
    fireEvent.change(offsetInput, { target: { value: '1' } });

    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
    expect(
      screen.getByText(
        'Run a preview to see sample logical to physical translations.'
      )
    ).toBeInTheDocument();
  });

  it('clears the preview hash and samples after Add span', async () => {
    const { mappingPreview, container } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-a'));

    expect(hashInput().value).toBe('hash-a');
    expect(screen.getByTestId('translation-sample')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add span' }));

    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
  });

  it('clears the preview hash and samples when the total logical pixels change', async () => {
    const { mappingPreview } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-a'));
    expect(hashInput().value).toBe('hash-a');

    fireEvent.change(screen.getByLabelText('Total logical pixels (N)'), {
      target: { value: '20' }
    });

    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
  });

  it('clears the preview hash and samples when the topology changes', async () => {
    const { mappingPreview, renderPanel, rerender } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-a'));
    expect(hashInput().value).toBe('hash-a');

    const nextTopology: StringTopology[] = [
      {
        ...topology[0],
        pixel_count: 20,
        output: { ...topology[0].output, pixel_count: 20 }
      }
    ];
    rerender(renderPanel({ topology: nextTopology }));

    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
  });

  it('clears the preview hash and samples when the cabinet changes', async () => {
    const { mappingPreview, renderPanel, rerender } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-a'));
    expect(hashInput().value).toBe('hash-a');

    rerender(renderPanel({ cabinetId: 'cab-2' }));

    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
  });
});

describe('MappingPanel asynchronous preview races', () => {
  it('discards a preview response that resolves after a candidate edit', async () => {
    const { mappingPreview, container } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    expect(mappingPreview).toHaveBeenCalledTimes(1);

    // Edit while the preview is still pending.
    fireEvent.change(spanInputs(container)[2], { target: { value: '1' } });

    await settle(d, previewResponse('hash-stale'));

    expect(hashInput().value).toBe('');
    expect(screen.queryByTestId('translation-sample')).toBeNull();
  });

  it('discards a preview error that resolves after a candidate edit', async () => {
    const { mappingPreview, container } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    fireEvent.change(spanInputs(container)[2], { target: { value: '1' } });

    await settleError(d, new StorageLayoutApiError('preview failed', 500));

    expect(screen.queryByText('preview failed')).toBeNull();
  });

  it('applies only the latest preview after an intervening edit', async () => {
    const { mappingPreview, container } = setup();
    const first = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(first.promise);

    fireEvent.click(previewButton());
    fireEvent.change(spanInputs(container)[2], { target: { value: '1' } });

    // The obsolete request completes after the candidate changed.
    await settle(first, previewResponse('hash-stale'));
    expect(hashInput().value).toBe('');

    const second = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(second.promise);
    fireEvent.click(previewButton());
    await settle(second, previewResponse('hash-fresh'));

    expect(hashInput().value).toBe('hash-fresh');
    expect(screen.getByTestId('translation-sample')).toBeInTheDocument();
  });
});

describe('MappingPanel publish protection', () => {
  it('shows a successful publish and calls onPublished', async () => {
    const { mappingPublish, onPublished } = setup();
    const d = deferred<MappingPublishResponse>();
    mappingPublish.mockReturnValueOnce(d.promise);

    fireEvent.click(publishButton());
    await settle(d, publishResponse(3));

    expect(screen.getByTestId('publish-result')).toBeInTheDocument();
    expect(screen.queryByTestId('publish-stale')).toBeNull();
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('marks a publish result stale when the candidate is edited while it is in flight', async () => {
    const { mappingPublish, onPublished, container } = setup();
    const d = deferred<MappingPublishResponse>();
    mappingPublish.mockReturnValueOnce(d.promise);

    fireEvent.click(publishButton());
    fireEvent.change(spanInputs(container)[2], { target: { value: '1' } });

    await settle(d, publishResponse(4));

    // The publish still succeeded and is reported, but not as a publication of
    // the newly edited candidate.
    expect(screen.getByTestId('publish-result')).toBeInTheDocument();
    expect(screen.getByTestId('publish-stale')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('does not issue a second publish while one is in flight', async () => {
    const { mappingPublish } = setup();
    const d = deferred<MappingPublishResponse>();
    mappingPublish.mockReturnValueOnce(d.promise);

    fireEvent.click(publishButton());
    fireEvent.click(publishButton());

    expect(mappingPublish).toHaveBeenCalledTimes(1);
    await settle(d, publishResponse(5));
  });
});

describe('MappingPanel duplicate action protection', () => {
  it('does not dispatch a duplicate preview on a double click', async () => {
    const { mappingPreview } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    const button = previewButton();
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mappingPreview).toHaveBeenCalledTimes(1);
    await settle(d, previewResponse('hash-a'));
  });

  it('guards against a synchronous duplicate preview dispatch', async () => {
    const { mappingPreview } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    const button = previewButton();
    act(() => {
      button.click();
      button.click();
    });

    expect(mappingPreview).toHaveBeenCalledTimes(1);
    await settle(d, previewResponse('hash-a'));
  });
});

describe('MappingPanel regression', () => {
  it('shows preview samples and the mapping hash after a valid preview', async () => {
    const { mappingPreview } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settle(d, previewResponse('hash-valid'));

    expect(hashInput().value).toBe('hash-valid');
    expect(screen.getByTestId('translation-sample')).toBeInTheDocument();
    expect(mappingPreview).toHaveBeenCalledWith('cab-1', {
      total_pixels: 10,
      spans: [
        {
          logical_start: 1,
          length: 10,
          string: 'string-1',
          string_offset: 0,
          direction: 1
        }
      ]
    });
  });

  it('shows a preview error message when the request fails without an edit', async () => {
    const { mappingPreview } = setup();
    const d = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(d.promise);

    fireEvent.click(previewButton());
    await settleError(d, new StorageLayoutApiError('preview failed', 500));

    expect(screen.getByText('preview failed')).toBeInTheDocument();
  });

  it('performs no unexpected API or hardware operations', async () => {
    const mappingPreview = vi.fn();
    const mappingPublish = vi.fn();
    const unexpected = vi.fn(() => {
      throw new Error('unexpected API call');
    });
    const client = new Proxy(
      { mappingPreview, mappingPublish } as Record<string, unknown>,
      {
        get(target, prop) {
          if (typeof prop === 'string' && prop in target) {
            return target[prop];
          }
          return unexpected;
        }
      }
    ) as unknown as StorageLayoutClient;

    render(
      <MantineProvider>
        <MappingPanel
          client={client}
          cabinetId='cab-1'
          totalPixels={10}
          topology={topology}
          readOnly={false}
          etag='etag-1'
        />
      </MantineProvider>
    );

    const preview = deferred<MappingPreviewResponse>();
    mappingPreview.mockReturnValueOnce(preview.promise);
    fireEvent.click(previewButton());
    await settle(preview, previewResponse('hash-a'));

    const publish = deferred<MappingPublishResponse>();
    mappingPublish.mockReturnValueOnce(publish.promise);
    fireEvent.click(publishButton());
    await settle(publish, publishResponse(1));

    expect(unexpected).not.toHaveBeenCalled();
  });
});

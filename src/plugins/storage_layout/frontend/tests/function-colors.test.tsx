/**
 * Tests for {@link FunctionColorsPanel}.
 *
 * The panel configures function colours through the product's real schema
 * (locate profiles with a purpose). It must load existing profiles, save edits
 * through the API, create new profiles and honour read-only mode. It performs no
 * hardware I/O.
 */

import { MantineProvider } from '@mantine/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StorageLayoutClient } from '../src/api/client';
import type { LocateProfile } from '../src/api/types';
import { FunctionColorsPanel } from '../src/components/editor/FunctionColorsPanel';

function profile(overrides: Partial<LocateProfile> = {}): LocateProfile {
  return {
    id: 'profile-1',
    cabinet: 'cab-1',
    name: 'Locate green',
    purpose: 'locate',
    rgb: [0, 255, 0],
    white: 0,
    brightness: 64,
    duration_seconds: 120,
    ...overrides
  };
}

function setup(profiles: LocateProfile[] = [profile()], readOnly = false) {
  const listProfiles = vi.fn().mockResolvedValue({
    count: profiles.length,
    next: null,
    previous: null,
    results: profiles
  });
  const createProfile = vi.fn().mockResolvedValue(profile({ id: 'profile-2' }));
  const updateProfile = vi.fn().mockResolvedValue(profile());

  const client = {
    listProfiles,
    createProfile,
    updateProfile
  } as unknown as StorageLayoutClient;

  const view = render(
    <MantineProvider>
      <FunctionColorsPanel
        client={client}
        cabinetId='cab-1'
        readOnly={readOnly}
      />
    </MantineProvider>
  );

  return { listProfiles, createProfile, updateProfile, ...view };
}

describe('FunctionColorsPanel', () => {
  it('loads and displays the cabinet profiles with a colour swatch', async () => {
    const { listProfiles } = setup();

    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith('cab-1'));

    expect(
      await screen.findByTestId('function-colors-table')
    ).toBeInTheDocument();
    const swatch = screen.getByTestId('profile-swatch-profile-1');
    expect(swatch).toHaveStyle({ background: 'rgb(0, 255, 0)' });
  });

  it('shows an empty state when no profiles exist', async () => {
    setup([]);

    expect(
      await screen.findByTestId('function-colors-empty')
    ).toBeInTheDocument();
  });

  it('saves an edited colour through the API', async () => {
    const { updateProfile } = setup();

    const red = await screen.findByLabelText('Red');
    fireEvent.change(red, { target: { value: '10' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateProfile).toHaveBeenCalledTimes(1));
    expect(updateProfile).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ rgb_r: 10, rgb_g: 255, rgb_b: 0 })
    );
  });

  it('creates a new profile for the cabinet', async () => {
    const { createProfile } = setup([]);

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Test blue' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(createProfile).toHaveBeenCalledTimes(1));
    expect(createProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        cabinet: 'cab-1',
        name: 'Test blue',
        purpose: 'locate'
      })
    );
  });

  it('disables editing in read-only mode', async () => {
    setup([profile()], true);

    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    expect(screen.getByLabelText('Red')).toBeDisabled();
  });
});

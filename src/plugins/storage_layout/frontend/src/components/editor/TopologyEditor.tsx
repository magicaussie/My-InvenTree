/**
 * Electrical topology editor.
 *
 * Edits the saved controller -> output -> string topology. Changing the saved
 * desired topology is database-only: it never performs a hardware write
 * (design sections 5 and 9). Unsupported transforms (`bus_reverse`, `skip`,
 * non-identity strings) are preserved and clearly flagged, because they block
 * arming even though they remain valid for simulation.
 */

import { t } from '@lingui/core/macro';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  NumberInput,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip
} from '@mantine/core';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { StorageLayoutClient } from '../../api/client';
import type {
  ControllerInput,
  ElectricalDocument,
  OutputInput,
  StringInput
} from '../../api/types';
import { StorageLayoutApiError } from '../../api/types';

export interface TopologyEditorProps {
  client: StorageLayoutClient;
  cabinetId: string;
  readOnly: boolean;
  layoutDirty?: boolean;
  onSaved?: (result: {
    controllers: ControllerInput[];
    revision: number;
    etag: string;
  }) => void;
}

function emptyString(): StringInput {
  return {
    id: null,
    label: 'S1',
    output_offset: 0,
    pixel_count: 1,
    notes: '',
    archived: false
  };
}

function emptyOutput(): OutputInput {
  return {
    id: null,
    bus_index: 0,
    wled_start: 0,
    pixel_count: 1,
    pins: [],
    led_type: '',
    colour_order: 'GRB',
    bus_reverse: false,
    skip: 0,
    auto_white_mode: 0,
    max_current_ma: null,
    strings: []
  };
}

function emptyController(): ControllerInput {
  return {
    id: null,
    name: 'Controller',
    origin: '',
    expected_mac: null,
    firmware_adapter: 'wled-v16.0.1-1d',
    enabled: false,
    commissioning_policy: {},
    outputs: []
  };
}

function isUnsupported(output: OutputInput): boolean {
  return output.bus_reverse || output.skip > 0;
}

export function TopologyEditor({
  client,
  cabinetId,
  readOnly,
  layoutDirty = false,
  onSaved
}: TopologyEditorProps) {
  const [document, setDocument] = useState<ElectricalDocument>({
    schema_version: 1,
    controllers: [],
    archive_ids: []
  });
  const [revision, setRevision] = useState<number | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [message, setMessage] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    setSaveErrors([]);
    setMessage(null);
    try {
      const result = await client.getElectrical(cabinetId);
      setDocument({
        schema_version: 1,
        controllers: result.data.controllers ?? [],
        archive_ids: []
      });
      setRevision(result.data.cabinet.revision);
      setEtag(result.etag ?? `"${result.data.cabinet.revision}"`);
      setStatus('ready');
    } catch (error) {
      const apiError =
        error instanceof StorageLayoutApiError
          ? error
          : new StorageLayoutApiError(String(error), 0);
      setMessage(apiError.message);
      setStatus('error');
    }
  }, [cabinetId, client]);

  useEffect(() => {
    void load();
  }, [load]);

  const unsupportedCount = useMemo(
    () =>
      document.controllers.reduce(
        (total, controller) =>
          total + controller.outputs.filter(isUnsupported).length,
        0
      ),
    [document]
  );

  const updateController = (index: number, patch: Partial<ControllerInput>) => {
    setDocument((current) => {
      const controllers = [...current.controllers];
      controllers[index] = { ...controllers[index], ...patch };
      return { ...current, controllers };
    });
  };

  const updateOutput = (
    controllerIndex: number,
    outputIndex: number,
    patch: Partial<OutputInput>
  ) => {
    setDocument((current) => {
      const controllers = [...current.controllers];
      const outputs = [...controllers[controllerIndex].outputs];
      outputs[outputIndex] = { ...outputs[outputIndex], ...patch };
      controllers[controllerIndex] = {
        ...controllers[controllerIndex],
        outputs
      };
      return { ...current, controllers };
    });
  };

  const updateString = (
    controllerIndex: number,
    outputIndex: number,
    stringIndex: number,
    patch: Partial<StringInput>
  ) => {
    setDocument((current) => {
      const controllers = [...current.controllers];
      const outputs = [...controllers[controllerIndex].outputs];
      const strings = [...outputs[outputIndex].strings];
      strings[stringIndex] = { ...strings[stringIndex], ...patch };
      outputs[outputIndex] = { ...outputs[outputIndex], strings };
      controllers[controllerIndex] = {
        ...controllers[controllerIndex],
        outputs
      };
      return { ...current, controllers };
    });
  };

  const addController = () =>
    setDocument((current) => ({
      ...current,
      controllers: [...current.controllers, emptyController()]
    }));

  const removeController = (index: number) =>
    setDocument((current) => ({
      ...current,
      controllers: current.controllers.filter((_, i) => i !== index)
    }));

  const addOutput = (controllerIndex: number) =>
    setDocument((current) => {
      const controllers = [...current.controllers];
      const controller = controllers[controllerIndex];
      controllers[controllerIndex] = {
        ...controller,
        outputs: [...controller.outputs, emptyOutput()]
      };
      return { ...current, controllers };
    });

  const addString = (controllerIndex: number, outputIndex: number) =>
    setDocument((current) => {
      const controllers = [...current.controllers];
      const outputs = [...controllers[controllerIndex].outputs];
      outputs[outputIndex] = {
        ...outputs[outputIndex],
        strings: [...outputs[outputIndex].strings, emptyString()]
      };
      controllers[controllerIndex] = {
        ...controllers[controllerIndex],
        outputs
      };
      return { ...current, controllers };
    });

  const save = async () => {
    if (readOnly || layoutDirty) return;
    setSaving(true);
    setMessage(null);
    setSaveErrors([]);
    try {
      const result = await client.saveElectrical(cabinetId, document, etag);
      setDocument({
        schema_version: 1,
        controllers: result.data.controllers ?? [],
        archive_ids: []
      });
      setRevision(result.data.cabinet.revision);
      setEtag(result.etag ?? `"${result.data.cabinet.revision}"`);
      onSaved?.({
        controllers: result.data.controllers ?? [],
        revision: result.data.cabinet.revision,
        etag: result.etag ?? `"${result.data.cabinet.revision}"`
      });
      setSaveErrors([]);
      setMessage(t`Electrical topology saved.`);
    } catch (error) {
      const apiError =
        error instanceof StorageLayoutApiError
          ? error
          : new StorageLayoutApiError(String(error), 0);
      setMessage(
        apiError.isStale
          ? t`Stale revision: reload before saving the electrical topology.`
          : apiError.message
      );
      setSaveErrors(
        apiError.details.map((detail) =>
          [detail.path, detail.message ?? detail.code]
            .filter(Boolean)
            .join(': ')
        ).filter(Boolean)
      );
    } finally {
      setSaving(false);
    }
  };

  if (status === 'loading') {
    return <Text size='sm'>{t`Loading electrical topology…`}</Text>;
  }

  return (
    <Stack gap='sm' data-testid='topology-editor'>
      <Group justify='space-between'>
        <Group gap='xs'>
          <Text fw={600}>{t`Electrical topology`}</Text>
          <Badge variant='light'>{t`revision ${revision ?? '-'}`}</Badge>
          {unsupportedCount > 0 ? (
            <Badge color='red' variant='filled'>
              {t`${unsupportedCount} unsupported output(s)`}
            </Badge>
          ) : null}
        </Group>
        <Group gap='xs'>
          <Button size='xs' variant='default' onClick={() => void load()}>
            {t`Reload`}
          </Button>
          <Button
            size='xs'
            onClick={() => void save()}
            loading={saving}
            disabled={readOnly || layoutDirty}
          >
            {t`Save topology`}
          </Button>
        </Group>
      </Group>

      {layoutDirty ? (
        <Alert color='yellow'>
          {t`Save or discard unsaved layout changes before saving topology.`}
        </Alert>
      ) : null}

      {message ? (
        <Alert
          color={saveErrors.length > 0 || status === 'error' || message !== t`Electrical topology saved.` ? 'red' : 'green'}
          onClose={() => { setMessage(null); setSaveErrors([]); }}
          withCloseButton
          role='alert'
        >
          <Text>{message}</Text>
          {saveErrors.length > 0 ? (
            <Stack gap={4} mt='xs'>
              {saveErrors.map((detail, index) => (
                <Text size='sm' key={`${index}-${detail}`}>{detail}</Text>
              ))}
            </Stack>
          ) : null}
        </Alert>
      ) : null}

      {unsupportedCount > 0 ? (
        <Alert color='red' title={t`Unsupported configuration present`}>
          {t`Outputs with bus reverse or skip cannot be armed for live use. They remain editable for simulation and observation.`}
        </Alert>
      ) : null}

      {document.controllers.map((controller, controllerIndex) => (
        <Card key={controller.id ?? controllerIndex} withBorder padding='sm'>
          <Stack gap='xs'>
            <Group justify='space-between'>
              <Group gap='xs' grow>
                <TextInput
                  size='xs'
                  label={t`Name`}
                  value={controller.name}
                  readOnly={readOnly}
                  onChange={(event) =>
                    updateController(controllerIndex, {
                      name: event.currentTarget.value
                    })
                  }
                />
                <TextInput
                  size='xs'
                  label={t`Origin (scheme://host:port)`}
                  value={controller.origin}
                  readOnly={readOnly}
                  onChange={(event) =>
                    updateController(controllerIndex, {
                      origin: event.currentTarget.value
                    })
                  }
                />
              </Group>
              <ActionIcon
                color='red'
                variant='subtle'
                aria-label={t`Remove controller`}
                disabled={readOnly}
                onClick={() => removeController(controllerIndex)}
              >
                x
              </ActionIcon>
            </Group>

            <Group gap='xs'>
              <TextInput
                size='xs'
                label={t`Expected MAC`}
                value={controller.expected_mac ?? ''}
                readOnly={readOnly}
                onChange={(event) =>
                  updateController(controllerIndex, {
                    expected_mac: event.currentTarget.value || null
                  })
                }
              />
              <TextInput
                size='xs'
                label={t`Firmware adapter`}
                value={controller.firmware_adapter}
                readOnly={readOnly}
                onChange={(event) =>
                  updateController(controllerIndex, {
                    firmware_adapter: event.currentTarget.value
                  })
                }
              />
              <Switch
                size='xs'
                mt='lg'
                label={t`Enabled`}
                checked={controller.enabled}
                disabled={readOnly}
                onChange={(event) =>
                  updateController(controllerIndex, {
                    enabled: event.currentTarget.checked
                  })
                }
              />
            </Group>

            <Divider label={t`Outputs`} labelPosition='center' />

            {controller.outputs.map((output, outputIndex) => (
              <Card key={output.id ?? outputIndex} withBorder padding='xs'>
                <Stack gap='xs'>
                  <Group gap='xs' align='flex-end'>
                    <NumberInput
                      size='xs'
                      w={90}
                      label={t`Bus`}
                      min={0}
                      value={output.bus_index}
                      readOnly={readOnly}
                      onChange={(value) =>
                        updateOutput(controllerIndex, outputIndex, {
                          bus_index: Number(value) || 0
                        })
                      }
                    />
                    <NumberInput
                      size='xs'
                      w={100}
                      label={t`WLED start`}
                      min={0}
                      value={output.wled_start}
                      readOnly={readOnly}
                      onChange={(value) =>
                        updateOutput(controllerIndex, outputIndex, {
                          wled_start: Number(value) || 0
                        })
                      }
                    />
                    <NumberInput
                      size='xs'
                      w={100}
                      label={t`Pixel count`}
                      min={1}
                      value={output.pixel_count}
                      readOnly={readOnly}
                      onChange={(value) =>
                        updateOutput(controllerIndex, outputIndex, {
                          pixel_count: Number(value) || 1
                        })
                      }
                    />
                    <TextInput
                      size='xs'
                      w={110}
                      label={t`Colour order`}
                      value={output.colour_order}
                      readOnly={readOnly}
                      onChange={(event) =>
                        updateOutput(controllerIndex, outputIndex, {
                          colour_order: event.currentTarget.value
                        })
                      }
                    />
                    <Tooltip label={t`GPIO pins, comma separated`}>
                      <TextInput
                        size='xs'
                        w={110}
                        label={t`Pins`}
                        value={output.pins.join(',')}
                        readOnly={readOnly}
                        onChange={(event) =>
                          updateOutput(controllerIndex, outputIndex, {
                            pins: event.currentTarget.value
                              .split(',')
                              .map((value) => Number(value.trim()))
                              .filter((value) => !Number.isNaN(value))
                          })
                        }
                      />
                    </Tooltip>
                  </Group>
                  <Group gap='xs'>
                    <Switch
                      size='xs'
                      label={t`Bus reverse`}
                      checked={output.bus_reverse}
                      disabled={readOnly}
                      onChange={(event) =>
                        updateOutput(controllerIndex, outputIndex, {
                          bus_reverse: event.currentTarget.checked
                        })
                      }
                    />
                    <NumberInput
                      size='xs'
                      w={90}
                      label={t`Skip`}
                      min={0}
                      value={output.skip}
                      readOnly={readOnly}
                      onChange={(value) =>
                        updateOutput(controllerIndex, outputIndex, {
                          skip: Number(value) || 0
                        })
                      }
                    />
                    {isUnsupported(output) ? (
                      <Badge color='red' mt='lg'>
                        {t`Unsupported for live`}
                      </Badge>
                    ) : (
                      <Badge color='green' mt='lg' variant='light'>
                        {t`Supported (1D identity)`}
                      </Badge>
                    )}
                  </Group>

                  <Group gap='xs'>
                    <Text size='xs' fw={600}>
                      {t`Strings`}
                    </Text>
                    <Button
                      size='compact-xs'
                      variant='default'
                      disabled={readOnly}
                      onClick={() => addString(controllerIndex, outputIndex)}
                    >
                      {t`Add string`}
                    </Button>
                  </Group>

                  {output.strings.map((string, stringIndex) => (
                    <Group
                      key={string.id ?? stringIndex}
                      gap='xs'
                      align='flex-end'
                    >
                      <TextInput
                        size='xs'
                        w={90}
                        label={t`Label`}
                        value={string.label}
                        readOnly={readOnly}
                        onChange={(event) =>
                          updateString(
                            controllerIndex,
                            outputIndex,
                            stringIndex,
                            {
                              label: event.currentTarget.value
                            }
                          )
                        }
                      />
                      <NumberInput
                        size='xs'
                        w={110}
                        label={t`Offset`}
                        min={0}
                        value={string.output_offset}
                        readOnly={readOnly}
                        onChange={(value) =>
                          updateString(
                            controllerIndex,
                            outputIndex,
                            stringIndex,
                            {
                              output_offset: Number(value) || 0
                            }
                          )
                        }
                      />
                      <NumberInput
                        size='xs'
                        w={110}
                        label={t`Pixels`}
                        min={1}
                        value={string.pixel_count}
                        readOnly={readOnly}
                        onChange={(value) =>
                          updateString(
                            controllerIndex,
                            outputIndex,
                            stringIndex,
                            {
                              pixel_count: Number(value) || 1
                            }
                          )
                        }
                      />
                    </Group>
                  ))}
                </Stack>
              </Card>
            ))}

            <Button
              size='xs'
              variant='default'
              disabled={readOnly}
              onClick={() => addOutput(controllerIndex)}
            >
              {t`Add output`}
            </Button>
          </Stack>
        </Card>
      ))}

      <Button
        size='xs'
        variant='default'
        disabled={readOnly}
        onClick={addController}
      >
        {t`Add controller`}
      </Button>
    </Stack>
  );
}

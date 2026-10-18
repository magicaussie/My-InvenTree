/**
 * SVG overlay and diagnostic panels shared by both designers.
 *
 * - {@link AllocationBands} draws each drawer's logical allocation band,
 *   including LED count and controller/string boundaries.
 * - {@link CoverageRuler} draws the full `1..N` logical ruler, marking unused
 *   ("allocated-capable but unlit") portions.
 * - {@link ValidationPanel} renders the blocking error list and warnings with
 *   non-colour-only indicators and links back to the affected geometry.
 */

import { t } from '@lingui/core/macro';
import {
  Alert,
  Badge,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  UnstyledButton
} from '@mantine/core';

import type {
  Diagnostic,
  UnusedRange,
  ValidationReport
} from '../../api/types';
import type { Rect } from '../../state/geometry';
import { formatRange, rangeCount } from '../../utils';

export interface BandSegment {
  logical_start: number;
  logical_end: number;
  colour: string;
  controller?: string;
  string?: string;
}

export interface AllocationRegion {
  id: string;
  rect: Rect;
  logicalStart: number;
  logicalEnd: number;
  segments?: BandSegment[];
}

export interface AllocationBandsProps {
  regions: AllocationRegion[];
  totalPixels: number;
}

const BAND_HEIGHT = 6;
const BAND_GAP = 2;

/**
 * Map an inclusive logical LED range onto the drawer's inner band width.
 *
 * The drawer allocation length (`rangeCount(region.logicalStart,
 * region.logicalEnd)`) is the single denominator for both the offset and the
 * width, so segments fill their correct proportional positions inside the
 * drawer band. The cabinet-wide `totalPixels` is deliberately not used here:
 * a drawer covering only part of the cabinet would otherwise be scaled as if
 * it spanned the whole cabinet.
 *
 * Returns `null` for malformed input (non-positive region length, non-positive
 * inner width, or a non-finite/negative result) so the SVG never receives
 * NaN, Infinity or negative widths. Valid data is returned exactly, with no
 * minimum-width clamp, so adjacent segments meet without gaps or overlaps.
 */
function segmentGeometry(
  region: AllocationRegion,
  segment: BandSegment,
  innerWidth: number
): { offset: number; width: number } | null {
  const regionCount = rangeCount(region.logicalStart, region.logicalEnd);
  if (regionCount <= 0 || !Number.isFinite(innerWidth) || innerWidth <= 0) {
    return null;
  }
  const unit = innerWidth / regionCount;
  const offset = (segment.logical_start - region.logicalStart) * unit;
  const width = rangeCount(segment.logical_start, segment.logical_end) * unit;
  if (!Number.isFinite(offset) || !Number.isFinite(width) || width < 0) {
    return null;
  }
  return { offset, width };
}

// `totalPixels` remains part of the public props for API compatibility, but is
// intentionally unused: each segment is scaled to its own drawer allocation
// (`region.logicalStart..region.logicalEnd`), not the cabinet-wide pixel count.
export function AllocationBands({ regions }: AllocationBandsProps) {
  return (
    <g data-testid='allocation-bands'>
      {regions.map((region) => {
        const bandY =
          region.rect.y + region.rect.height - BAND_HEIGHT - BAND_GAP;
        const innerWidth = region.rect.width - BAND_GAP * 2;
        const count = rangeCount(region.logicalStart, region.logicalEnd);

        return (
          <g key={region.id}>
            <rect
              x={region.rect.x + BAND_GAP}
              y={bandY}
              width={innerWidth}
              height={BAND_HEIGHT}
              fill='var(--mantine-color-gray-4)'
            />
            {region.segments && region.segments.length > 0 ? (
              region.segments.map((segment) => {
                const geometry = segmentGeometry(region, segment, innerWidth);
                if (!geometry) return null;
                return (
                  <rect
                    key={`${region.id}-${segment.logical_start}`}
                    x={region.rect.x + BAND_GAP + geometry.offset}
                    y={bandY}
                    width={geometry.width}
                    height={BAND_HEIGHT}
                    fill={segment.colour}
                  />
                );
              })
            ) : (
              <rect
                x={region.rect.x + BAND_GAP}
                y={bandY}
                width={innerWidth}
                height={BAND_HEIGHT}
                fill='var(--mantine-color-green-6)'
              />
            )}
            <text
              x={region.rect.x + BAND_GAP}
              y={region.rect.y + region.rect.height - BAND_HEIGHT - 4}
              fontSize={9}
              fill='var(--mantine-color-dimmed)'
            >
              L{formatRange(region.logicalStart, region.logicalEnd)} ({count})
            </text>
          </g>
        );
      })}
    </g>
  );
}

export interface CoverageRulerProps {
  totalPixels: number;
  width: number;
  y: number;
  unused: UnusedRange[];
  segments?: {
    logical_start: number;
    logical_end: number;
    colour: string;
    label?: string;
  }[];
}

export function CoverageRuler({
  totalPixels,
  width,
  y,
  unused,
  segments
}: CoverageRulerProps) {
  if (totalPixels < 1) return null;
  const unit = width / totalPixels;

  return (
    <g data-testid='coverage-ruler'>
      <defs>
        <pattern
          id='unused-hatch'
          width='4'
          height='4'
          patternUnits='userSpaceOnUse'
          patternTransform='rotate(45)'
        >
          <rect width='2' height='4' fill='var(--mantine-color-orange-2)' />
        </pattern>
      </defs>
      <rect
        x={0}
        y={y}
        width={width}
        height={8}
        fill='var(--mantine-color-gray-3)'
        stroke='var(--mantine-color-gray-6)'
      />
      {segments?.map((segment) => (
        <rect
          key={`seg-${segment.logical_start}`}
          x={(segment.logical_start - 1) * unit}
          y={y}
          width={Math.max(
            1,
            rangeCount(segment.logical_start, segment.logical_end) * unit
          )}
          height={8}
          fill={segment.colour}
        >
          <title>{segment.label ?? ''}</title>
        </rect>
      ))}
      {unused.map((range) => (
        <rect
          key={`unused-${range.logical_start}`}
          x={(range.logical_start - 1) * unit}
          y={y}
          width={Math.max(
            1,
            rangeCount(range.logical_start, range.logical_end) * unit
          )}
          height={8}
          fill='url(#unused-hatch)'
          stroke='var(--mantine-color-orange-7)'
          strokeDasharray='2 2'
        >
          <title>{t`Unlit ${formatRange(range.logical_start, range.logical_end)}`}</title>
        </rect>
      ))}
      <text x={0} y={y - 3} fontSize={9} fill='var(--mantine-color-dimmed)'>
        {t`LED 1`}
      </text>
      <text
        x={width}
        y={y - 3}
        fontSize={9}
        textAnchor='end'
        fill='var(--mantine-color-dimmed)'
      >
        {t`LED ${totalPixels}`}
      </text>
    </g>
  );
}

export interface ValidationPanelProps {
  report: ValidationReport;
  onSelectEntity?: (ids: string[]) => void;
}

function DiagnosticRow({
  diagnostic,
  onSelect
}: {
  diagnostic: Diagnostic;
  onSelect?: (ids: string[]) => void;
}) {
  const ids = diagnostic.related_ids ?? [];
  const clickable = ids.length > 0 && onSelect;

  return (
    <UnstyledButton
      aria-label={t`${diagnostic.severity}: ${diagnostic.message}`}
      onClick={() => clickable && onSelect(ids)}
      style={{
        width: '100%',
        textAlign: 'left',
        cursor: clickable ? 'pointer' : 'default'
      }}
    >
      <Group gap='xs' wrap='nowrap' align='flex-start'>
        <Badge
          size='xs'
          color={diagnostic.severity === 'error' ? 'red' : 'yellow'}
          variant='filled'
        >
          {diagnostic.severity === 'error' ? t`Error` : t`Warn`}
        </Badge>
        <Stack gap={0}>
          <Text size='sm'>{diagnostic.message}</Text>
          <Text size='xs' c='dimmed'>
            {diagnostic.code}
          </Text>
        </Stack>
      </Group>
    </UnstyledButton>
  );
}

export function ValidationPanel({
  report,
  onSelectEntity
}: ValidationPanelProps) {
  const hasErrors = report.errors.length > 0;

  return (
    <Stack gap='xs'>
      <Group gap='xs'>
        <Badge color={hasErrors ? 'red' : 'green'} variant='light'>
          {t`${report.errors.length} errors`}
        </Badge>
        <Badge color='yellow' variant='light'>
          {t`${report.warnings.length} warnings`}
        </Badge>
      </Group>

      {hasErrors ? (
        <Alert color='red' title={t`Layout cannot be saved`}>
          {t`Resolve the blocking errors below before saving.`}
        </Alert>
      ) : (
        <Alert color='green' title={t`Layout is valid`}>
          {t`No blocking errors. Warnings do not prevent saving.`}
        </Alert>
      )}

      <ScrollArea h={220} type='auto'>
        <Stack gap='xs' data-testid='diagnostics-list'>
          {report.errors.map((diagnostic) => (
            <Paper
              key={`err-${diagnostic.code}-${diagnostic.message}`}
              p={4}
              withBorder
            >
              <DiagnosticRow
                diagnostic={diagnostic}
                onSelect={onSelectEntity}
              />
            </Paper>
          ))}
          {report.warnings.map((diagnostic) => (
            <Paper
              key={`warn-${diagnostic.code}-${diagnostic.message}`}
              p={4}
              withBorder
            >
              <DiagnosticRow
                diagnostic={diagnostic}
                onSelect={onSelectEntity}
              />
            </Paper>
          ))}
        </Stack>
      </ScrollArea>
    </Stack>
  );
}

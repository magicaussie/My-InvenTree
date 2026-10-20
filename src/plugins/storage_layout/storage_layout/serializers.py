"""DRF serializers for the Storage Layout & WLED REST API.

The serializers fall into three groups:

- **Read serializers** for the plugin models (cabinets, drawers, bins,
  controllers, outputs, strings, mappings, profiles, sessions and jobs).
- **Aggregate document serializers** for the atomic layout and electrical
  writes. These validate shape only; the authoritative cross-row validation
  lives in :mod:`storage_layout.validation` and is invoked by the services.
- **Action serializers** for the controller-network and session endpoints.

All controller-network actions are POST requests; read-only GETs never have
side effects.
"""

from __future__ import annotations

import math

from rest_framework import serializers

from storage_layout.models import (
    Bin,
    Cabinet,
    ConfigObservation,
    Controller,
    ControllerExecution,
    ControllerOutput,
    Drawer,
    DrawerAllocation,
    HardwareReadJob,
    LEDString,
    LocateMode,
    LocateProfile,
    LocatePurpose,
    LocateSession,
    MappingRevision,
    PixelSpan,
    TargetKind,
)

# region read serializers


class NativeBindingSerializer(serializers.Serializer):
    """Read-only native location binding and inherited locate eligibility."""

    location = serializers.IntegerField(read_only=True)
    bound = serializers.BooleanField(read_only=True)
    role = serializers.CharField(read_only=True, allow_null=True)
    cabinet = serializers.DictField(read_only=True, allow_null=True)
    drawer = serializers.DictField(read_only=True, allow_null=True)
    bin = serializers.DictField(read_only=True, allow_null=True)
    locatable = serializers.BooleanField(read_only=True)
    reason = serializers.CharField(read_only=True, allow_blank=True)


class CabinetSerializer(serializers.ModelSerializer):
    """Read serializer for a cabinet."""

    class Meta:
        """Metaclass options."""

        model = Cabinet
        fields = [
            'id',
            'name',
            'slug',
            'location',
            'width_units',
            'height_units',
            'structure',
            'revision',
            'archived',
            'active_mapping',
            'default_profile',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'revision', 'created_at', 'updated_at']


class DrawerAllocationSerializer(serializers.ModelSerializer):
    """Read serializer for a drawer allocation."""

    pixel_count = serializers.IntegerField(read_only=True)

    class Meta:
        """Metaclass options."""

        model = DrawerAllocation
        fields = ['id', 'drawer', 'logical_start', 'logical_end', 'pixel_count']


class DrawerSerializer(serializers.ModelSerializer):
    """Read serializer for a drawer."""

    allocation = DrawerAllocationSerializer(read_only=True)

    class Meta:
        """Metaclass options."""

        model = Drawer
        fields = [
            'id',
            'cabinet',
            'label',
            'display_number',
            'location',
            'x',
            'y',
            'width',
            'height',
            'interior_width',
            'interior_height',
            'archived',
            'allocation',
        ]


class BinSerializer(serializers.ModelSerializer):
    """Read serializer for a bin."""

    class Meta:
        """Metaclass options."""

        model = Bin
        fields = [
            'id',
            'drawer',
            'label',
            'location',
            'x',
            'y',
            'width',
            'height',
            'archived',
        ]


class ControllerOutputSerializer(serializers.ModelSerializer):
    """Read serializer for a controller output."""

    wled_end = serializers.IntegerField(read_only=True)

    class Meta:
        """Metaclass options."""

        model = ControllerOutput
        fields = [
            'id',
            'controller',
            'bus_index',
            'wled_start',
            'wled_end',
            'pixel_count',
            'pins',
            'led_type',
            'colour_order',
            'bus_reverse',
            'skip',
            'auto_white_mode',
            'max_current_ma',
        ]


class LEDStringSerializer(serializers.ModelSerializer):
    """Read serializer for an LED string."""

    output_end = serializers.IntegerField(read_only=True)

    class Meta:
        """Metaclass options."""

        model = LEDString
        fields = [
            'id',
            'output',
            'label',
            'output_offset',
            'output_end',
            'pixel_count',
            'notes',
            'archived',
        ]


class ControllerSerializer(serializers.ModelSerializer):
    """Read serializer for a controller."""

    outputs = ControllerOutputSerializer(many=True, read_only=True)

    class Meta:
        """Metaclass options."""

        model = Controller
        fields = [
            'id',
            'cabinet',
            'name',
            'origin',
            'expected_mac',
            'firmware_adapter',
            'enabled',
            'approved_snapshot',
            'desired_revision',
            'status',
            'last_seen',
            'armed_until',
            'armed_by',
            'armed_mapping_hash',
            'armed_config_hash',
            'commissioning_policy',
            'outputs',
        ]


class PixelSpanSerializer(serializers.ModelSerializer):
    """Read serializer for a pixel span."""

    logical_end = serializers.IntegerField(read_only=True)

    class Meta:
        """Metaclass options."""

        model = PixelSpan
        fields = [
            'id',
            'mapping_revision',
            'string',
            'logical_start',
            'logical_end',
            'length',
            'string_offset',
            'direction',
        ]


class MappingRevisionSerializer(serializers.ModelSerializer):
    """Read serializer for a mapping revision."""

    spans = PixelSpanSerializer(many=True, read_only=True)

    class Meta:
        """Metaclass options."""

        model = MappingRevision
        fields = [
            'id',
            'cabinet',
            'number',
            'state',
            'total_pixels',
            'content_hash',
            'source_revision',
            'manifest',
            'spans',
            'created_at',
        ]


class LocateProfileSerializer(serializers.ModelSerializer):
    """Read serializer for a locate profile."""

    rgb = serializers.ListField(child=serializers.IntegerField(), read_only=True)

    class Meta:
        """Metaclass options."""

        model = LocateProfile
        fields = [
            'id',
            'cabinet',
            'name',
            'purpose',
            'rgb',
            'white',
            'brightness',
            'duration_seconds',
        ]


class ConfigObservationSerializer(serializers.ModelSerializer):
    """Read serializer for a configuration observation."""

    class Meta:
        """Metaclass options."""

        model = ConfigObservation
        fields = [
            'id',
            'controller',
            'observed_at',
            'adapter_version',
            'info',
            'normalised_config',
            'fingerprint',
            'capability_status',
            'diff',
            'observed_by',
        ]


class ControllerExecutionSerializer(serializers.ModelSerializer):
    """Read serializer for a per-controller execution record."""

    class Meta:
        """Metaclass options."""

        model = ControllerExecution
        fields = [
            'id',
            'controller',
            'generation',
            'state',
            'last_step',
            'acknowledged_at',
            'clear_status',
            'error',
        ]


class LocateSessionSerializer(serializers.ModelSerializer):
    """Read serializer for a locate session."""

    executions = ControllerExecutionSerializer(many=True, read_only=True)

    class Meta:
        """Metaclass options."""

        model = LocateSession
        fields = [
            'id',
            'cabinet',
            'actor',
            'target_kind',
            'target_label',
            'target_pk',
            'mode',
            'mapping_hash',
            'layout_revision',
            'profile_snapshot',
            'idempotency_key',
            'state',
            'expires_at',
            'plan',
            'failure',
            'executions',
            'created_at',
        ]


class HardwareReadJobSerializer(serializers.ModelSerializer):
    """Read serializer for a durable hardware read job."""

    class Meta:
        """Metaclass options."""

        model = HardwareReadJob
        fields = [
            'id',
            'cabinet',
            'actor',
            'kind',
            'controller',
            'mode',
            'scope_snapshot',
            'q_task_id',
            'state',
            'result',
            'error',
            'expires_at',
            'created_at',
        ]


class ErrorSerializer(serializers.Serializer):
    """Documented API error shape."""

    code = serializers.CharField()
    message = serializers.CharField()
    errors = serializers.ListField(child=serializers.DictField(), required=False)
    warnings = serializers.ListField(child=serializers.DictField(), required=False)
    correlation_id = serializers.CharField(required=False)


# endregion

# region cabinet write serializers


class CabinetCreateSerializer(serializers.Serializer):
    """Create a cabinet root."""

    name = serializers.CharField(max_length=100)
    slug = serializers.SlugField(max_length=100)
    location = serializers.IntegerField(required=False, allow_null=True)
    root_location_name = serializers.CharField(
        max_length=100, required=False, allow_blank=False, trim_whitespace=True
    )
    width_units = serializers.IntegerField(min_value=1)
    height_units = serializers.IntegerField(min_value=1)

    def validate(self, attrs):
        """Require exactly one existing root binding or root name to create."""
        has_location = attrs.get('location') is not None
        has_name = bool(attrs.get('root_location_name'))

        if has_location == has_name:
            raise serializers.ValidationError(
                'Provide exactly one of location or root_location_name.'
            )

        return attrs


class CabinetUpdateSerializer(serializers.Serializer):
    """Update a cabinet root."""

    name = serializers.CharField(max_length=100, required=False)
    width_units = serializers.IntegerField(min_value=1, required=False)
    height_units = serializers.IntegerField(min_value=1, required=False)
    archived = serializers.BooleanField(required=False)
    default_profile = serializers.UUIDField(required=False, allow_null=True)
    structure = serializers.JSONField(required=False, allow_null=True)

    def validate_structure(self, value):
        """Validate explicit physical cabinet geometry without logical-unit inference."""
        if value is None:
            return value
        if not isinstance(value, dict) or set(value) != {
            'schema_version',
            'units',
            'view',
            'envelope',
            'features',
        }:
            raise serializers.ValidationError('Expected the complete structure schema.')
        if value['schema_version'] != 1 or isinstance(value['schema_version'], bool):
            raise serializers.ValidationError('schema_version must be 1.')
        if value['units'] != 'mm' or value['view'] != 'front':
            raise serializers.ValidationError(
                "units must be 'mm' and view must be 'front'."
            )
        envelope = value['envelope']
        if not isinstance(envelope, dict) or set(envelope) != {
            'width',
            'height',
            'depth',
        }:
            raise serializers.ValidationError(
                'envelope must contain width, height, and depth.'
            )

        def positive_number(number):
            return (
                isinstance(number, (int, float))
                and not isinstance(number, bool)
                and math.isfinite(number)
                and number > 0
            )

        if not all(
            positive_number(envelope[key]) for key in ('width', 'height', 'depth')
        ):
            raise serializers.ValidationError(
                'Envelope dimensions must be positive finite numbers.'
            )
        features = value['features']
        if not isinstance(features, list):
            raise serializers.ValidationError('features must be a list.')
        seen = set()
        openings = []
        allowed = {'partition', 'shelf', 'opening', 'door', 'panel'}
        for index, feature in enumerate(features):
            if not isinstance(feature, dict) or set(feature) != {
                'id',
                'type',
                'x',
                'y',
                'width',
                'height',
            }:
                raise serializers.ValidationError({
                    index: 'Feature has an invalid shape.'
                })
            fid = feature['id']
            if not isinstance(fid, str) or not fid.strip() or fid in seen:
                raise serializers.ValidationError({
                    index: 'Feature IDs must be non-empty and unique.'
                })
            seen.add(fid)
            if not isinstance(feature['type'], str) or feature['type'] not in allowed:
                raise serializers.ValidationError({index: 'Unsupported feature type.'})
            if not all(
                isinstance(feature[key], (int, float))
                and not isinstance(feature[key], bool)
                and math.isfinite(feature[key])
                for key in ('x', 'y', 'width', 'height')
            ):
                raise serializers.ValidationError({
                    index: 'Feature geometry must be finite numbers.'
                })
            x, y, width, height = (
                feature[key] for key in ('x', 'y', 'width', 'height')
            )
            if x < 0 or y < 0 or width <= 0 or height <= 0:
                raise serializers.ValidationError({
                    index: 'Coordinates must be nonnegative and dimensions positive.'
                })
            if x + width > envelope['width'] or y + height > envelope['height']:
                raise serializers.ValidationError({
                    index: 'Feature lies outside the cabinet envelope.'
                })
            if feature['type'] == 'opening':
                for ox, oy, ow, oh in openings:
                    if (
                        x < ox + ow
                        and ox < x + width
                        and y < oy + oh
                        and oy < y + height
                    ):
                        raise serializers.ValidationError({
                            index: 'Openings must not overlap.'
                        })
                openings.append((x, y, width, height))
        return value


# endregion

# region layout document serializers


class AllocationInputSerializer(serializers.Serializer):
    """Inclusive logical allocation for a drawer."""

    logical_start = serializers.IntegerField(min_value=1)
    logical_end = serializers.IntegerField(min_value=1)


class DrawerInputSerializer(serializers.Serializer):
    """A drawer row in a layout document."""

    id = serializers.UUIDField(required=False, allow_null=True)
    is_new = serializers.BooleanField(required=False, default=False)
    label = serializers.CharField(max_length=64)
    display_number = serializers.IntegerField(min_value=1)
    location = serializers.IntegerField(required=False, allow_null=True)
    auto_create_location = serializers.BooleanField(required=False, default=False)
    x = serializers.IntegerField(min_value=0, default=0)
    y = serializers.IntegerField(min_value=0, default=0)
    width = serializers.IntegerField(min_value=1)
    height = serializers.IntegerField(min_value=1)
    interior_width = serializers.IntegerField(min_value=1)
    interior_height = serializers.IntegerField(min_value=1)
    archived = serializers.BooleanField(default=False)
    allocation = AllocationInputSerializer(required=False, allow_null=True)


class BinInputSerializer(serializers.Serializer):
    """A bin row in a layout document."""

    id = serializers.UUIDField(required=False, allow_null=True)
    is_new = serializers.BooleanField(required=False, default=False)
    drawer = serializers.CharField()
    label = serializers.CharField(max_length=64)
    location = serializers.IntegerField(required=False, allow_null=True)
    auto_create_location = serializers.BooleanField(required=False, default=False)
    x = serializers.IntegerField(min_value=0, default=0)
    y = serializers.IntegerField(min_value=0, default=0)
    width = serializers.IntegerField(min_value=1)
    height = serializers.IntegerField(min_value=1)
    archived = serializers.BooleanField(default=False)


class CabinetBlockSerializer(serializers.Serializer):
    """Cabinet dimensions within a layout document."""

    width_units = serializers.IntegerField(min_value=1, required=False)
    height_units = serializers.IntegerField(min_value=1, required=False)


class LayoutDocumentSerializer(serializers.Serializer):
    """A complete cabinet layout document."""

    schema_version = serializers.IntegerField(default=1)
    cabinet = CabinetBlockSerializer(required=False)
    drawers = DrawerInputSerializer(many=True, required=False)
    bins = BinInputSerializer(many=True, required=False)
    archive_ids = serializers.ListField(child=serializers.CharField(), required=False)


class DrawerLayoutDocumentSerializer(serializers.Serializer):
    """A drawer-focused layout document."""

    schema_version = serializers.IntegerField(default=1)
    drawer = DrawerInputSerializer()
    bins = BinInputSerializer(many=True, required=False)
    archive_ids = serializers.ListField(child=serializers.CharField(), required=False)


# endregion

# region electrical document serializers


class StringInputSerializer(serializers.Serializer):
    """An LED string row in an electrical document."""

    id = serializers.UUIDField(required=False, allow_null=True)
    label = serializers.CharField(max_length=64)
    output_offset = serializers.IntegerField(min_value=0, default=0)
    pixel_count = serializers.IntegerField(min_value=1)
    notes = serializers.CharField(required=False, allow_blank=True, default='')
    archived = serializers.BooleanField(default=False)


class OutputInputSerializer(serializers.Serializer):
    """A controller output row in an electrical document."""

    id = serializers.UUIDField(required=False, allow_null=True)
    bus_index = serializers.IntegerField(min_value=0, default=0)
    wled_start = serializers.IntegerField(min_value=0, default=0)
    pixel_count = serializers.IntegerField(min_value=1)
    pins = serializers.ListField(
        child=serializers.IntegerField(), required=False, default=list
    )
    led_type = serializers.CharField(required=False, allow_blank=True, default='')
    colour_order = serializers.CharField(
        required=False, allow_blank=True, default='GRB'
    )
    bus_reverse = serializers.BooleanField(default=False)
    skip = serializers.IntegerField(min_value=0, default=0)
    auto_white_mode = serializers.IntegerField(min_value=0, default=0)
    max_current_ma = serializers.IntegerField(required=False, allow_null=True)
    strings = StringInputSerializer(many=True, required=False)


class ControllerInputSerializer(serializers.Serializer):
    """A controller row in an electrical document."""

    id = serializers.UUIDField(required=False, allow_null=True)
    name = serializers.CharField(max_length=100)
    origin = serializers.CharField(max_length=255)
    expected_mac = serializers.CharField(
        required=False, allow_null=True, allow_blank=True, max_length=17
    )
    firmware_adapter = serializers.CharField(required=False, default='wled-v16.0.1-1d')
    enabled = serializers.BooleanField(default=False)
    commissioning_policy = serializers.DictField(required=False, default=dict)
    outputs = OutputInputSerializer(many=True, required=False)


class ElectricalDocumentSerializer(serializers.Serializer):
    """A complete electrical topology document."""

    schema_version = serializers.IntegerField(default=1)
    controllers = ControllerInputSerializer(many=True, required=False)
    archive_ids = serializers.ListField(child=serializers.CharField(), required=False)


# endregion

# region mapping serializers


class SpanInputSerializer(serializers.Serializer):
    """A candidate pixel span."""

    logical_start = serializers.IntegerField(min_value=1)
    length = serializers.IntegerField(min_value=1)
    string = serializers.UUIDField()
    string_offset = serializers.IntegerField(min_value=0, default=0)
    direction = serializers.ChoiceField(choices=[1, -1], default=1)


class MappingCandidateSerializer(serializers.Serializer):
    """A candidate mapping document."""

    total_pixels = serializers.IntegerField(min_value=1)
    spans = SpanInputSerializer(many=True)


class ReplacementAllocationSerializer(serializers.Serializer):
    """An explicit replacement drawer allocation."""

    drawer = serializers.UUIDField()
    logical_start = serializers.IntegerField(min_value=1)
    logical_end = serializers.IntegerField(min_value=1)


class MappingPublishSerializer(MappingCandidateSerializer):
    """A mapping publish request."""

    expected_fingerprints = serializers.DictField(
        child=serializers.CharField(), required=False
    )
    replacement_allocations = ReplacementAllocationSerializer(many=True, required=False)


class TranslateRequestSerializer(serializers.Serializer):
    """A logical to physical translation request."""

    cabinet = serializers.UUIDField()
    logical_start = serializers.IntegerField(min_value=1)
    logical_end = serializers.IntegerField(min_value=1)
    mapping_hash = serializers.CharField(required=False, allow_blank=True, default='')


# endregion

# region session / hardware action serializers


class TargetSerializer(serializers.Serializer):
    """A locate target reference."""

    kind = serializers.ChoiceField(choices=TargetKind.choices)
    id = serializers.CharField()


class LocateSessionCreateSerializer(serializers.Serializer):
    """Create a locate session."""

    cabinet = serializers.UUIDField()
    target = TargetSerializer()
    profile = serializers.UUIDField(required=False, allow_null=True)
    mode = serializers.ChoiceField(
        choices=LocateMode.choices, default=LocateMode.SIMULATE
    )
    mapping_hash = serializers.CharField(required=False, allow_blank=True, default='')
    duration_seconds = serializers.IntegerField(
        required=False, min_value=1, max_value=120
    )
    idempotency_key = serializers.CharField(max_length=64)
    approve_live = serializers.BooleanField(default=False)


class PixelTestSerializer(serializers.Serializer):
    """Create a pixel test session."""

    pattern = serializers.ChoiceField(choices=['range', 'walk'], default='range')
    cabinet = serializers.UUIDField()
    logical_start = serializers.IntegerField(min_value=1)
    logical_end = serializers.IntegerField(min_value=1)
    profile = serializers.UUIDField(required=False, allow_null=True)
    mode = serializers.ChoiceField(
        choices=LocateMode.choices, default=LocateMode.SIMULATE
    )
    mapping_hash = serializers.CharField(required=False, allow_blank=True, default='')
    idempotency_key = serializers.CharField(max_length=64)
    approve_live = serializers.BooleanField(default=False)


class DiscoverySerializer(serializers.Serializer):
    """Run a bounded discovery job."""

    cabinet = serializers.UUIDField(required=False, allow_null=True)
    mode = serializers.ChoiceField(
        choices=LocateMode.choices, default=LocateMode.SIMULATE
    )
    scope = serializers.DictField(required=False, default=dict)


class ObserveSerializer(serializers.Serializer):
    """Observe a controller configuration."""

    mode = serializers.ChoiceField(
        choices=LocateMode.choices, default=LocateMode.SIMULATE
    )


class ImportPreviewSerializer(serializers.Serializer):
    """Preview the database diff proposed by an observation."""

    observation = serializers.UUIDField()


class ImportSerializer(serializers.Serializer):
    """Apply an observation's proposal to the saved configuration."""

    observation = serializers.UUIDField()
    accepted_diff_hash = serializers.CharField(
        required=False, allow_blank=True, default=''
    )


class ApproveConfigurationSerializer(serializers.Serializer):
    """Approve an observation as the expected configuration."""

    observation = serializers.UUIDField()
    mapping_hash = serializers.CharField(required=False, allow_blank=True, default='')
    checks = serializers.DictField(required=False, default=dict)


class ArmSerializer(serializers.Serializer):
    """Arm a cabinet's controllers."""

    controllers = serializers.ListField(
        child=serializers.UUIDField(), allow_empty=False
    )
    duration_minutes = serializers.IntegerField(
        required=False, min_value=1, max_value=120
    )


class ProfileCreateSerializer(serializers.Serializer):
    """Create a locate profile."""

    cabinet = serializers.UUIDField()
    name = serializers.CharField(max_length=100)
    purpose = serializers.ChoiceField(
        choices=LocatePurpose.choices, default=LocatePurpose.LOCATE
    )
    rgb_r = serializers.IntegerField(min_value=0, max_value=255, default=0)
    rgb_g = serializers.IntegerField(min_value=0, max_value=255, default=255)
    rgb_b = serializers.IntegerField(min_value=0, max_value=255, default=0)
    white = serializers.IntegerField(min_value=0, max_value=255, default=0)
    brightness = serializers.IntegerField(min_value=1, max_value=255, default=64)
    duration_seconds = serializers.IntegerField(min_value=1, max_value=120, default=120)


class ProfileUpdateSerializer(serializers.Serializer):
    """Update a locate profile."""

    name = serializers.CharField(max_length=100, required=False)
    purpose = serializers.ChoiceField(choices=LocatePurpose.choices, required=False)
    rgb_r = serializers.IntegerField(min_value=0, max_value=255, required=False)
    rgb_g = serializers.IntegerField(min_value=0, max_value=255, required=False)
    rgb_b = serializers.IntegerField(min_value=0, max_value=255, required=False)
    white = serializers.IntegerField(min_value=0, max_value=255, required=False)
    brightness = serializers.IntegerField(min_value=1, max_value=255, required=False)
    duration_seconds = serializers.IntegerField(
        min_value=1, max_value=120, required=False
    )


# endregion

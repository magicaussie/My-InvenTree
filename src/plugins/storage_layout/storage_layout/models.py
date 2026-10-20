"""Database models for the Storage Layout & WLED plugin.

These models are plugin-owned. They never duplicate native inventory data:
cabinets, drawers and bins reference native ``stock.StockLocation`` rows, and
stock quantities, movements and tracking remain owned by InvenTree core.

Design conventions (see ``docs/design/001 - Storage Layout & WLED.md`` §4):

- UUID primary keys and UTC ``created_at`` / ``updated_at`` timestamps.
- ``created_by`` / ``updated_by`` nullable ``SET_NULL`` FKs on user-editable roots.
- Positive integers for counts and indices, bounded strings for names/labels/hashes.
- JSON only for bounded snapshots, plans and error payloads.
- Every mutable cabinet aggregate carries a monotonic ``revision`` counter.

Row-local numeric bounds, enum membership and ``end >= start`` are enforced with
database ``CheckConstraint`` / ``UniqueConstraint``. Cross-row geometry,
interval, hierarchy and coverage rules are *service* validations implemented in
:mod:`storage_layout.validation` - never invented SQL subqueries.
"""

import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import Q
from django.db.models.signals import post_save
from django.utils.translation import gettext_lazy as _

from django_cleanup import cleanup

# region choices


class MappingState(models.TextChoices):
    """Lifecycle state of a mapping revision."""

    DRAFT = 'draft', _('Draft')
    PUBLISHED = 'published', _('Published')
    SUPERSEDED = 'superseded', _('Superseded')


class SpanDirection(models.IntegerChoices):
    """Application logical traversal direction of a pixel span."""

    FORWARD = 1, _('Forward')
    REVERSE = -1, _('Reverse')


class ControllerStatus(models.TextChoices):
    """Observed/derived status of a controller."""

    UNKNOWN = 'unknown', _('Unknown')
    OFFLINE = 'offline', _('Offline')
    ONLINE = 'online', _('Online')
    DRIFTED = 'drifted', _('Drifted')
    QUARANTINED = 'quarantined', _('Quarantined')


class CapabilityStatus(models.TextChoices):
    """Whether an observed configuration is supported by the adapter."""

    SUPPORTED = 'supported', _('Supported')
    UNVERIFIED = 'unverified', _('Unverified')
    UNSUPPORTED = 'unsupported', _('Unsupported')


class LocatePurpose(models.TextChoices):
    """Purpose of a locate profile."""

    LOCATE = 'locate', _('Locate')
    TEST = 'test', _('Test')
    RESERVED = 'reserved', _('Reserved')


class LocateMode(models.TextChoices):
    """Execution mode of a locate session or read job."""

    SIMULATE = 'simulate', _('Simulate')
    LIVE = 'live', _('Live')


class TargetKind(models.TextChoices):
    """Kind of locate target."""

    ITEM = 'item', _('Stock item')
    LOCATION = 'location', _('Stock location')
    DRAWER = 'drawer', _('Drawer')


class SessionState(models.TextChoices):
    """State machine states of a locate session."""

    QUEUED = 'queued', _('Queued')
    PREFLIGHT = 'preflight', _('Preflight')
    APPLYING = 'applying', _('Applying')
    ACTIVE = 'active', _('Active')
    STOPPING = 'stopping', _('Stopping')
    STOPPED = 'stopped', _('Stopped')
    EXPIRED = 'expired', _('Expired')
    FAILED = 'failed', _('Failed')
    UNKNOWN = 'unknown', _('Unknown')


class ExecutionState(models.TextChoices):
    """Per-controller execution state within a locate session."""

    PENDING = 'pending', _('Pending')
    APPLYING = 'applying', _('Applying')
    ACTIVE = 'active', _('Active')
    STOPPING = 'stopping', _('Stopping')
    CLEARED = 'cleared', _('Cleared')
    FAILED = 'failed', _('Failed')
    UNKNOWN = 'unknown', _('Unknown')


class ClearStatus(models.TextChoices):
    """Whether a controller has confirmed it is clear."""

    PENDING = 'pending', _('Pending')
    CONFIRMED = 'confirmed', _('Confirmed')
    UNCONFIRMED = 'unconfirmed', _('Unconfirmed')
    NOT_REQUIRED = 'not-required', _('Not required')


class ReadJobKind(models.TextChoices):
    """Kind of hardware read job."""

    DISCOVERY = 'discovery', _('Discovery')
    OBSERVE = 'observe', _('Observe')
    ARM_PREFLIGHT = 'arm-preflight', _('Arm preflight')


class JobState(models.TextChoices):
    """State of a durable hardware read job."""

    PENDING = 'pending', _('Pending')
    RUNNING = 'running', _('Running')
    COMPLETE = 'complete', _('Complete')
    FAILED = 'failed', _('Failed')
    EXPIRED = 'expired', _('Expired')


# endregion

# region abstract bases


class StorageLayoutModel(models.Model):
    """Abstract base for mutable plugin models."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(
        auto_now_add=True, verbose_name=_('Created'), db_index=True
    )
    updated_at = models.DateTimeField(auto_now=True, verbose_name=_('Updated'))

    class Meta:
        """Metaclass options."""

        abstract = True


class AppendOnlyModel(models.Model):
    """Abstract base for append-only plugin models.

    Append-only rows may be created but never updated; this is enforced in
    :meth:`save`. Deletion is still permitted (retention/purge is a service
    concern).
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(
        auto_now_add=True, verbose_name=_('Created'), db_index=True
    )

    class Meta:
        """Metaclass options."""

        abstract = True

    def save(self, *args, **kwargs):
        """Persist a new row, refusing to update an existing one."""
        if not self._state.adding:
            raise ValidationError(_('This record is append-only and cannot be updated'))

        return super().save(*args, **kwargs)


# endregion


@cleanup.ignore
class Cabinet(StorageLayoutModel):
    """A physical storage cabinet.

    The cabinet is the aggregate root for geometry, electrical topology and
    mapping. ``revision`` is the sole compare-and-swap / ETag counter for the
    whole aggregate.
    """

    class Meta:
        """Metaclass options."""

        verbose_name = _('Cabinet')
        verbose_name_plural = _('Cabinets')
        permissions = [
            ('configure_hardware', _('Can configure storage layout hardware')),
            ('operate_hardware', _('Can operate storage layout hardware')),
            ('emergency_stop', _('Can perform an emergency stop')),
        ]
        constraints = [
            models.CheckConstraint(
                condition=Q(width_units__gte=1),
                name='storage_layout_cabinet_width_positive',
            ),
            models.CheckConstraint(
                condition=Q(height_units__gte=1),
                name='storage_layout_cabinet_height_positive',
            ),
            models.CheckConstraint(
                condition=Q(revision__gte=1),
                name='storage_layout_cabinet_revision_positive',
            ),
        ]

    name = models.CharField(max_length=100, verbose_name=_('Name'))
    slug = models.SlugField(max_length=100, unique=True, verbose_name=_('Slug'))

    location = models.OneToOneField(
        'stock.StockLocation',
        on_delete=models.PROTECT,
        related_name='storage_layout_cabinet',
        verbose_name=_('Native location'),
        help_text=_('Native stock location representing this cabinet'),
    )

    width_units = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Width (units)')
    )
    height_units = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Height (units)')
    )
    background_image = models.FileField(
        upload_to='storage_layout/backgrounds/', blank=True, default=''
    )
    background_metadata = models.JSONField(default=dict, blank=True)

    structure = models.JSONField(
        null=True, blank=True, default=None, verbose_name=_('Physical structure')
    )

    revision = models.PositiveBigIntegerField(default=1, verbose_name=_('Revision'))
    archived = models.BooleanField(default=False, verbose_name=_('Archived'))

    active_mapping = models.ForeignKey(
        'MappingRevision',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='active_for_cabinets',
        verbose_name=_('Active mapping'),
    )
    default_profile = models.ForeignKey(
        'LocateProfile',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='default_for_cabinets',
        verbose_name=_('Default profile'),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Created by'),
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Updated by'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Cabinet {self.name}'

    @classmethod
    def check_user_permission(cls, user, permission: str) -> bool:
        """Custom permission fallback for this plugin model.

        Plugin models have no native ruleset entry, so the InvenTree permission
        system delegates to this classmethod. View/change map onto the built-in
        Django model permissions; the hardware permissions are explicit.
        """
        if not user or not user.is_active:
            return False

        if user.is_superuser:
            return True

        mapping = {
            'view': 'view_cabinet',
            'change': 'change_cabinet',
            'add': 'add_cabinet',
            'delete': 'delete_cabinet',
            'configure_hardware': 'configure_hardware',
            'operate_hardware': 'operate_hardware',
            'emergency_stop': 'emergency_stop',
        }

        codename = mapping.get(permission)

        if codename is None:
            return False

        return user.has_perm(f'storage_layout.{codename}')

    def clean(self):
        """Validate cross-model cabinet invariants."""
        super().clean()

        errors = {}

        if self.active_mapping_id and self.active_mapping.cabinet_id != self.pk:
            errors['active_mapping'] = _(
                'The active mapping must belong to this cabinet'
            )

        if self.default_profile_id and self.default_profile.cabinet_id != self.pk:
            errors['default_profile'] = _(
                'The default profile must belong to this cabinet'
            )

        if errors:
            raise ValidationError(errors)


@cleanup.ignore
class Drawer(StorageLayoutModel):
    """A drawer within a cabinet, with front-face geometry and interior plane."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Drawer')
        verbose_name_plural = _('Drawers')
        constraints = [
            models.UniqueConstraint(
                fields=['cabinet', 'label'], name='storage_layout_drawer_unique_label'
            ),
            models.UniqueConstraint(
                fields=['cabinet', 'display_number'],
                name='storage_layout_drawer_unique_number',
            ),
            models.CheckConstraint(
                condition=Q(display_number__gte=1),
                name='storage_layout_drawer_number_positive',
            ),
            models.CheckConstraint(
                condition=Q(width__gte=1), name='storage_layout_drawer_width_positive'
            ),
            models.CheckConstraint(
                condition=Q(height__gte=1), name='storage_layout_drawer_height_positive'
            ),
            models.CheckConstraint(
                condition=Q(interior_width__gte=1),
                name='storage_layout_drawer_interior_width_positive',
            ),
            models.CheckConstraint(
                condition=Q(interior_height__gte=1),
                name='storage_layout_drawer_interior_height_positive',
            ),
        ]

    cabinet = models.ForeignKey(
        Cabinet,
        on_delete=models.PROTECT,
        related_name='drawers',
        verbose_name=_('Cabinet'),
    )
    background_image = models.FileField(
        upload_to='storage_layout/backgrounds/', blank=True, default=''
    )
    background_metadata = models.JSONField(default=dict, blank=True)

    label = models.CharField(max_length=64, verbose_name=_('Label'))
    display_number = models.PositiveIntegerField(verbose_name=_('Display number'))

    location = models.OneToOneField(
        'stock.StockLocation',
        on_delete=models.PROTECT,
        related_name='storage_layout_drawer',
        verbose_name=_('Native location'),
        help_text=_('Native structural location representing this drawer'),
    )

    x = models.PositiveIntegerField(default=0, verbose_name=_('X'))
    y = models.PositiveIntegerField(default=0, verbose_name=_('Y'))
    width = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Width')
    )
    height = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Height')
    )

    interior_width = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Interior width')
    )
    interior_height = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Interior height')
    )

    archived = models.BooleanField(default=False, verbose_name=_('Archived'))

    def __str__(self):
        """Human readable representation."""
        return f'Drawer {self.label} ({self.cabinet})'


class Bin(StorageLayoutModel):
    """A bin inside a drawer interior plane.

    A bin may be saved unbound (work-in-progress geometry), but cannot resolve
    inventory until a native location is bound.
    """

    class Meta:
        """Metaclass options."""

        verbose_name = _('Bin')
        verbose_name_plural = _('Bins')
        constraints = [
            models.UniqueConstraint(
                fields=['drawer', 'label'], name='storage_layout_bin_unique_label'
            ),
            models.CheckConstraint(
                condition=Q(width__gte=1), name='storage_layout_bin_width_positive'
            ),
            models.CheckConstraint(
                condition=Q(height__gte=1), name='storage_layout_bin_height_positive'
            ),
        ]

    drawer = models.ForeignKey(
        Drawer, on_delete=models.PROTECT, related_name='bins', verbose_name=_('Drawer')
    )
    label = models.CharField(max_length=64, verbose_name=_('Label'))

    x = models.PositiveIntegerField(default=0, verbose_name=_('X'))
    y = models.PositiveIntegerField(default=0, verbose_name=_('Y'))
    width = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Width')
    )
    height = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Height')
    )

    location = models.OneToOneField(
        'stock.StockLocation',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='storage_layout_bin',
        verbose_name=_('Native location'),
        help_text=_('Optional native non-structural location bound to this bin'),
    )

    archived = models.BooleanField(default=False, verbose_name=_('Archived'))

    def __str__(self):
        """Human readable representation."""
        return f'Bin {self.label} ({self.drawer})'


class DrawerAllocation(StorageLayoutModel):
    """Inclusive contiguous logical pixel range allocated to a drawer."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Drawer allocation')
        verbose_name_plural = _('Drawer allocations')
        constraints = [
            models.CheckConstraint(
                condition=Q(logical_start__gte=1),
                name='storage_layout_allocation_start_positive',
            ),
            models.CheckConstraint(
                condition=Q(logical_end__gte=1),
                name='storage_layout_allocation_end_positive',
            ),
            models.CheckConstraint(
                condition=Q(logical_end__gte=models.F('logical_start')),
                name='storage_layout_allocation_end_after_start',
            ),
        ]

    drawer = models.OneToOneField(
        Drawer,
        on_delete=models.PROTECT,
        related_name='allocation',
        verbose_name=_('Drawer'),
    )
    logical_start = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Logical start')
    )
    logical_end = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Logical end')
    )

    def __str__(self):
        """Human readable representation."""
        return f'Allocation {self.logical_start}-{self.logical_end} ({self.drawer})'

    @property
    def pixel_count(self) -> int:
        """Number of logical pixels covered by this allocation."""
        return self.logical_end - self.logical_start + 1


class MappingRevision(StorageLayoutModel):
    """An immutable published (or editable draft) logical→physical mapping."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Mapping revision')
        verbose_name_plural = _('Mapping revisions')
        constraints = [
            models.UniqueConstraint(
                fields=['cabinet', 'number'],
                name='storage_layout_mapping_unique_number',
            ),
            models.CheckConstraint(
                condition=Q(number__gte=1),
                name='storage_layout_mapping_number_positive',
            ),
            models.CheckConstraint(
                condition=~Q(state=MappingState.PUBLISHED) | Q(total_pixels__gte=1),
                name='storage_layout_mapping_published_has_pixels',
            ),
        ]

    cabinet = models.ForeignKey(
        Cabinet,
        on_delete=models.PROTECT,
        related_name='mapping_revisions',
        verbose_name=_('Cabinet'),
    )
    number = models.PositiveIntegerField(verbose_name=_('Number'))
    state = models.CharField(
        max_length=16,
        choices=MappingState.choices,
        default=MappingState.DRAFT,
        verbose_name=_('State'),
    )
    total_pixels = models.PositiveIntegerField(
        default=0, verbose_name=_('Total logical pixels')
    )
    content_hash = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Content hash')
    )
    source_revision = models.PositiveBigIntegerField(
        default=1, verbose_name=_('Source cabinet revision')
    )
    manifest = models.JSONField(
        default=dict, blank=True, verbose_name=_('Published manifest')
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Created by'),
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Updated by'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Mapping #{self.number} ({self.state})'

    @property
    def is_published(self) -> bool:
        """Return True if this revision has been published."""
        return self.state == MappingState.PUBLISHED

    def save(self, *args, **kwargs):
        """Refuse to modify a revision which has already been published.

        Published revisions are immutable: replacing a mapping requires a new
        revision, so that historical sessions remain diagnosable.
        """
        if self.pk and not self._state.adding:
            previous = type(self).objects.filter(pk=self.pk).values('state').first()

            if previous and previous.get('state') == MappingState.PUBLISHED:
                raise ValidationError(_('Published mapping revisions are immutable'))

        return super().save(*args, **kwargs)


class PixelSpan(StorageLayoutModel):
    """A contiguous logical span mapped onto a physical LED string slice."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Pixel span')
        verbose_name_plural = _('Pixel spans')
        constraints = [
            models.UniqueConstraint(
                fields=['mapping_revision', 'logical_start'],
                name='storage_layout_span_unique_logical_start',
            ),
            models.CheckConstraint(
                condition=Q(logical_start__gte=1),
                name='storage_layout_span_start_positive',
            ),
            models.CheckConstraint(
                condition=Q(length__gte=1), name='storage_layout_span_length_positive'
            ),
            models.CheckConstraint(
                condition=Q(direction__in=[1, -1]),
                name='storage_layout_span_direction_valid',
            ),
        ]

    mapping_revision = models.ForeignKey(
        MappingRevision,
        on_delete=models.CASCADE,
        related_name='spans',
        verbose_name=_('Mapping revision'),
    )
    string = models.ForeignKey(
        'LEDString',
        on_delete=models.PROTECT,
        related_name='pixel_spans',
        verbose_name=_('LED string'),
    )
    logical_start = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Logical start')
    )
    length = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Length')
    )
    string_offset = models.PositiveIntegerField(
        default=0, verbose_name=_('String offset')
    )
    direction = models.SmallIntegerField(
        choices=SpanDirection.choices,
        default=SpanDirection.FORWARD,
        verbose_name=_('Direction'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Span {self.logical_start}+{self.length}'

    @property
    def logical_end(self) -> int:
        """Inclusive logical end of this span."""
        return self.logical_start + self.length - 1


class Controller(StorageLayoutModel):
    """A dedicated WLED controller owned by exactly one cabinet."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Controller')
        verbose_name_plural = _('Controllers')
        constraints = [
            models.CheckConstraint(
                condition=Q(desired_revision__gte=0),
                name='storage_layout_controller_desired_revision_positive',
            )
        ]

    cabinet = models.ForeignKey(
        Cabinet,
        on_delete=models.PROTECT,
        related_name='controllers',
        verbose_name=_('Cabinet'),
    )
    name = models.CharField(max_length=100, verbose_name=_('Name'))
    origin = models.CharField(
        max_length=255,
        unique=True,
        verbose_name=_('Origin'),
        help_text=_('Canonical controller origin (scheme://host[:port])'),
    )
    expected_mac = models.CharField(
        max_length=17,
        null=True,
        blank=True,
        unique=True,
        verbose_name=_('Expected MAC address'),
    )
    firmware_adapter = models.CharField(
        max_length=64, default='wled-v16.0.1-1d', verbose_name=_('Firmware adapter')
    )
    enabled = models.BooleanField(default=False, verbose_name=_('Enabled'))

    approved_snapshot = models.ForeignKey(
        'ConfigObservation',
        null=True,
        blank=True,
        on_delete=models.PROTECT,
        related_name='approved_for_controllers',
        verbose_name=_('Approved configuration'),
    )

    desired_revision = models.PositiveBigIntegerField(
        default=0, verbose_name=_('Desired configuration revision')
    )
    status = models.CharField(
        max_length=16,
        choices=ControllerStatus.choices,
        default=ControllerStatus.UNKNOWN,
        verbose_name=_('Status'),
    )
    last_seen = models.DateTimeField(null=True, blank=True, verbose_name=_('Last seen'))

    armed_until = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Armed until')
    )
    armed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Armed by'),
    )
    armed_mapping_hash = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Armed mapping hash')
    )
    armed_config_hash = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Armed config hash')
    )

    commissioning_policy = models.JSONField(
        default=dict, blank=True, verbose_name=_('Commissioning policy')
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Created by'),
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Updated by'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Controller {self.name} ({self.origin})'

    def save(self, *args, **kwargs):
        """Normalise the MAC address and canonical origin before saving.

        Normalisation (rather than validation) is performed here so that the
        unique ``origin`` constraint cannot be defeated by equivalent spellings
        of the same origin. Invalid values are left untouched for ``clean()``
        and the serializer layer to report.
        """
        from storage_layout.validation import validate_canonical_origin

        if self.expected_mac is not None:
            self.expected_mac = self.expected_mac.strip().upper() or None

        if self.origin:
            try:
                self.origin = validate_canonical_origin(self.origin)
            except ValidationError:
                # Leave the invalid value in place; clean() reports it.
                pass

        return super().save(*args, **kwargs)

    def clean(self):
        """Validate the canonical origin and MAC address."""
        super().clean()

        from storage_layout.validation import validate_canonical_origin

        errors = {}

        try:
            self.origin = validate_canonical_origin(self.origin)
        except ValidationError as exc:
            errors['origin'] = exc.messages

        if self.expected_mac:
            normalised = self.expected_mac.strip().upper()
            parts = normalised.split(':')

            if len(parts) != 6 or any(
                len(p) != 2 or any(c not in '0123456789ABCDEF' for c in p)
                for p in parts
            ):
                errors['expected_mac'] = _(
                    'Expected MAC address must be six colon-separated hex pairs'
                )

        if errors:
            raise ValidationError(errors)


class ControllerOutput(StorageLayoutModel):
    """A single WLED bus/output on a controller."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Controller output')
        verbose_name_plural = _('Controller outputs')
        constraints = [
            models.UniqueConstraint(
                fields=['controller', 'bus_index'],
                name='storage_layout_output_unique_bus_index',
            ),
            models.CheckConstraint(
                condition=Q(pixel_count__gte=1),
                name='storage_layout_output_count_positive',
            ),
        ]

    controller = models.ForeignKey(
        Controller,
        on_delete=models.PROTECT,
        related_name='outputs',
        verbose_name=_('Controller'),
    )
    bus_index = models.PositiveIntegerField(verbose_name=_('Bus index'))
    wled_start = models.PositiveIntegerField(default=0, verbose_name=_('WLED start'))
    pixel_count = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Pixel count')
    )
    pins = models.JSONField(default=list, blank=True, verbose_name=_('GPIO pins'))
    led_type = models.CharField(
        max_length=32, blank=True, default='', verbose_name=_('LED type')
    )
    colour_order = models.CharField(
        max_length=8, blank=True, default='GRB', verbose_name=_('Colour order')
    )
    bus_reverse = models.BooleanField(default=False, verbose_name=_('Bus reverse'))
    skip = models.PositiveSmallIntegerField(default=0, verbose_name=_('Skip'))
    auto_white_mode = models.PositiveSmallIntegerField(
        default=0, verbose_name=_('Auto white mode')
    )
    max_current_ma = models.PositiveIntegerField(
        null=True, blank=True, verbose_name=_('Maximum current (mA)')
    )

    def __str__(self):
        """Human readable representation."""
        return f'Output {self.bus_index} ({self.controller})'

    @property
    def wled_end(self) -> int:
        """Exclusive end of this output's controller-global address range."""
        return self.wled_start + self.pixel_count


class LEDString(StorageLayoutModel):
    """A physical daisy-chained cable section on a controller output."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('LED string')
        verbose_name_plural = _('LED strings')
        constraints = [
            models.UniqueConstraint(
                fields=['output', 'label'], name='storage_layout_string_unique_label'
            ),
            models.CheckConstraint(
                condition=Q(pixel_count__gte=1),
                name='storage_layout_string_count_positive',
            ),
        ]

    output = models.ForeignKey(
        ControllerOutput,
        on_delete=models.PROTECT,
        related_name='strings',
        verbose_name=_('Output'),
    )
    label = models.CharField(max_length=64, verbose_name=_('Label'))
    output_offset = models.PositiveIntegerField(
        default=0, verbose_name=_('Output offset')
    )
    pixel_count = models.PositiveIntegerField(
        validators=[MinValueValidator(1)], verbose_name=_('Pixel count')
    )
    notes = models.TextField(blank=True, default='', verbose_name=_('Notes'))
    archived = models.BooleanField(default=False, verbose_name=_('Archived'))

    def __str__(self):
        """Human readable representation."""
        return f'String {self.label} ({self.output})'

    @property
    def output_end(self) -> int:
        """Exclusive end of this string's output-local address range."""
        return self.output_offset + self.pixel_count


class ConfigObservation(AppendOnlyModel):
    """An append-only, redacted observation of controller configuration."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Configuration observation')
        verbose_name_plural = _('Configuration observations')

    controller = models.ForeignKey(
        Controller,
        on_delete=models.PROTECT,
        related_name='observations',
        verbose_name=_('Controller'),
    )
    observed_at = models.DateTimeField(verbose_name=_('Observed at'))
    adapter_version = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Adapter version')
    )
    info = models.JSONField(default=dict, blank=True, verbose_name=_('Info'))
    normalised_config = models.JSONField(
        default=dict, blank=True, verbose_name=_('Normalised configuration')
    )
    fingerprint = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Fingerprint')
    )
    capability_status = models.CharField(
        max_length=16,
        choices=CapabilityStatus.choices,
        default=CapabilityStatus.UNVERIFIED,
        verbose_name=_('Capability status'),
    )
    diff = models.JSONField(default=dict, blank=True, verbose_name=_('Diff'))
    observed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Observed by'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Observation {self.observed_at} ({self.controller})'


class LocateProfile(StorageLayoutModel):
    """A configurable locate/test colour, brightness and duration profile."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Locate profile')
        verbose_name_plural = _('Locate profiles')
        constraints = [
            models.UniqueConstraint(
                fields=['cabinet', 'name'], name='storage_layout_profile_unique_name'
            ),
            models.CheckConstraint(
                condition=Q(brightness__gte=1) & Q(brightness__lte=255),
                name='storage_layout_profile_brightness_range',
            ),
            models.CheckConstraint(
                condition=Q(duration_seconds__gte=1) & Q(duration_seconds__lte=120),
                name='storage_layout_profile_duration_range',
            ),
        ]

    cabinet = models.ForeignKey(
        Cabinet,
        on_delete=models.PROTECT,
        related_name='profiles',
        verbose_name=_('Cabinet'),
    )
    name = models.CharField(max_length=100, verbose_name=_('Name'))
    purpose = models.CharField(
        max_length=16,
        choices=LocatePurpose.choices,
        default=LocatePurpose.LOCATE,
        verbose_name=_('Purpose'),
    )

    rgb_r = models.PositiveSmallIntegerField(
        default=0, validators=[MaxValueValidator(255)], verbose_name=_('Red')
    )
    rgb_g = models.PositiveSmallIntegerField(
        default=255, validators=[MaxValueValidator(255)], verbose_name=_('Green')
    )
    rgb_b = models.PositiveSmallIntegerField(
        default=0, validators=[MaxValueValidator(255)], verbose_name=_('Blue')
    )
    white = models.PositiveSmallIntegerField(
        default=0, validators=[MaxValueValidator(255)], verbose_name=_('White')
    )

    brightness = models.PositiveSmallIntegerField(
        default=64,
        validators=[MinValueValidator(1), MaxValueValidator(255)],
        verbose_name=_('Brightness'),
    )
    duration_seconds = models.PositiveIntegerField(
        default=120,
        validators=[MinValueValidator(1), MaxValueValidator(120)],
        verbose_name=_('Duration (seconds)'),
    )

    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Created by'),
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Updated by'),
    )

    def __str__(self):
        """Human readable representation."""
        return f'Profile {self.name} ({self.cabinet})'

    @property
    def rgb(self) -> tuple[int, int, int]:
        """Return the RGB triple as a tuple."""
        return (self.rgb_r, self.rgb_g, self.rgb_b)

    def clean(self):
        """Apply purpose-specific duration limits."""
        super().clean()

        from storage_layout.validation import validate_profile_duration

        try:
            validate_profile_duration(self.purpose, self.duration_seconds)
        except ValidationError as exc:
            raise ValidationError({'duration_seconds': exc.messages}) from exc


class LocateSession(StorageLayoutModel):
    """A durable, auditable locate or test session."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Locate session')
        verbose_name_plural = _('Locate sessions')
        constraints = [
            models.UniqueConstraint(
                fields=['cabinet', 'idempotency_key'],
                name='storage_layout_session_unique_idempotency_key',
            )
        ]

    cabinet = models.ForeignKey(
        Cabinet,
        on_delete=models.PROTECT,
        related_name='locate_sessions',
        verbose_name=_('Cabinet'),
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Actor'),
    )

    target_kind = models.CharField(
        max_length=16, choices=TargetKind.choices, verbose_name=_('Target kind')
    )
    target_item = models.ForeignKey(
        'stock.StockItem',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Target stock item'),
    )
    target_location = models.ForeignKey(
        'stock.StockLocation',
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Target stock location'),
    )
    target_label = models.CharField(
        max_length=100, blank=True, default='', verbose_name=_('Target label snapshot')
    )
    target_pk = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Target PK snapshot')
    )

    mode = models.CharField(
        max_length=16,
        choices=LocateMode.choices,
        default=LocateMode.SIMULATE,
        verbose_name=_('Mode'),
    )
    mapping_hash = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Mapping hash')
    )
    layout_revision = models.PositiveBigIntegerField(
        default=0, verbose_name=_('Layout revision')
    )
    profile_snapshot = models.JSONField(
        default=dict, blank=True, verbose_name=_('Profile snapshot')
    )

    idempotency_key = models.CharField(max_length=64, verbose_name=_('Idempotency key'))
    request_hash = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Request hash')
    )

    state = models.CharField(
        max_length=16,
        choices=SessionState.choices,
        default=SessionState.QUEUED,
        verbose_name=_('State'),
    )
    expires_at = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Expires at')
    )
    plan = models.JSONField(default=dict, blank=True, verbose_name=_('Plan'))
    failure = models.JSONField(default=dict, blank=True, verbose_name=_('Failure'))

    def __str__(self):
        """Human readable representation."""
        return f'Session {self.pk} ({self.state})'


class CabinetOperation(StorageLayoutModel):
    """Per-cabinet reservation and generation bookkeeping row."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Cabinet operation')
        verbose_name_plural = _('Cabinet operations')

    cabinet = models.OneToOneField(
        Cabinet,
        on_delete=models.CASCADE,
        related_name='operation',
        verbose_name=_('Cabinet'),
    )
    current_session = models.ForeignKey(
        LocateSession,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Current session'),
    )
    generation = models.PositiveBigIntegerField(default=0, verbose_name=_('Generation'))
    lease_owner = models.CharField(
        max_length=100, blank=True, default='', verbose_name=_('Lease owner')
    )
    lease_expires_at = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Lease expires at')
    )
    heartbeat_at = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Heartbeat at')
    )

    def __str__(self):
        """Human readable representation."""
        return f'Operation state for {self.cabinet}'


class ControllerExecution(StorageLayoutModel):
    """Per-controller progress record for a locate session."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Controller execution')
        verbose_name_plural = _('Controller executions')
        constraints = [
            models.UniqueConstraint(
                fields=['session', 'controller'],
                name='storage_layout_execution_unique_controller',
            )
        ]

    session = models.ForeignKey(
        LocateSession,
        on_delete=models.CASCADE,
        related_name='executions',
        verbose_name=_('Session'),
    )
    controller = models.ForeignKey(
        Controller,
        on_delete=models.PROTECT,
        related_name='executions',
        verbose_name=_('Controller'),
    )
    generation = models.PositiveBigIntegerField(default=0, verbose_name=_('Generation'))
    state = models.CharField(
        max_length=16,
        choices=ExecutionState.choices,
        default=ExecutionState.PENDING,
        verbose_name=_('State'),
    )
    last_step = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Last step')
    )
    acknowledged_at = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Acknowledged at')
    )
    clear_status = models.CharField(
        max_length=16,
        choices=ClearStatus.choices,
        default=ClearStatus.PENDING,
        verbose_name=_('Clear status'),
    )
    error = models.JSONField(default=dict, blank=True, verbose_name=_('Error'))

    def __str__(self):
        """Human readable representation."""
        return f'Execution {self.controller} ({self.state})'


class HardwareReadJob(StorageLayoutModel):
    """A durable, actor-scoped hardware read job."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Hardware read job')
        verbose_name_plural = _('Hardware read jobs')

    cabinet = models.ForeignKey(
        Cabinet,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='read_jobs',
        verbose_name=_('Cabinet'),
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Actor'),
    )
    kind = models.CharField(
        max_length=16, choices=ReadJobKind.choices, verbose_name=_('Kind')
    )
    controller = models.ForeignKey(
        Controller,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='read_jobs',
        verbose_name=_('Controller'),
    )
    mode = models.CharField(
        max_length=16,
        choices=LocateMode.choices,
        default=LocateMode.SIMULATE,
        verbose_name=_('Mode'),
    )
    scope_snapshot = models.JSONField(
        default=dict, blank=True, verbose_name=_('Scope snapshot')
    )
    q_task_id = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Task ID')
    )
    state = models.CharField(
        max_length=16,
        choices=JobState.choices,
        default=JobState.PENDING,
        verbose_name=_('State'),
    )
    result = models.JSONField(default=dict, blank=True, verbose_name=_('Result'))
    error = models.JSONField(default=dict, blank=True, verbose_name=_('Error'))
    expires_at = models.DateTimeField(
        null=True, blank=True, verbose_name=_('Expires at')
    )

    def __str__(self):
        """Human readable representation."""
        return f'Read job {self.pk} ({self.kind})'


class DesignAudit(AppendOnlyModel):
    """Append-only audit entry for layout, mapping and hardware operations."""

    class Meta:
        """Metaclass options."""

        verbose_name = _('Design audit entry')
        verbose_name_plural = _('Design audit entries')

    cabinet = models.ForeignKey(
        Cabinet,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='audit_entries',
        verbose_name=_('Cabinet'),
    )
    actor = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name='+',
        verbose_name=_('Actor'),
    )
    operation = models.CharField(max_length=64, verbose_name=_('Operation'))
    before_revision = models.PositiveBigIntegerField(
        null=True, blank=True, verbose_name=_('Before revision')
    )
    after_revision = models.PositiveBigIntegerField(
        null=True, blank=True, verbose_name=_('After revision')
    )
    correlation_id = models.CharField(
        max_length=64, blank=True, default='', verbose_name=_('Correlation ID')
    )
    details = models.JSONField(default=dict, blank=True, verbose_name=_('Details'))

    def __str__(self):
        """Human readable representation."""
        return f'Audit {self.operation} ({self.created_at})'


def ensure_cabinet_operation(sender, instance, created, **kwargs):
    """Precreate the reservation row for every new cabinet."""
    if created:
        CabinetOperation.objects.get_or_create(cabinet=instance)


post_save.connect(
    ensure_cabinet_operation,
    sender=Cabinet,
    dispatch_uid='storage_layout_cabinet_operation',
)

"""Authorized visual references, independent of layout and inventory geometry.

Files have opaque generated names. API responses never disclose storage paths.
Replaced files are retained for a separately audited reference-aware cleanup;
failed writes remove only their own newly allocated file.
"""

import io
import math
import uuid
import warnings

from django.core.files.base import ContentFile
from django.db import transaction
from django.http import FileResponse

from PIL import Image
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from storage_layout import services
from storage_layout.api import StorageLayoutBaseMixin, _etag, _get_cabinet, _get_drawer
from storage_layout.models import Cabinet

MAX_BYTES = 8 * 1024 * 1024
MAX_PIXELS = 20_000_000
DEFAULT_METADATA = {
    'x': 0.0,
    'y': 0.0,
    'width': 1.0,
    'height': 1.0,
    'opacity': 0.5,
    'visible': True,
    'locked': True,
    'aspect_locked': True,
}


class BackgroundMetadataSerializer(serializers.Serializer):
    """Normalized canvas fractions; resizing a canvas scales the reference."""

    x = serializers.FloatField(min_value=-10, max_value=10)
    y = serializers.FloatField(min_value=-10, max_value=10)
    width = serializers.FloatField(min_value=0.0001, max_value=20)
    height = serializers.FloatField(min_value=0.0001, max_value=20)
    opacity = serializers.FloatField(min_value=0, max_value=1)
    visible = serializers.BooleanField()
    locked = serializers.BooleanField()
    aspect_locked = serializers.BooleanField()

    def validate(self, attrs):
        """Reject non-finite values, including NaN which evades range checks."""
        if any(isinstance(v, float) and not math.isfinite(v) for v in attrs.values()):
            raise serializers.ValidationError('Image transforms must be finite.')
        if set(self.initial_data) - set(self.fields):
            raise serializers.ValidationError('Unknown image metadata field.')
        return attrs


def validated_image(upload):
    """Decode and re-encode a bounded raster; reject MIME/content mismatches."""
    if upload is None or upload.size > MAX_BYTES:
        raise serializers.ValidationError({
            'image': 'Upload a raster image of at most 8 MiB.'
        })
    formats = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(upload) as image:
                if (
                    image.format not in formats
                    or formats[image.format] != upload.content_type
                ):
                    raise ValueError('Unsupported image or MIME mismatch')
                if (
                    image.width * image.height > MAX_PIXELS
                    or getattr(image, 'n_frames', 1) != 1
                ):
                    raise ValueError('Image is too large or animated')
                image.load()
                output = io.BytesIO()
                image.convert('RGBA').save(output, format='PNG')
                if output.tell() > MAX_BYTES:
                    raise ValueError('Decoded image exceeds storage limit')
                return ContentFile(output.getvalue(), name=f'{uuid.uuid4().hex}.png')
    except (
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as exc:
        raise serializers.ValidationError({
            'image': 'Invalid, oversized or unsupported raster image.'
        }) from exc


class BackgroundView(StorageLayoutBaseMixin, APIView):
    """Read/upload/edit/remove one cabinet or drawer reference using root CAS."""

    permission_map = {
        'GET': 'view',
        'POST': 'change',
        'PATCH': 'change',
        'DELETE': 'change',
        'OPTIONS': 'view',
    }
    drawer = False

    def target(self, pk, user):
        """Use the same ownership checks as layout endpoints."""
        return (_get_drawer if self.drawer else _get_cabinet)(pk, user)

    def document(self, target, request):
        """Only expose an authorized content endpoint, never a media filename."""
        return {
            'image_url': request.path.rstrip('/') + '/content/'
            if target.background_image
            else None,
            'metadata': {**DEFAULT_METADATA, **target.background_metadata},
        }

    def get(self, request, pk):
        """Read persisted reference metadata."""
        target = self.target(pk, request.user)
        cabinet = target.cabinet if self.drawer else target
        return _etag(Response(self.document(target, request)), cabinet.revision)

    def post(self, request, pk):
        """Upload or replace an image without changing geometry or locations."""
        return self.mutate(request, pk, upload=True)

    def patch(self, request, pk):
        """Persist placement only."""
        return self.mutate(request, pk)

    def delete(self, request, pk):
        """Detach a reference; retain media pending reference-aware cleanup."""
        return self.mutate(request, pk, remove=True)

    def mutate(self, request, pk, upload=False, remove=False):
        """Serialize against aggregate edits and clean failed new writes."""
        target = self.target(pk, request.user)
        services.require_change(request.user)
        expected = services.parse_if_match(request)
        new_file = validated_image(request.FILES.get('image')) if upload else None
        metadata = None
        if not upload and not remove:
            serializer = BackgroundMetadataSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            metadata = serializer.validated_data
        saved_name = None
        storage = target.background_image.storage
        try:
            with transaction.atomic():
                cabinet_id = target.cabinet_id if self.drawer else target.pk
                cabinet = Cabinet.objects.select_for_update().get(pk=cabinet_id)
                services.cas_update_cabinet(cabinet, expected)
                target.refresh_from_db()
                if new_file:
                    target.background_image.save(new_file.name, new_file, save=False)
                    saved_name = target.background_image.name
                if remove:
                    target.background_image = ''
                if metadata is not None:
                    target.background_metadata = dict(metadata)
                # Bypass django-cleanup's per-row deletion: another row may
                # still reference an old file. Cleanup requires a global audit.
                type(target).objects.filter(pk=target.pk).update(
                    background_image=target.background_image.name,
                    background_metadata=target.background_metadata,
                )
        except Exception:
            if saved_name:
                storage.delete(saved_name)
            raise
        return _etag(Response(self.document(target, request)), cabinet.revision)


class DrawerBackgroundView(BackgroundView):
    """Independent drawer-interior reference."""

    drawer = True


class BackgroundContentView(BackgroundView):
    """Stream private media only after authenticating and checking ownership."""

    http_method_names = ['get', 'head', 'options']

    def get(self, request, pk):
        """Serve a safe raster with no cache or content sniffing."""
        target = self.target(pk, request.user)
        if not target.background_image:
            raise services.NotFoundError('Background not found', code='not_found')
        try:
            content = target.background_image.open('rb')
        except FileNotFoundError as exc:
            raise services.NotFoundError(
                'Background not found', code='not_found'
            ) from exc
        response = FileResponse(content, content_type='image/png')
        response['Cache-Control'] = 'private, no-store'
        response['X-Content-Type-Options'] = 'nosniff'
        return response


class DrawerBackgroundContentView(BackgroundContentView):
    """Authorized drawer media stream."""

    drawer = True

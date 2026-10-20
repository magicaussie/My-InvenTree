"""Local media and active-mapping preservation tests; never controller I/O."""

import io
import tempfile
from pathlib import Path
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from PIL import Image

from storage_layout.backgrounds import DEFAULT_METADATA, MAX_BYTES
from storage_layout.models import Drawer, DrawerAllocation, PixelSpan
from storage_layout.tests.test_api import BASE, ApiTestCase


def raster(content_type='image/png'):
    """Build a small real PNG, not a filename-only fixture."""
    content = io.BytesIO()
    Image.new('RGB', (24, 12), 'blue').save(content, format='PNG')
    return SimpleUploadedFile(
        'reference.png', content.getvalue(), content_type=content_type
    )


class BackgroundTests(ApiTestCase):
    """References must not mutate inventory, mapping or geometry."""

    def setUp(self):
        """Isolate storage for each test."""
        super().setUp()
        directory = tempfile.TemporaryDirectory(prefix='storage-background-test-')
        self.addCleanup(directory.cleanup)
        self.media = directory.name
        settings = override_settings(MEDIA_ROOT=self.media)
        settings.enable()
        self.addCleanup(settings.disable)
        self.url = self.cabinet_url('background/')
        self.drawer_url = f'{BASE}drawers/{self.drawer.pk}/background/'

    def upload(self, url=None, revision=1, image=None, expected=200):
        """Send a real multipart upload with a revision."""
        return self.post(
            url or self.url,
            {'image': image or raster()},
            format='multipart',
            HTTP_IF_MATCH=f'"{revision}"',
            expected_code=expected,
        )

    def snapshot(self):
        """A populated active mapping is present in ApiTestCase, not null."""
        self.cabinet.refresh_from_db()
        self.assertEqual(self.cabinet.active_mapping_id, self.mapping.pk)
        return {
            'drawers': list(
                Drawer.objects.values(
                    'id',
                    'location_id',
                    'x',
                    'y',
                    'width',
                    'height',
                    'interior_width',
                    'interior_height',
                )
            ),
            'allocations': list(DrawerAllocation.objects.values()),
            'spans': list(PixelSpan.objects.values()),
            'mapping': self.cabinet.active_mapping_id,
            'structure': self.cabinet.structure,
        }

    def test_legacy_default_and_no_storage_path_disclosure(self):
        """Legacy default and no storage path disclosure."""
        response = self.get(self.url)
        self.assertEqual(
            response.data, {'image_url': None, 'metadata': DEFAULT_METADATA}
        )
        self.assertEqual(response['ETag'], '"1"')

    def test_upload_transform_replace_remove_preserves_mapping_and_geometry(self):
        """Upload transform replace remove preserves mapping and geometry."""
        before = self.snapshot()
        response = self.upload()
        self.assertEqual(response.data['image_url'], self.url + 'content/')
        self.cabinet.refresh_from_db()
        old_name = self.cabinet.background_image.name
        self.assertNotIn(old_name, str(response.data))
        response = self.get(self.url + 'content/')
        self.assertEqual(response['Content-Type'], 'image/png')
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        response.close()
        metadata = {**DEFAULT_METADATA, 'x': 0.2, 'width': 0.75, 'opacity': 0.3}
        self.patch(self.url, metadata, HTTP_IF_MATCH='"2"')
        self.upload(revision=3)
        self.assertTrue(Path(self.media, old_name).exists())
        self.assertEqual(self.get(self.url).data['metadata'], metadata)
        self.delete(self.url, HTTP_IF_MATCH='"4"', expected_code=200)
        self.get(self.url + 'content/', expected_code=404)
        self.assertEqual(before, self.snapshot())

    def test_drawer_and_cabinet_references_are_independent(self):
        """Drawer and cabinet references are independent."""
        self.upload()
        self.upload(self.drawer_url, revision=2)
        self.cabinet.refresh_from_db()
        self.drawer.refresh_from_db()
        self.assertNotEqual(
            self.cabinet.background_image.name, self.drawer.background_image.name
        )
        self.delete(self.drawer_url, HTTP_IF_MATCH='"3"', expected_code=200)
        self.assertIsNotNone(self.get(self.url).data['image_url'])
        self.assertIsNone(self.get(self.drawer_url).data['image_url'])

    def test_mime_content_size_and_transform_validation(self):
        """Mime content size and transform validation."""
        for image in (
            raster('image/jpeg'),
            SimpleUploadedFile('bad.svg', b'<svg/>', content_type='image/svg+xml'),
            SimpleUploadedFile('bad.png', b'not an image', content_type='image/png'),
            SimpleUploadedFile(
                'big.png', b'x' * (MAX_BYTES + 1), content_type='image/png'
            ),
        ):
            self.upload(image=image, expected=400)
        for bad in (
            {'width': 0},
            {'x': 'Infinity'},
            {'image_url': 'https://example.com/test.png'},
            {'opacity': 2},
        ):
            self.patch(
                self.url,
                {**DEFAULT_METADATA, **bad},
                HTTP_IF_MATCH='"1"',
                expected_code=400,
            )
        self.assertEqual(list(Path(self.media).rglob('*.png')), [])

    def test_cas_and_failed_transaction_leave_no_new_files(self):
        """Cas and failed transaction leave no new files."""
        self.post(self.url, {'image': raster()}, format='multipart', expected_code=428)
        self.upload(revision=99, expected=412)
        self.assertEqual(list(Path(self.media).rglob('*.png')), [])
        with mock.patch(
            'storage_layout.backgrounds.type',
            side_effect=RuntimeError('rollback'),
            create=True,
        ):
            with self.assertRaises(RuntimeError):
                self.upload()
        self.assertEqual(list(Path(self.media).rglob('*.png')), [])
        self.cabinet.refresh_from_db()
        self.assertEqual(self.cabinet.revision, 1)

    def test_permissions_and_ownership_apply_to_metadata_upload_and_content(self):
        """Permissions and ownership apply to metadata upload and content."""
        self.upload()
        with mock.patch(
            'storage_layout.services.user_owns_cabinet', return_value=False
        ):
            self.get(self.url, expected_code=404)
            self.get(self.url + 'content/', expected_code=404)
            self.upload(revision=2, expected=404)
        with mock.patch('storage_layout.services.user_owns_drawer', return_value=False):
            self.get(self.drawer_url, expected_code=404)
            self.upload(self.drawer_url, revision=2, expected=404)
        with mock.patch(
            'storage_layout.services.user_has_permission',
            side_effect=lambda user, permission: permission == 'view',
        ):
            self.get(self.url)
            self.upload(revision=2, expected=403)
            self.patch(
                self.url, DEFAULT_METADATA, HTTP_IF_MATCH='"2"', expected_code=403
            )
            self.delete(self.url, HTTP_IF_MATCH='"2"', expected_code=403)

    def test_shared_reference_is_retained_and_pixel_bombs_rejected(self):
        """Removing one reference must not remove another row's file."""
        self.upload()
        self.cabinet.refresh_from_db()
        self.drawer.background_image = self.cabinet.background_image.name
        self.drawer.save(update_fields=['background_image'])
        self.delete(self.url, HTTP_IF_MATCH='"2"', expected_code=200)
        response = self.get(self.drawer_url + 'content/')
        self.assertEqual(response['Content-Type'], 'image/png')
        response.close()
        with mock.patch('storage_layout.backgrounds.MAX_PIXELS', 10):
            self.upload(revision=3, expected=400)

    def test_real_ownership_hides_background_content_and_writes(self):
        """Exercise native ownership without mocking the ownership predicate."""
        from django.contrib.auth.models import Group

        from common.models import InvenTreeSetting
        from users.models import Owner

        self.upload()
        InvenTreeSetting.set_setting('STOCK_OWNERSHIP_CONTROL', True, self.user)
        other = Group.objects.create(name='background-other-owner')
        self.cabinet_location.owner = Owner.get_owner(other)
        self.cabinet_location.save()
        for url in (self.url, self.drawer_url):
            self.get(url, expected_code=404)
            self.get(url + 'content/', expected_code=404)
            self.upload(url, revision=2, expected=404)
            self.patch(url, DEFAULT_METADATA, HTTP_IF_MATCH='"2"', expected_code=404)
        self.cabinet_location.owner = Owner.get_owner(self.group)
        self.cabinet_location.save()
        self.get(self.url)
        content = self.get(self.url + 'content/')
        self.assertEqual(content['Content-Type'], 'image/png')
        content.close()

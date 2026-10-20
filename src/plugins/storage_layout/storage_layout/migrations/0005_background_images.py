"""Add optional visual references without touching saved structure or geometry."""

from django.db import migrations, models


class Migration(migrations.Migration):
    """Add independent cabinet and drawer background fields."""

    dependencies = [('storage_layout', '0004_cabinet_structure')]

    operations = [
        migrations.AddField(model_name=model, name=name, field=field)
        for model in ('cabinet', 'drawer')
        for name, field in (
            (
                'background_image',
                models.FileField(
                    upload_to='storage_layout/backgrounds/', blank=True, default=''
                ),
            ),
            ('background_metadata', models.JSONField(default=dict, blank=True)),
        )
    ]

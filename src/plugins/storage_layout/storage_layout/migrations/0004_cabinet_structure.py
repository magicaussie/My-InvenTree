from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('storage_layout', '0003_operations_audit_permissions')]

    operations = [
        migrations.AddField(
            model_name='cabinet',
            name='structure',
            field=models.JSONField(blank=True, default=None, null=True, verbose_name='Physical structure'),
        ),
    ]

# Disposable integration build from this checkout, not an upstream app image.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS frontend-build
ENV NODE_OPTIONS=--max-old-space-size=4096
WORKDIR /app
COPY src/frontend/package.json src/frontend/yarn.lock ./src/frontend/
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app/src/frontend
RUN yarn install --frozen-lockfile --network-timeout 600000
WORKDIR /app
COPY src/frontend ./src/frontend
COPY src/backend/InvenTree/InvenTree/version.py ./src/backend/InvenTree/InvenTree/version.py
WORKDIR /app/src/frontend
# These are the same compile/build steps used by invoke int.frontend-compile.
RUN yarn run compile && yarn run build
WORKDIR /app/src/plugins/storage_layout/frontend
COPY src/plugins/storage_layout/frontend/package.json src/plugins/storage_layout/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/plugins/storage_layout/frontend ./
RUN npm run build

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS backend
ENV PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
    libglib2.0-0 shared-mime-info gettext git fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY src/backend/requirements.txt ./src/backend/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r src/backend/requirements.txt \
    && pip install --no-cache-dir 'psycopg[binary,pool]==3.3.4' 'invoke==3.0.3'
COPY src/backend/requirements-dev.txt ./src/backend/requirements-dev.txt
RUN pip install --no-cache-dir --require-hashes -r src/backend/requirements-dev.txt
COPY src/backend/InvenTree ./src/backend/InvenTree
COPY tasks.py ./
COPY src/plugins/storage_layout ./src/plugins/storage_layout
COPY --from=frontend-build /app/src/backend/InvenTree/web/static/web ./src/backend/InvenTree/web/static/web
COPY --from=frontend-build /app/src/plugins/storage_layout/storage_layout/static ./src/plugins/storage_layout/storage_layout/static
COPY contrib/storage-layout-integration ./contrib/storage-layout-integration
RUN pip install --no-cache-dir ./src/plugins/storage_layout
ENV INVENTREE_CONFIG_FILE=/data/config.yaml \
    INVENTREE_SECRET_KEY_FILE=/data/secret_key.txt \
    INVENTREE_STATIC_ROOT=/data/static \
    INVENTREE_MEDIA_ROOT=/data/media \
    INVENTREE_BACKUP_DIR=/data/backup \
    INVENTREE_PLUGIN_DIR=/data/plugins \
    INVENTREE_PLUGIN_FILE=/data/plugins.txt
CMD ["gunicorn", "--chdir", "/app/src/backend/InvenTree", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "2", "--timeout", "120", "InvenTree.wsgi:application"]

FROM nginx:1.28-alpine@sha256:a8b39bd9cf0f83869a2162827a0caf6137ddf759d50a171451b335cecc87d236 AS frontend
COPY --from=frontend-build /app/src/backend/InvenTree/web/static/web /srv/frontend
COPY contrib/storage-layout-integration/nginx.conf /etc/nginx/conf.d/default.conf

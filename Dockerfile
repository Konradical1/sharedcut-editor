FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/import-requirements.txt ./scripts/import-requirements.txt
RUN python3 -m venv /opt/media-import && /opt/media-import/bin/pip install --no-cache-dir -r scripts/import-requirements.txt
COPY scripts/color-requirements.txt ./scripts/color-requirements.txt
RUN python3 -m venv /opt/color && /opt/color/bin/pip install --no-cache-dir -r scripts/color-requirements.txt
ENV FRAME_LINE_COLOR_PYTHON=/opt/color/bin/python
ENV FRAME_LINE_IMPORT_PYTHON=/opt/media-import/bin/python
COPY scripts/stabilize-requirements.txt ./scripts/stabilize-requirements.txt
RUN python3 -m venv /opt/stabilize && /opt/stabilize/bin/pip install --no-cache-dir -r scripts/stabilize-requirements.txt
ENV FRAME_LINE_STABILIZE_PYTHON=/opt/stabilize/bin/python
# The portable flow worker shares OpenCV/NumPy with stabilization.
ENV FRAME_LINE_FLOW_PYTHON=/opt/stabilize/bin/python
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public/fonts ./public/fonts
COPY server ./server
COPY src ./src
COPY scripts/resolve-export.lua ./scripts/resolve-export.lua
COPY scripts/import-link.py ./scripts/import-link.py
COPY scripts/color-render.py ./scripts/color-render.py
COPY scripts/stabilize.py ./scripts/stabilize.py
COPY scripts/optical-flow.py ./scripts/optical-flow.py
RUN mkdir /data && chown node:node /data
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4310 FRAME_LINE_DATA=/data
USER node
EXPOSE 4310
CMD ["node", "--experimental-strip-types", "server/index.ts"]

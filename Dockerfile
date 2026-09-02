# Runs the server with Chromium inside the image.
#
# The session is the awkward part: signing in needs a window, and a container
# does not have one. So the browser profile is mounted from the host. Sign in
# once with `midjourney-cli login` on a machine with a display, then mount the
# profile directory it created. The container drives that profile headlessly.
#
# Cloudflare treats a headless session more suspiciously than a visible one, so
# this is the deployment with the most friction, not the least. Run it on the
# host directly where you can.

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
COPY README.md SKILL.md LICENSE ./

ENV MIDJOURNEY_CHROME_PATH=/usr/bin/chromium
ENV MIDJOURNEY_HEADLESS=1
ENV MIDJOURNEY_CHROME_PROFILE=/profile
ENV MIDJOURNEY_HTTP_HOST=0.0.0.0
ENV MIDJOURNEY_HTTP_PORT=8787

# Mount the profile you signed in with:
#   docker run -v ~/.midjourney-mcp/chrome-profile:/profile -p 8787:8787 ...
VOLUME ["/profile"]
EXPOSE 8787

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http"]

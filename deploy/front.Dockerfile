# The public front: Caddy with the built phone pages. Build from build/vault/ after
# `npx vite build -c vite.public.config.ts` in web/:
#   docker buildx build --platform linux/amd64 -f deploy/front.Dockerfile -t <registry>/front:<tag> .
# Caddy 2.11.9, the official image, held to the digest it was built and tried with.
FROM caddy:2-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0
COPY deploy/front.Caddyfile /etc/caddy/Caddyfile
COPY web/dist-public /srv

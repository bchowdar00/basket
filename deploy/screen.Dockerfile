# The shared reader of the public page's first step, as one container. Build from build/vault/:
#   docker buildx build --platform linux/amd64 -f deploy/screen.Dockerfile -t <registry>/screen:<tag> .
# It needs nothing outside the three libraries, the engine's Gemini reader and the screen's own pool
# code, so nothing is installed. No key or token is in it: it sends public GETs only. It listens on
# 127.0.0.1, so it answers nothing until the web server in the same container group passes /feed/* to it.
FROM node:26.13.1-slim
WORKDIR /app
COPY packages/score/package.json packages/score/
COPY packages/score/src packages/score/src
COPY packages/rule/package.json packages/rule/
COPY packages/rule/src packages/rule/src
COPY packages/ledger/package.json packages/ledger/
COPY packages/ledger/src packages/ledger/src
RUN mkdir -p node_modules/@app && for p in score rule ledger; do ln -s ../../packages/$p node_modules/@app/$p; done
COPY services/engine/src/gemini.ts services/engine/src/gemini.ts
COPY web/feed/live.ts web/feed/live.ts
COPY web/src/pools.ts web/src/pools.ts
COPY web/src/screen/readall.ts web/src/screen/readall.ts
COPY services/screen/package.json services/screen/
COPY services/screen/src services/screen/src
USER node
ENV SCREEN_LIVE_DIR=/data/screen-live SCREEN_PORT=8790
CMD ["node", "services/screen/src/main.ts"]

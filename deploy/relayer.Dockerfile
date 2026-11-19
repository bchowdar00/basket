# The relayer as one container (T13's host part). Build from build/vault/ with the named context
# `mods`: a folder holding node_modules/ with viem and its runtime dependencies copied from this
# build's own node_modules (see the runbook, kept outside this repository), so nothing is fetched from a registry here:
#   docker buildx build --platform linux/amd64 -f deploy/relayer.Dockerfile --build-context mods=<folder> -t <registry>/relayer:<tag> .
# No key is in it: the relayer reads its key from the Key Vault with the container's identity when
# it starts. It listens on 127.0.0.1 only, so it answers nothing until a web server in the same
# container group passes requests to it.
FROM node:26.13.1-slim
WORKDIR /app
COPY --from=mods node_modules node_modules
COPY services/relayer/package.json services/relayer/
COPY services/relayer/src services/relayer/src
USER node
# None of these is a secret. The deployment record and the database are on the mounted share.
ENV VAULT_CHAIN_ID=5042002 VAULT_RPC=https://rpc.testnet.arc.io VAULT_USDC=0x3600000000000000000000000000000000000000 \
    VAULT_KEY_VAULT=https://vaultkeys277599.vault.azure.net VAULT_KEY_SECRET=relayer-key VAULT_IDENTITY_CLIENT_ID=3f41f816-a7d1-4c81-9cf3-d91de57e6986 \
    VAULT_ADDRESSES=/data/deploy/addresses.json VAULT_DB=/data/relayer/relayer.db VAULT_PORT=8788 \
    VAULT_HANDOUT_DEPOSIT=1000000 VAULT_HANDOUT_FEES=250000 VAULT_HANDOUTS_MOST=30
# The database's folder on the share is made if it is not there.
CMD ["sh", "-c", "mkdir -p \"$(dirname \"$VAULT_DB\")\" && exec node services/relayer/src/main.ts"]

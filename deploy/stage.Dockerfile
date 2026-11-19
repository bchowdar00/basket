# The one-off stage-round image. Build from build/vault/ with the named context `mods`: a folder
# holding node_modules/ with viem and its runtime dependencies copied from this build's own
# node_modules (see the runbook, kept outside this repository), so nothing is fetched from a registry here. The deployment record is
# read from the mounted share at /data/deploy/addresses.json; no key is in the image (the operator's
# key is read from the Key Vault with the container's identity when it starts).
FROM node:26.13.1-slim
WORKDIR /app
COPY --from=mods node_modules node_modules
COPY contracts/scripts/stage.ts contracts/scripts/stage.ts
COPY deploy/stage-start.mjs deploy/stage-start.mjs
RUN printf '{"type":"module"}\n' > package.json
USER node
ENV VAULT_CHAIN_ID=5042002 VAULT_RPC=https://rpc.testnet.arc.io VAULT_USDC=0x3600000000000000000000000000000000000000 VAULT_ADDRESSES=/data/deploy/addresses.json VAULT_KEYVAULT=https://vaultkeys277599.vault.azure.net VAULT_IDENTITY_CLIENT_ID=3f41f816-a7d1-4c81-9cf3-d91de57e6986 VAULT_STAGE_NAME=stage
CMD ["node","deploy/stage-start.mjs"]

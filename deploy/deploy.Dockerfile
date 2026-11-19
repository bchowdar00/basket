# The one-off deployment image. Build from build/vault/ with the named context `mods`: a folder
# holding node_modules/ with viem and its runtime dependencies copied from this build's own
# node_modules (see the runbook, kept outside this repository), so nothing is fetched from a registry here.
FROM node:26.13.1-slim
WORKDIR /app
COPY --from=mods node_modules node_modules
COPY contracts/scripts/deploy.ts contracts/scripts/deploy.ts
COPY deploy/bundle.json deploy/terms-vault.json deploy/terms-stage.json deploy/terms-stage2.json deploy/
COPY deploy/deploy-start.mjs deploy/deploy-start.mjs
RUN printf '{"type":"module"}\n' > package.json
USER node
ENV VAULT_CHAIN_ID=5042002 VAULT_RPC=https://rpc.testnet.arc.io VAULT_USDC=0x3600000000000000000000000000000000000000 VAULT_BUNDLE=/app/deploy/bundle.json VAULT_ADDRESSES=/data/deploy/addresses.json VAULT_KEYVAULT=https://vaultkeys277599.vault.azure.net
CMD ["node","deploy/deploy-start.mjs"]

# The forward run's engine as one container (plan 1.3, T18's host part). Build from build/vault/:
#   docker buildx build --platform linux/amd64 -f deploy/engine.Dockerfile -t <registry>/engine:<tag> .
# The engine has no dependency outside the three libraries, so nothing is installed: the libraries
# are copied in under packages/ (what the rule's hash reads) and linked from node_modules/ (what
# the imports resolve; node strips types only outside node_modules, so a link, not a copy). No key, token or order code is in it; the engine places nothing.
FROM node:26.13.1-slim
WORKDIR /app
COPY settings/rule.json settings/rule.json
COPY scripts/rule-hash.mjs scripts/rule-hash.mjs
COPY packages/score/package.json packages/score/
COPY packages/rule/package.json packages/rule/
COPY packages/rule/src packages/rule/src
COPY packages/ledger/package.json packages/ledger/
COPY packages/ledger/src packages/ledger/src
COPY packages/score/src packages/score/src
# viem and its runtime dependencies for the commits (T16), copied from this build's node_modules
# into a folder outside the repository and passed as the named context `mods` (see the runbook, kept outside this repository).
COPY --from=mods node_modules node_modules
RUN mkdir -p node_modules/@app && for p in score rule ledger; do ln -s ../../packages/$p node_modules/@app/$p; done
COPY services/engine/package.json services/engine/
COPY services/engine/src services/engine/src
COPY deploy/container-start.mjs deploy/
# The run's folder at the moment of the move, given as the build context `seed` (outside the
# repository: it holds Gemini's answers); `--build-context seed=deploy/seed-empty` for none.
COPY --from=seed . seed/
USER node
ENV VAULT_FORWARD_DIR=/data/forward
# The commits: the vault on Arc's test network, the operator's key in the Key Vault (none of these is a secret).
ENV VAULT_COMMIT_TO=0x41b72ae9a2e352cbfb77950715606f06f5e4d327 VAULT_RPC=https://rpc.testnet.arc.io VAULT_CHAIN_ID=5042002 VAULT_KEYVAULT=https://vaultkeys277599.vault.azure.net VAULT_IDENTITY_CLIENT_ID=3f41f816-a7d1-4c81-9cf3-d91de57e6986
CMD ["node", "deploy/container-start.mjs"]

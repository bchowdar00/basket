#!/bin/zsh
# Starts the forward run on this Mac, beside the recorder, kept awake by caffeinate (plan 1.3, T07).
# Run only on his word in his chat: it makes public, read-only requests to the exchange every five
# minutes. A pass that stops (a crash, a hash that no longer matches) is started again after a
# minute, and each start and stop is written to the run's own log.
set -u
here="${0:A:h}"
build="${here:h}"
out="$HOME/Data/hackathons/vault/forward"
mkdir -p "$out"
while true; do
  print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) start" >> "$out/engine.log"
  caffeinate -i node "$build/services/engine/src/main.ts" >> "$out/engine.log" 2>&1
  rc=$? # kept before anything else runs: the date below would reset it
  print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) stopped with $rc" >> "$out/engine.log"
  sleep 60
done
